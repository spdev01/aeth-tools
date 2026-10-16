// rova-client.mjs — headless ROVA game client: msgpack WS over a per-bot Tor circuit.
// Flow per rova/protocol/AUTH-HANDSHAKE.md: endpoints.json → ws ?dv= → HELLO{v:1} → WELCOME →
// PING every 8s + silence watchdog; seq-correlated request() with 10s timeouts. No direct path, ever.
import { WebSocket } from 'ws';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { encode, decode } from '@msgpack/msgpack';
import { OP, EV } from '../../protocol/opcodes.mjs';
import { ROVA_HOST, genDevice, rovaApi } from './rova-http.mjs';

export const ROVA_BUILD = process.env.ROVA_BUILD || '20261015-0744-ddc0df5';
export const ROVA_CAPS = ['coinbag', 'signskins', 'coffins'];

export class RovaClient {
  constructor({ port, user, pass, host = ROVA_HOST, log = () => {}, pingMs = 8000, silenceMs = 7000 }) {
    this.port = port; this.user = user; this.pass = pass; this.host = host;
    this.log = log; this.pingMs = pingMs; this.silenceMs = silenceMs;
    this.ws = null; this.reqSeq = 1; this.pending = new Map(); this.handlers = new Map();
    this.device = null; this.lastRx = 0; this.serverOffset = 0;
    this._pingTimer = null; this._watchTimer = null; this.onClose = null;
  }

  // ---- HTTP side (same circuit) ----
  async loadMeta() {
    if (this.meta) return this.meta;
    const r = await rovaApi.meta({ port: this.port, user: this.user, pass: this.pass, timeoutMs: 60000 });
    if (r.status !== 200 || !r.json) throw new Error(`meta failed (${r.status})`);
    this.meta = r.json;
    return this.meta;
  }
  async fetchDevice(device = null) {
    await this.loadMeta();
    if (device) this.device = device;
    if (!this.device) this.device = genDevice();
    return this.device;
  }

  // ---- WS side ----
  wsUrls() {
    const metaWs = Array.isArray(this.meta?.ws) ? this.meta.ws.filter((u) => typeof u === 'string') : [];
    const docWs = Array.isArray(this.endpointsDoc?.ws) ? this.endpointsDoc.ws.filter((u) => typeof u === 'string') : [];
    const list = metaWs.length ? metaWs : docWs;
    const urls = list.length ? list : [`wss://${this.host}/ws`];
    return urls.map((u) => {
      try {
        const url = new URL(u, `https://${this.host}/`);
        url.searchParams.set('dv', this.device);
        return url.toString().replace(/^http/, 'ws');
      } catch { return u; }
    });
  }

  // helloParams mirror the client's hello() + v:1 (content/entry come from /api/meta)
  hello({ token, charId = 0, locale = 'en', resume = false, platform = 'web', plat = 'web', owner = '' }) {
    return {
      token, char: charId, locale, platform,
      content: this.meta?.content ?? '', build: ROVA_BUILD,
      entry: this.meta?.entry ?? '', plat, capsv: 1, caps: ROVA_CAPS, resume, owner, v: 1,
    };
  }

  async connect({ token, charId = 0, locale = 'en', resume = false, owner = '', device = null }) {
    await this.loadMeta();
    if (device) this.device = device;
    if (!this.device) this.device = genDevice();
    const urls = this.wsUrls();
    let lastErr = null;
    for (const url of urls) {
      try {
        this.log('ws_connecting', { url: url.replace(/dv=[^&]+/, 'dv=***'), via: 'tor' });
        const agent = new SocksProxyAgent(`socks5h://${encodeURIComponent(this.user)}:${encodeURIComponent(this.pass)}@127.0.0.1:${this.port}`);
        const ws = new WebSocket(url, { agent, perMessageDeflate: false, handshakeTimeout: 45000 });
        this.ws = ws;
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('ws timeout')), 50000);
          ws.once('open', () => { clearTimeout(t); resolve(); });
          ws.once('error', (e) => { clearTimeout(t); reject(e); });
          ws.once('unexpected-response', (_req, res) => { clearTimeout(t); reject(new Error(`ws http ${res.statusCode}`)); });
        });
        this.log('ws_open', {});
        ws.on('message', (data) => this._receive(data));
        ws.on('close', (code, reason) => this._closed(`close ${code} ${reason || ''}`.trim()));
        ws.on('error', (e) => this.log('ws_error', { error: String(e?.message || e) }));
        // HELLO + await WELCOME (fail fast on ERROR/KICK gates: update_required, guest_must_register, …)
        const welcome = new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('welcome timeout')), 25000);
          const off = this.on(EV.WELCOME, (d) => { clearTimeout(t); offErr(); offKick(); resolve(d); });
          const offErr = this.on(EV.ERROR, (d) => { clearTimeout(t); off(); offKick(); reject(Object.assign(new Error(d?.err || 'error'), { code: d?.err })); });
          const offKick = this.on(EV.KICK, (d) => { clearTimeout(t); off(); offErr(); reject(Object.assign(new Error(d?.reason || 'kick'), { code: d?.reason })); });
        });
        this.sendRaw(OP.HELLO, 0, this.hello({ token, charId, locale, resume, owner }));
        const w = await welcome;
        this.serverOffset = Number(w?.t || 0) - Date.now();
        this.log('welcome', { serverOffset: this.serverOffset });
        this._startTimers();
        return { ok: true, url };
      } catch (e) {
        lastErr = e;
        this.log('ws_connect_fail', { error: String(e?.message || e) });
        try { this.ws?.terminate(); } catch {}
        this.ws = null;
        this._stopTimers();
      }
    }
    return { ok: false, error: String(lastErr?.message || lastErr || 'no endpoint') };
  }

  _startTimers() {
    this._stopTimers();
    this.lastRx = Date.now();
    this._pingTimer = setInterval(() => this._safe(() => this.sendRaw(OP.PING, 0, { t: 0 })), this.pingMs);
    this._watchTimer = setInterval(() => {
      if (!this.open) return;
      if (Date.now() - this.lastRx > this.silenceMs + 4000) this._closed('silent');
    }, 1500);
    try { this._pingTimer.unref?.(); this._watchTimer.unref?.(); } catch {}
  }
  _stopTimers() { try { clearInterval(this._pingTimer); clearInterval(this._watchTimer); } catch {} this._pingTimer = this._watchTimer = null; }
  _safe(fn) { try { fn(); } catch {} }

  _closed(reason) {
    if (!this.ws) return;
    try { this.ws.terminate(); } catch {}
    this.ws = null;
    this._stopTimers();
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('disconnected')); }
    this.pending.clear();
    this.log('ws_closed', { reason });
    this.onClose?.(reason);
  }

  _receive(data) {
    this.lastRx = Date.now();
    let frame;
    try { frame = decode(new Uint8Array(data)); } catch { return; }
    if (!Array.isArray(frame)) return;
    const [op, seq, data2] = frame;
    if (seq && this.pending.has(seq)) {
      const p = this.pending.get(seq);
      this.pending.delete(seq); clearTimeout(p.timer);
      if (op === EV.RESULT) {
        if (data2 && data2.ok === false) p.reject(Object.assign(new Error(data2.err || 'error'), { code: data2.err, params: data2.p }));
        else p.resolve(data2?.d ?? data2);
      } else p.resolve(data2);
    }
    const set = this.handlers.get(op);
    if (set) for (const fn of set) this._safe(() => fn(data2, seq));
  }

  get open() { return this.ws && this.ws.readyState === WebSocket.OPEN; }
  sendRaw(op, seq, data) {
    if (!this.open) throw new Error('not connected');
    this.ws.send(encode([op, seq, data ?? null], { ignoreUndefined: true }));
  }
  send(op, data = {}) { this.sendRaw(op, 0, data); }
  request(op, data = {}, timeoutMs = 10000) {
    if (!this.open) return Promise.reject(new Error('disconnected'));
    const seq = this.reqSeq++;
    if (this.reqSeq > 0x7fffffff) this.reqSeq = 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(seq); reject(Object.assign(new Error('timeout'), { code: 'timeout' })); }, timeoutMs);
      this.pending.set(seq, { resolve, reject, timer });
      this.sendRaw(op, seq, data);
    });
  }
  on(evt, fn) {
    if (typeof evt === 'string') { const k = EV[evt] ?? evt; evt = k; }
    let set = this.handlers.get(evt);
    if (!set) { set = new Set(); this.handlers.set(evt, set); }
    set.add(fn);
    return () => set.delete(fn);
  }
  close(reason = 'client_close') { this._closed(reason); }
}

// opcode name helper for logs
export function opName(op) {
  for (const [k, v] of Object.entries(EV)) if (v === op) return k;
  for (const [k, v] of Object.entries(OP)) if (v === op) return k;
  return 'OP_' + op;
}
