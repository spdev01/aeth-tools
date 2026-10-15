// Per-bot earnings tracker (2026-10-10) — reads each bot's run-*.jsonl INCREMENTALLY (own byte offset per
// bot, persisted in data/earnings.json) and accumulates per-LOCAL-hour buckets:
//   v  = estimated zeny value of loot DROPS (qty × NPC sellPrice; excludes cards, kept/buff items,
//        potions, scrolls, vendor-refused items) — validated vs actual sales within ~3% (tools/deed-verify.mjs)
//   e / s / zd = realized zeny steps (earned up / spent-or-moved-out / net) from CHARACTER + HEARTBEAT events
//   q / k / c / x = drop qty, kills, card qty, excluded-but-valuable (kept items, potions, ...)
//   r  = confirmed sale totals (runners from 2026-10-10 log {total} on auto_sold / sold_except_keep)
// Read-only: never touches game state or bot files (except reading). Powers the dashboard "≈z/h" column
// and the per-bot earnings graph in the drawer.
import fs from 'node:fs';
import path from 'node:path';
import { getWiki } from './wiki.js';

const KEEP_HOURS = 72;                 // hourly buckets retained
const SWEEP_MS = 45_000;               // scan cadence
const SAVE_MS = 60_000;                // max disk-write cadence
const BACKFILL_MS = 26 * 3600 * 1000;  // first-ever scan: process files touched within this window
const MAX_READ = 8 * 1024 * 1024;      // per-bot per-sweep read cap (big backfills continue next sweep)
const KEEP_TTL_MS = 5 * 60_000;
const WING_ID = 90311;
const CARD_RE = /(?:\bcard\b|การ์ด)/i;
const SCROLL_RE = /weight\s*limit|น้ำหนัก/i;
const POTION_RE = /potion|ยา/i;
const WING_RE = /butterfly\s*wing/i;

export const hourKeyOf = (t) => {
  const d = new Date(t);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
};

export class EarningsTracker {
  constructor({ botsDir, dataFile }) {
    this.botsDir = botsDir;
    this.dataFile = dataFile;
    this.data = { v: 1, savedAt: 0, bots: {} };
    try { const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8')); if (raw && raw.bots) this.data = raw; } catch {}
    this._dirty = false;
    this._lastSave = 0;
    this._sweeping = false;
    this._price = new Map(); // name -> { p, id }
    this._wikiRef = null;
    this._keep = new Map(); // botId -> { at, set:Set<number> }
  }

  // ---- price table: max sellPrice across both DB arrays (verified policy — see tools/deed-verify.mjs) ----
  _prices() {
    const w = getWiki();
    if (!w || w === this._wikiRef) return this._price;
    this._wikiRef = w;
    const map = new Map();
    for (const arr of [w.items, w.ragnarokItems]) {
      for (const it of (arr ?? [])) {
        if (!it || !it.name) continue;
        const p = Number(it.sellPrice ?? 0) || 0;
        const old = map.get(it.name);
        if (!old || p > old.p) map.set(it.name, { p, id: it.id ?? null });
      }
    }
    this._price = map;
    return map;
  }

  _keepOf(botId) {
    const hit = this._keep.get(botId);
    const now = Date.now();
    if (hit && now - hit.at < KEEP_TTL_MS) return hit.set;
    const set = new Set();
    try {
      const ctl = JSON.parse(fs.readFileSync(path.join(this.botsDir, String(botId), 'control.json'), 'utf8'));
      for (const src of [ctl.keep, ctl.farm?.keep, ctl.auto?.buffItems]) {
        for (const x of (src ?? [])) { const n = Number(x); if (Number.isFinite(n)) set.add(n); }
      }
    } catch {}
    this._keep.set(botId, { at: now, set });
    return set;
  }

  _bot(botId) {
    return this.data.bots[botId] ?? (this.data.bots[botId] = { file: '', off: 0, carry: '', lastTs: '', lastZeny: null, hours: {} });
  }

  _blank() { return { v: 0, q: 0, k: 0, c: 0, x: 0, e: 0, s: 0, zd: 0, r: 0, top: {} }; }
  _hour(st, ts) { const h = hourKeyOf(ts); return st.hours[h] ?? (st.hours[h] = this._blank()); }

  // ---- main cadence ----
  async sweep() {
    if (this._sweeping) return;
    if (!getWiki()) return; // wait for the price table; retried next sweep
    this._sweeping = true;
    try {
      this._prices();
      let ids = [];
      try { ids = fs.readdirSync(this.botsDir).filter((n) => /^\d+$/.test(n)); } catch { return; }
      for (const id of ids) {
        try { this._catchUp(id); } catch {}
        await new Promise((r) => setImmediate(r)); // keep the HTTP server responsive during big backfills
      }
      const cut = hourKeyOf(new Date(Date.now() - KEEP_HOURS * 3600e3));
      for (const st of Object.values(this.data.bots)) {
        for (const h of Object.keys(st.hours)) if (h < cut) { delete st.hours[h]; this._dirty = true; }
      }
      if (this._dirty && Date.now() - this._lastSave > SAVE_MS) this.save();
    } finally {
      this._sweeping = false;
    }
  }

  save() {
    try {
      this.data.savedAt = Date.now();
      const tmp = this.dataFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.dataFile);
      this._dirty = false;
      this._lastSave = Date.now();
    } catch {}
  }

  _recentStart(dir, files) {
    const cut = Date.now() - BACKFILL_MS;
    for (let i = 0; i < files.length; i++) {
      try { if (fs.statSync(path.join(dir, files[i])).mtimeMs >= cut) return i; } catch {}
    }
    return files.length - 1; // at least the newest file
  }

  _catchUp(botId) {
    const dir = path.join(this.botsDir, String(botId));
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.startsWith('run-') && f.endsWith('.jsonl')).sort(); } catch { return; }
    if (!files.length) return;
    const st = this._bot(botId);
    let begin = 0, beginOff = 0;
    if (st.file) {
      const k = files.indexOf(st.file);
      if (k >= 0) { begin = k; beginOff = st.off; }
      else { begin = this._recentStart(dir, files); beginOff = 0; st.carry = ''; }
    } else {
      begin = this._recentStart(dir, files);
    }
    for (let i = begin; i < files.length; i++) {
      const name = files[i];
      const p = path.join(dir, name);
      let size = 0;
      try { size = fs.statSync(p).size; } catch { continue; }
      let off = i === begin ? beginOff : 0;
      let carried = i === begin ? st.carry : '';
      if (size < off) { off = 0; carried = ''; st.carry = ''; } // truncated/rotated under the same name
      if (size <= off) { st.file = name; st.off = off; continue; }
      const take = Math.min(size - off, MAX_READ);
      const buf = Buffer.alloc(take);
      const fd = fs.openSync(p, 'r');
      try { fs.readSync(fd, buf, 0, take, off); } finally { try { fs.closeSync(fd); } catch {} }
      const text = carried + buf.toString('utf8');
      const lines = text.split('\n');
      const carry = lines.pop() ?? '';
      for (const line of lines) this._ingestLine(botId, st, line);
      st.file = name;
      st.off = off + take;
      st.carry = carry;
      this._dirty = true;
      if (st.off < size) return; // read cap hit — continue from here next sweep
    }
  }

  _ingestLine(botId, st, line) {
    if (line.length < 40 || !line.includes('"evt":"')) return;
    const parts = line.includes('}{') ? line.split('}{') : [line];
    for (const p of parts) {
      const mt = p.match(/"t":"([^"]+)"/);
      if (!mt) continue;
      const ts = mt[1];
      if (st.lastTs && ts <= st.lastTs) continue; // monotonic fence — never double-process
      const me = p.match(/"evt":"([^"]+)"/);
      if (!me) continue;
      st.lastTs = ts;
      const evt = me[1];
      if (evt === 'drop') { this._drop(botId, st, ts, p); continue; }
      if (evt === 'kill') { this._hour(st, ts).k += 1; continue; }
      if (evt === 'character') { st.loginAt = ts; continue; } // fresh login marker (lowercase = roster replay)
      if (evt === 'HEARTBEAT' || evt === 'CHARACTER') {
        const mz = p.match(/"zeny":(\d+)/);
        if (mz) this._zeny(st, ts, Number(mz[1]));
        continue;
      }
      if (evt === 'auto_sold' || evt === 'sold_except_keep') {
        const m2 = p.match(/"total":(\d+)/);
        if (m2) this._hour(st, ts).r += Number(m2[1]);
        continue;
      }
    }
  }

  _drop(botId, st, ts, p) {
    const mn = p.match(/"name":"((?:[^"\\]|\\.)*)"/);
    if (!mn) return;
    let name;
    try { name = JSON.parse(`"${mn[1]}"`); } catch { return; }
    const mq = p.match(/"qty":(\d+)/);
    const qty = mq ? Number(mq[1]) : 1;
    const o = this._hour(st, ts);
    o.q += qty;
    const pr = this._prices().get(name);
    if (!pr || !(pr.p > 0)) return; // vendor-refused / unknown item — no NPC value
    if (CARD_RE.test(name)) { o.c += qty; return; }
    if (SCROLL_RE.test(name) || POTION_RE.test(name) || WING_RE.test(name) || (pr.id != null && (pr.id === WING_ID || this._keepOf(botId).has(pr.id)))) {
      o.x += pr.p * qty;
      return;
    }
    o.v += pr.p * qty;
    if (o.top[name] == null && Object.keys(o.top).length >= 14) return;
    o.top[name] = (o.top[name] ?? 0) + qty;
  }

  _zeny(st, ts, z) {
    // skip 0-boundaries and the ~90s replay window right after a fresh login: the client re-sends the
    // balance in steps there (0 → partial → full), which would otherwise count as a fake multi-million sale
    if (st.lastZeny != null && z !== st.lastZeny && st.lastZeny !== 0 && z !== 0) {
      const replay = st.loginAt && Date.parse(ts) >= Date.parse(st.loginAt) && Date.parse(ts) - Date.parse(st.loginAt) < 90_000;
      if (!replay) {
        const d = z - st.lastZeny;
        const o = this._hour(st, ts);
        if (d > 0) o.e += d; else o.s += -d;
        o.zd += d;
      }
    }
    st.lastZeny = z;
  }

  // ---- views ----
  _lastHourKeys(n) {
    const out = [];
    const base = new Date();
    base.setMinutes(0, 0, 0);
    for (let i = 1; i <= n; i++) out.push(hourKeyOf(new Date(base.getTime() - i * 3600e3)));
    return out;
  }

  summaryFor(botId) {
    const st = this.data.bots[botId];
    if (!st) return null;
    const k3 = this._lastHourKeys(3);
    const v3 = k3.map((k) => st.hours[k]).filter(Boolean);
    const rate3 = v3.length ? Math.round(v3.reduce((a, o) => a + o.v, 0) / v3.length) : null;
    let sum24 = 0, n24 = 0;
    for (const k of this._lastHourKeys(24)) { const o = st.hours[k]; if (o) { sum24 += o.v; n24++; } }
    const rate24 = n24 ? Math.round(sum24 / n24) : null;
    if (rate3 == null && rate24 == null) return null;
    const all = Object.keys(st.hours).sort();
    let lastH = null;
    for (let i = all.length - 1; i >= 0; i--) { if (all[i] < hourKeyOf(new Date())) { lastH = all[i]; break; } }
    let ageMin = null;
    if (lastH) ageMin = Math.round((Date.now() - (new Date(lastH + ':00:00').getTime() + 3600e3)) / 60000);
    return { rate3, rate24, n24, lastH, ageMin };
  }

  detailFor(botId, { hours = 24 } = {}) {
    const st = this.data.bots[botId];
    const keys = this._lastHourKeys(Math.max(4, Math.min(KEEP_HOURS, hours))).reverse(); // oldest -> newest
    const price = this._prices();
    const arr = keys.map((k) => {
      const o = st?.hours?.[k] ?? null;
      const top = o ? Object.entries(o.top).map(([n, q]) => { const pr = price.get(n); return { n, q, p: pr?.p ?? 0, v: (pr?.p ?? 0) * q }; }).sort((a, b) => b.v - a.v).slice(0, 6) : [];
      return { h: k, v: o?.v ?? 0, e: o?.e ?? 0, s: o?.s ?? 0, zd: o?.zd ?? 0, k: o?.k ?? 0, q: o?.q ?? 0, c: o?.c ?? 0, x: o?.x ?? 0, r: o?.r ?? 0, top };
    });
    const totals = arr.reduce((a, x) => ({ v: a.v + x.v, e: a.e + x.e, s: a.s + x.s, k: a.k + x.k, q: a.q + x.q, c: a.c + x.c, x: a.x + x.x, r: a.r + x.r }), { v: 0, e: 0, s: 0, k: 0, q: 0, c: 0, x: 0, r: 0 });
    const summ = this.summaryFor(botId) ?? {};
    return { botId: Number(botId), hours: arr, totals, rate3: summ.rate3 ?? null, rate24: summ.rate24 ?? null, savedAt: this.data.savedAt };
  }
}
