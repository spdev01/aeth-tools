// Raw Aetheria client — ws + msgpack, no SDK. Protocol (all verified live):
//  - REST: /auth/guest | /characters | /world/enter (Bearer token)
//  - POST /matchmake/joinById/<roomId> {ticket} -> flat reservation {name,sessionId,roomId,processId}
//  - ws url: wss://<endpoint-host>/<processId>/<roomId>?sessionId=<sessionId>
//  - frames: 0x0a join(2 strings + reflection) [ack 0x0a], 0x0b error, 0x0c leave,
//            0x0d msgpack(type)+msgpack(data), 0x0e full state, 0x0f patch
//  - send: [0x0d][msgpack(type)][msgpack(data)]
import WebSocket from 'ws';
import fs from 'node:fs';
import { encode, decodeMulti } from '@msgpack/msgpack';
import { Reflection } from '@colyseus/schema';
import { apiFetch, wsOptions } from './net.js';

export const BASE_DEFAULT = 'https://www.aetheria-online.in.th';

export class AetheriaClient {
  constructor(opts = {}) {
    this.base = opts.base || BASE_DEFAULT;
    this.token = opts.token;
    this.deviceId = opts.deviceId || null; // device identity (new client 2026-10-12): persistent UUID sent to /world/enter
    this.ws = null;
    this.handlers = { message: [], state: [], join: [], close: [], error: [] };
    this.joinInfo = null;
    this.reflection = null;
    this.enter = null;
    this.reservation = null;
    this.msgs = new Map(); // last message per type (await-style flows: channels, trade, storage, invite)
    this.lastError = null;
  }
  on(evt, fn) {
    (this.handlers[evt] ||= []).push(fn);
    return () => { const a = this.handlers[evt]; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); };
  }
  emit(evt, ...args) { for (const fn of [...(this.handlers[evt] || [])]) fn(...args); }

  // ---------- REST ---------- (rides this bot's Tor circuit; header shape = captured Chrome)
  async api(pathname, { method = 'GET', body } = {}) {
    const res = await apiFetch(this.base + pathname, { method, body, token: this.token });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text: json ? null : text };
  }
  async listCharacters() { return (await this.api('/characters')).json; }
  async createCharacter(name) { return (await this.api('/characters', { method: 'POST', body: { name } })).json; }
  async worldEnter(characterId) {
    // NEW CLIENT (2026-10-12): /world/enter carries a persistent device UUID (localStorage 'aetheria.device'
    // in the real client). After the anti-bot update, missing deviceId = instant "not a real browser" tell.
    const body = { characterId };
    if (this.deviceId) body.deviceId = this.deviceId;
    return (await this.api('/world/enter', { method: 'POST', body })).json;
  }

  async getReservation(characterId, opts = {}) {
    const { onQueue = null, abort = null } = opts;
    let enter = await this.worldEnter(characterId);
    // SERVER QUEUE PROTOCOL (2026-10-10, world/enter): at capacity the world replies
    //   { queued:true, position, waiting, etaSeconds, pollMs }
    // and the contract is to RE-POLL world/enter every pollMs until admitted — NOT to treat it as a
    // failed connect attempt. The old ladder burned all 12 attempts in ~70s, failed the step, relogged
    // and re-queued (churn), and the leftover duplicate queue tickets got the fresh session kicked
    // (ws_close 1006 seconds after joining) — patient polling is both correct and calmer.
    if (enter && enter.queued) {
      const ping = () => { try { onQueue?.(enter); } catch {} };
      ping();
      let lastAt = Date.now();
      const deadline = Date.now() + 45 * 60 * 1000; // sanity cap — a longer queue means something else is wrong
      for (;;) {
        if (abort && abort()) throw new Error('stop requested during login queue');
        if (Date.now() > deadline) throw new Error('login queue wait exceeded 45 minutes: ' + JSON.stringify(enter));
        const pm = Math.min(10000, Math.max(1000, Number(enter.pollMs) || 2000));
        await new Promise((r) => setTimeout(r, pm));
        enter = await this.worldEnter(characterId);
        if (!enter || !enter.queued) break;
        if (Date.now() - lastAt > 20000) {
          lastAt = Date.now();
          ping();
        }
      }
    }
    if (!enter || !enter.roomId) throw new Error('world/enter failed: ' + JSON.stringify(enter));
    const mmRes = await apiFetch(enter.endpoint + '/matchmake/joinById/' + enter.roomId, {
      method: 'POST', body: { ticket: enter.ticket },
    });
    const reservation = await mmRes.json();
    if (!reservation || !reservation.sessionId) throw new Error('matchmake failed: ' + JSON.stringify(reservation));
    const host = enter.endpoint.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
    return { enter, reservation, wsUrl: `${host}/${reservation.processId}/${reservation.roomId}?sessionId=${reservation.sessionId}` };
  }

  // ---------- Connect ----------
  async connect(characterId, opts = {}) {
    const { enter, reservation, wsUrl } = await this.getReservation(characterId, opts);
    this.enter = enter; this.reservation = reservation; this.wsUrl = wsUrl;
    this.mapId = enter.mapId;
    await this.connectSocket(wsUrl);
    await this.waitJoin();
    return this;
  }

  // Rejoin a room directly (used after 'travel' messages: {roomId, ticket, endpoint})
  async rejoinRoom(travel) {
    const { roomId, ticket, mapId, endpoint: newEndpoint } = travel;
    this.busyAt = Date.now(); // marks an intentional travel/rejoin in flight (guards the runner's fast auto-reconnect)
    if (!roomId || !ticket) throw new Error('travel msg missing roomId/ticket: ' + JSON.stringify(travel));
    // 1) consented leave of current room (exactly like the game client)
    try { this.ws && this.ws.send(Buffer.from([0x0c])); } catch {}
    await new Promise((r) => setTimeout(r, 900));
    this.hardClose(); // CRASH-PROOF teardown: close() on a CONNECTING socket emits 'error' on nextTick —
    // outside any try/catch — so the socket must always keep an error listener before being closed
    // (this raced Tor's slower connects after deathRespawn and killed runners with exit code 3)
    // 2) matchmake the new room
    const endpoint = newEndpoint || this.enter.endpoint;
    const mmRes = await apiFetch(endpoint + '/matchmake/joinById/' + roomId, {
      method: 'POST', body: { ticket, batch: true },
    });
    const reservation = await mmRes.json();
    if (!reservation || !reservation.sessionId) throw new Error('rejoin matchmake failed: ' + JSON.stringify(reservation));
    this.reservation = reservation;
    if (mapId) this.mapId = mapId;
    this.enter.endpoint = endpoint;
    const host = endpoint.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
    this.wsUrl = `${host}/${reservation.processId}/${reservation.roomId}?sessionId=${reservation.sessionId}`;
    await this.connectSocket(this.wsUrl);
    const joined = await this.waitJoin();
    if (!joined) throw new Error('rejoin connect did not join: ' + this.wsUrl);
    this.arrived();
    this.busyAt = 0;
    return this;
  }

  async connectSocket(wsUrl) {
    this.hasJoined = false;
    this.worldDecoder = null;
    this.world = null;
    this.worldAt = 0;
    const ws = new WebSocket(wsUrl, wsOptions()); // Tor circuit + Chrome handshake headers + permessage-deflate
    this.ws = ws;
    await new Promise((resolve, reject) => {
      ws.once('open', resolve); ws.once('error', reject);
    });
    ws.on('message', (data) => this._onFrame(Buffer.from(data)));
    ws.on('close', (code, reason) => this.emit('close', code, String(reason)));
    ws.on('error', (e) => this.emit('error', { kind: 'ws', err: String(e && e.message || e) }));
  }

  waitJoin(timeoutMs = 8000) {
    return new Promise((resolve) => {
      if (this.hasJoined) return resolve(true);
      const t = setTimeout(() => { off(); resolve(false); }, timeoutMs);
      const off = this.on('join', () => { clearTimeout(t); off(); resolve(true); });
    });
  }

  _onFrame(buf) {
    if (process.env.TB_CAPTURE_FRAMES) {
      try { fs.appendFileSync(process.env.TB_CAPTURE_FRAMES, JSON.stringify({ at: Date.now(), b: buf.toString('base64') }) + '\n'); } catch {}
    }
    try { this._onFrameInner(buf); }
    catch (e) { this.emit('error', { kind: 'frame', err: String((e && e.stack) || e), head: buf.subarray(0, 24).toString('hex') }); }
  }

  _onFrameInner(buf) {
    const code = buf[0];
    if (code === 0x0a) {
      let off = 1;
      const readStr = () => { const len = buf[off++]; const s = buf.subarray(off, off + len).toString('utf8'); off += len; return s; };
      try {
        this.joinInfo = { reconnectionToken: readStr(), serializerId: readStr() };
        this.reflection = buf.subarray(off);
        // init real room-state decoder (schema reflection → live players/monsters with hp/dead)
        try {
          let rb = this.reflection;
          if (rb.length > 3) {
            const m = rb[0];
            if (m === 0xcc) rb = rb.subarray(2);
            else if (m === 0xcd) rb = rb.subarray(3);
            else if (m === 0xce) rb = rb.subarray(5);
          }
          this.worldDecoder = Reflection.decode(rb);
          this.world = this.worldDecoder.state;
          this.worldAt = 0;
        } catch (e) { this.worldDecoder = null; this.world = null; this.emit('error', { kind: 'reflection', err: String((e && e.message) || e) }); }
        try { this.ws.send(Buffer.from([0x0a])); } catch {}
        this.hasJoined = true;
        this.emit('join', this.joinInfo);
      } catch (e) { this.emit('error', { kind: 'joinparse', err: String(e) }); }
    } else if (code === 0x0b) {
      this.lastError = buf.toString('hex');
      this.emit('error', { kind: 'server_error', raw: this.lastError });
    } else if (code === 0x0c) {
      this.emit('close', 0, 'server-sent leave');
    } else if (code === 0x0d) {
      try {
        const parts = [...decodeMulti(buf.subarray(1))];
        const mtype = String(parts[0]);
        this.msgs.set(mtype, { data: parts.length > 1 ? parts[1] : undefined, at: Date.now() });
        if (this.msgs.size > 120) this.msgs.delete(this.msgs.keys().next().value);
        this.emit('message', parts[0], parts.length > 1 ? parts[1] : undefined);
      } catch (e) {
        this.emit('error', { kind: 'msgpack', head: buf.subarray(0, 40).toString('hex'), err: String(e) });
      }
    } else if (code === 0x0e || code === 0x0f) {
      if (this.worldDecoder) {
        try { const changes = this.worldDecoder.decode(buf.subarray(1)); this.worldAt = Date.now(); this.emit('world', changes); }
        catch (e) { this.emit('error', { kind: 'world-decode', head: buf.subarray(0, 16).toString('hex'), err: String((e && e.message) || e) }); }
      }
      this.emit('state', '0x' + code.toString(16), buf);
    } else {
      this.emit('state', '0x' + code.toString(16), buf);
    }
  }

  // Real-time view of our own player straight from the room state (null until joined/decoded).
  get live() {
    const w = this.world;
    if (!w || !this.reservation) return null;
    let p = null;
    try { p = w.players && w.players.get ? w.players.get(this.reservation.sessionId) : null; } catch {}
    if (!p) return null;
    return { hp: p.hp, maxHp: p.maxHp, sp: p.sp, maxSp: p.maxSp, dead: !!p.dead, x: p.x, y: p.y, mapId: w.mapId, channel: w.channel, at: this.worldAt || 0 };
  }

  send(type, data) {
    const t = encode(type);
    const out = data === undefined
      ? new Uint8Array(1 + t.length)
      : new Uint8Array(1 + t.length + encode(data).length);
    out[0] = 0x0d;
    out.set(t, 1);
    if (data !== undefined) out.set(encode(data), 1 + t.length);
    try { this.ws.send(Buffer.from(out)); }
    catch (e) { this.emit('error', { kind: 'send', type, err: String((e && e.message) || e) }); }
  }

  hardClose() {
    try {
      const ws = this.ws;
      if (!ws) return;
      ws.removeAllListeners();
      ws.on('error', () => {}); // close/terminate on CONNECTING → abortHandshake → nextTick emit('error') — swallow it
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      else ws.close();
    } catch {}
  }

  close() { this.hardClose(); }

  // Send leave-room frame (0x0c) then wait — frees our seat so the next joinById succeeds immediately.
  async leaveGraceful(ms = 700) {
    try { if (this.ws && this.ws.readyState === 1) this.ws.send(Buffer.from([0x0c])); } catch {}
    await new Promise((r) => setTimeout(r, ms));
  }

  // ---------- Verified command helpers ----------
  moveTo(tileX, tileY) { const x = (tileX + 0.5) * 32, y = (tileY + 0.5) * 32; this.lastMove = { x, y, t: Date.now() }; this.send('move_to', { x, y }); }
  moveToPx(x, y) { this.lastMove = { x, y, t: Date.now() }; this.send('move_to', { x, y }); }
  arrived() { this.send('arrived'); }
  move(dx, dy) { this.send('move', { dx, dy }); }
  npcTalk(npcKey) { this.send('npc_talk', { npcKey }); }
  npcOption(index) { this.send('npc_option', { index }); }
  npcClose() { this.send('npc_close', {}); }
  invSort() { this.send('inv_sort', {}); }
  statUp(stat, n = 1) { this.send('stat_up', { stat, n }); }
  skillUp(skillId) { this.send('skill_up', { skillId }); }
  autoEnabled(enabled) { this.send('auto_set', { enabled }); }
  autoConfig(config) { this.send('auto_set', { config }); }
  cast(skillId, targetId) { this.send('cast', { skillId, targetId }); }
  invUse(slot) { this.send('inv_use', { slot }); }
  petSet(petId) { this.send('pet_set', { petId }); }
  warp(mapId) { this.send('npc_warp', { mapId }); }
  shopSell(slot, qty) { this.send('shop_sell', { slot, qty }); }
  shopSellMany(lines) { this.send('shop_sell_many', { lines }); }
  storagePut(slot, qty) { this.send('storage_put', { slot, qty }); }
  storageTake(slot, qty) { this.send('storage_take', { slot, qty }); }
  storageSort() { this.send('storage_sort', {}); }
  storageZeny(action, amount) { this.send('storage_zeny', { action, amount }); }
  channelSwitch(channel) { this.send('channel_switch', { channel }); }
  channelList() { this.send('channel_list'); }
  trade(payload) { this.send('trade', payload); }
  tradeRequest(name) { this.send('trade', { action: 'request', name }); }
  tradeOffer(items, zeny) { this.send('trade', { action: 'offer', items, zeny }); }
  tradeLock() { this.send('trade', { action: 'lock' }); }
  tradeConfirm() { this.send('trade', { action: 'confirm' }); }
  tradeCancel() { this.send('trade', { action: 'cancel' }); }
}
