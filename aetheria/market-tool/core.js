// Aetheria Market+ — shared core (works as Chrome/Edge/Zen extension content script
// in MAIN world @ document_start, and as a userscript body — see build.mjs).
//
// Hooks window.WebSocket before the game client creates its socket, then speaks the
// game's own room protocol on the user's authenticated connection:
//   market {op:'search', filters:{q,category,kind,job,rarity,minRefine,minLevel,
//           maxLevel,minPrice,maxPrice,sort,page}}  -> market_results (+market_done)
//   market {op:'buy', listingId, price}               -> market_done {ok}
//   market {op:'collect_all'}                         -> market_done {ok}
// One market op at a time (server serializes); scans are strictly chained.

(function () {
  'use strict';
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  if (W.__amkt) return; W.__amkt = true;

  const VERSION = '0.2.2';
  const LOG = function () { try { if (W.__amktDebug) console.log('[Market+]', ...arguments); } catch (e) { /* noop */ } };
  LOG('core loaded', VERSION);

  // ---------------------------------------------------------------- msgpack
  const TE = new TextEncoder(), TD = new TextDecoder();
  function encU8(v) { // standard msgpack
    const out = [];
    (function w(v) {
      if (v === null || v === undefined) { out.push(0xc0); return; }
      if (v === true) { out.push(0xc3); return; }
      if (v === false) { out.push(0xc2); return; }
      if (typeof v === 'number') {
        if (Number.isInteger(v)) {
          if (v >= 0 && v < 128) out.push(v);
          else if (v < 0 && v >= -32) out.push(0x100 + v);
          else if (v >= 0 && v <= 255) out.push(0xcc, v);
          else if (v >= 0 && v <= 65535) out.push(0xcd, v >> 8, v & 255);
          else if (v >= 0 && v <= 4294967295) out.push(0xce, (v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
          else if (v >= -128) out.push(0xd0, v & 255);
          else if (v >= -32768) out.push(0xd1, (v >> 8) & 255, v & 255);
          else out.push(0xd2, (v >> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255);
        } else {
          const b = new ArrayBuffer(9), dv = new DataView(b);
          dv.setUint8(0, 0xcb); dv.setFloat64(1, v);
          out.push(...new Uint8Array(b));
        }
        return;
      }
      if (typeof v === 'string') {
        const b = TE.encode(v);
        if (b.length < 32) out.push(0xa0 | b.length);
        else if (b.length < 256) out.push(0xd9, b.length);
        else if (b.length < 65536) out.push(0xda, b.length >> 8, b.length & 255);
        else out.push(0xdb, (b.length >>> 24) & 255, (b.length >>> 16) & 255, (b.length >> 8) & 255, b.length & 255);
        out.push(...b); return;
      }
      if (Array.isArray(v)) {
        if (v.length < 16) out.push(0x90 | v.length);
        else out.push(0xdc, v.length >> 8, v.length & 255);
        for (const x of v) w(x); return;
      }
      if (typeof v === 'object') {
        const ks = Object.keys(v).filter((k) => v[k] !== undefined);
        if (ks.length < 16) out.push(0x80 | ks.length);
        else out.push(0xde, ks.length >> 8, ks.length & 255);
        for (const k of ks) { w(k); w(v[k]); } return;
      }
      out.push(0xc0);
    })(v);
    return new Uint8Array(out);
  }
  function dec(buf, pos) {
    let p = pos || 0;
    const r16 = () => { const v = (buf[p] << 8) | buf[p + 1]; p += 2; return v; };
    const r32 = () => { const v = buf[p] * 16777216 + (buf[p + 1] << 16) + (buf[p + 2] << 8) + buf[p + 3]; p += 4; return v; };
    function rd() {
      const b = buf[p++];
      if (b <= 0x7f) return b;
      if (b >= 0xe0) return b - 256;
      if ((b & 0xf0) === 0x80) { const o = {}; for (let i = 0, n = b & 15; i < n; i++) { const k = rd(); o[k] = rd(); } return o; }
      if ((b & 0xf0) === 0x90) { const a = []; for (let i = 0, n = b & 15; i < n; i++) a.push(rd()); return a; }
      if ((b & 0xe0) === 0xa0) { const l = b & 31; const s = TD.decode(buf.subarray(p, p + l)); p += l; return s; }
      switch (b) {
        case 0xc0: return null;
        case 0xc2: return false;
        case 0xc3: return true;
        case 0xc4: { const l = buf[p++]; const v = buf.subarray(p, p + l); p += l; return v; }
        case 0xc5: { const l = r16(); const v = buf.subarray(p, p + l); p += l; return v; }
        case 0xc6: { const l = r32(); const v = buf.subarray(p, p + l); p += l; return v; }
        case 0xca: { const dv = new DataView(buf.buffer, buf.byteOffset + p, 4); p += 4; return dv.getFloat32(0); }
        case 0xcb: { const dv = new DataView(buf.buffer, buf.byteOffset + p, 8); p += 8; return dv.getFloat64(0); }
        case 0xcc: return buf[p++];
        case 0xcd: return r16();
        case 0xce: return r32();
        case 0xcf: { let v = 0; for (let i = 0; i < 8; i++) v = v * 256 + buf[p++]; return v; }
        case 0xd0: { const v = buf[p++]; return v > 127 ? v - 256 : v; }
        case 0xd1: { const v = r16(); return v > 32767 ? v - 65536 : v; }
        case 0xd2: { const v = r32(); return v > 2147483647 ? v - 4294967296 : v; }
        case 0xd3: { let v = 0n; for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(buf[p++]); return (v >= -9007199254740991n && v <= 9007199254740991n) ? Number(v) : v; }
        case 0xd9: { const l = buf[p++]; const s = TD.decode(buf.subarray(p, p + l)); p += l; return s; }
        case 0xda: { const l = r16(); const s = TD.decode(buf.subarray(p, p + l)); p += l; return s; }
        case 0xdb: { const l = r32(); const s = TD.decode(buf.subarray(p, p + l)); p += l; return s; }
        case 0xdc: { const l = r16(), a = []; for (let i = 0; i < l; i++) a.push(rd()); return a; }
        case 0xdd: { const l = r32(), a = []; for (let i = 0; i < l; i++) a.push(rd()); return a; }
        case 0xde: { const l = r16(), o = {}; for (let i = 0; i < l; i++) { const k = rd(); o[k] = rd(); } return o; }
        case 0xdf: { const l = r32(), o = {}; for (let i = 0; i < l; i++) { const k = rd(); o[k] = rd(); } return o; }
        case 0xd4: { const t = buf[p++]; const d = buf[p++]; return { __ext: t, d }; }
        case 0xd5: { const t = buf[p++]; const d = buf.subarray(p, p + 2); p += 2; return { __ext: t, d: [...d] }; }
        case 0xd6: { const t = buf[p++]; const d = buf.subarray(p, p + 4); p += 4; return { __ext: t, d: [...d] }; }
        case 0xd7: { const t = buf[p++]; const d = buf.subarray(p, p + 8); p += 8; return { __ext: t, d: [...d] }; }
        case 0xd8: { const t = buf[p++]; const l = buf[p++]; const d = buf.subarray(p, p + l); p += l; return { __ext: t, d: [...d] }; }
        case 0xc7: { const l = buf[p++]; const t = buf[p++]; const d = buf.subarray(p, p + l); p += l; return { __ext: t, d: [...d] }; }
        case 0xc8: { const l = r16(); const t = buf[p++]; const d = buf.subarray(p, p + l); p += l; return { __ext: t, d: [...d] }; }
        case 0xc9: { const l = r32(); const t = buf[p++]; const d = buf.subarray(p, p + l); p += l; return { __ext: t, d: [...d] }; }
        default: throw new Error('mp byte 0x' + b.toString(16));
      }
    }
    return { v: rd(), p };
  }
  function frameBytes(type, data) {
    const t = encU8(type);
    const d = data === undefined ? new Uint8Array(0) : encU8(data);
    const out = new Uint8Array(1 + t.length + d.length);
    out[0] = 0x0d; out.set(t, 1); out.set(d, 1 + t.length);
    return out;
  }

  // ---------------------------------------------------------------- socket hook
  const listeners = new Set();
  function dispatch(type, data) { for (const fn of [...listeners]) { try { fn(type, data); } catch (e) { /* noop */ } } }
  function attach(s) {
    if (!s || s.__amktAttached) return;
    try { s.__amktAttached = true; } catch (e) { /* noop */ }
    s.addEventListener('message', (ev) => {
      const d = ev.data;
      let u8 = null;
      if (d instanceof ArrayBuffer) u8 = new Uint8Array(d);
      else if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(d)) u8 = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
      else if (typeof Blob !== 'undefined' && d instanceof Blob) { d.arrayBuffer().then((b) => attach.consume(new Uint8Array(b))).catch(() => {}); return; }
      if (!u8) return;
      attach.consume(u8);
    });
  }
  attach.consume = function (u8) {
    if (!u8.length || u8[0] !== 0x0d) return;
    const rest = u8.subarray(1);
    let r1, r2;
    try { r1 = dec(rest, 0); } catch (e) { return; }
    try { r2 = dec(rest, r1.p); } catch (e) { r2 = { v: undefined }; }
    dispatch(r1.v, r2.v);
  };
  const OrigWS = W.WebSocket;
  function WS(...args) {
    const s = new OrigWS(...args);
    W.__amktWS = s;
    try { attach(s); } catch (e) { /* noop */ }
    LOG('socket created');
    return s;
  }
  WS.prototype = OrigWS.prototype;
  WS.CONNECTING = 0; WS.OPEN = 1; WS.CLOSING = 2; WS.CLOSED = 3;
  W.WebSocket = WS;

  // ---------------------------------------------------------------- game data
  const AFFIX_TH = {
    ATK: 'ATK', MATK: 'MATK', DEF: 'DEF', MDEF: 'MDEF', HIT: 'HIT', FLEE: 'FLEE', CRIT: 'CRIT', ASPD: 'ASPD',
    MAXHP: 'Max HP', MAXSP: 'Max SP', MOVE_SPEED: 'ความเร็วเดิน', CRIT_DAMAGE: 'ดาเมจคริ',
    MELEE_DAMAGE_PERCENT: 'ดาเมจระยะประชิด', RANGED_DAMAGE_PERCENT: 'ดาเมจระยะไกล', MAGIC_DAMAGE_PERCENT: 'ดาเมจเวท',
    DAMAGE_REDUCTION: 'ลดดาเมจที่ได้รับ', BLOCK_CHANCE: 'โอกาสบล็อก', HEAL_POWER: 'พลังฮีล',
    STR: 'STR', AGI: 'AGI', VIT: 'VIT', INT: 'INT', DEX: 'DEX', LUK: 'LUK'
  };
  const AFFIX_PCT = new Set(['MOVE_SPEED', 'CRIT_DAMAGE', 'MELEE_DAMAGE_PERCENT', 'RANGED_DAMAGE_PERCENT', 'MAGIC_DAMAGE_PERCENT', 'DAMAGE_REDUCTION', 'BLOCK_CHANCE', 'HEAL_POWER']);
  const ATTR_TH = {
    STR: 'STR', AGI: 'AGI', VIT: 'VIT', INT: 'INT', DEX: 'DEX', LUK: 'LUK',
    MELEE_ATTACK: 'ATK', RANGE_ATTACK: 'ATK (ระยะไกล)', MAGIC_ATTACK: 'MATK', HIT: 'HIT', FLEE: 'FLEE',
    CRI: 'CRIT', CRI_DAMAGE: 'ดาเมจคริ %', MELEE_DEFENSE: 'DEF', MAGIC_DEFENSE: 'MDEF',
    MAXHP: 'Max HP', MAXSP: 'Max SP', MAXHP_PERCENT: 'Max HP %', MAXSP_PERCENT: 'Max SP %',
    ATK_PERCENT: 'ATK %', MATK_PERCENT: 'MATK %', ATK_SPEED: 'ASPD', ATK_SPEED_PERCENT: 'ASPD %',
    MOVE_SPEED: 'ความเร็วเดิน %', CASTING_SPEED: 'ความเร็วร่าย', MELEE_DAMAGE_PERCENT: 'ดาเมจประชิด %',
    RANGE_DAMAGE_PERCENT: 'ดาเมจระยะไกล %', MAGIC_DAMAGE_PERCENT: 'ดาเมจเวท %', DAMAGE_REDUCTION: 'ลดดาเมจที่ได้รับ %',
    BLOCK_CHANCE: 'โอกาสบล็อก %', HEAL_POWER: 'พลังฮีล %', HP_DRAIN_ATTACK: 'ตีปกติดูดเลือด %', HP_DRAIN_SKILL: 'สกิลดูดเลือด %',
    SP_DRAIN_ATTACK: 'ตีปกติดูด SP %', SP_DRAIN_SKILL: 'สกิลดูด SP %', STUN_RESIST: 'กันสตัน %',
    ATTACK_RANGE: 'ระยะโจมตี (ช่อง)', ATK_STR_OVER_99: 'ATK (STR>99)'
  };
  const CATS = [['weapon', 'อาวุธ'], ['armor', 'ชุดเกราะ'], ['accessory', 'ประดับ/เจม'], ['usable', 'ใช้ได้'], ['card', 'การ์ด'], ['refine', 'แร่/ตีบวก'], ['material', 'วัตถุดิบ'], ['other', 'อื่นๆ']];
  const KINDS = {
    weapon: [['Sword', 'ดาบ'], ['TwoHandSword', 'ดาบสองมือ'], ['Dagger', 'มีดสั้น'], ['Axe', 'ขวาน'], ['TwoHandAxe', 'ขวานสองมือ'], ['Spear', 'หอก'], ['TwoHandSpear', 'หอกสองมือ'], ['Mace', 'กระบอง'], ['Staff', 'คทา'], ['Bow', 'ธนู'], ['Knuckle', 'สนับมือ'], ['Katar', 'คาตาร์'], ['Instrument', 'เครื่องดนตรี'], ['Whip', 'แส้'], ['Ammo', 'ลูกธนู/กระสุน']],
    armor: [['Armor', 'เสื้อเกราะ'], ['Helmet', 'หมวก (บน)'], ['HeadMid', 'หมวก (กลาง)'], ['HeadLow', 'หมวก (ล่าง)'], ['Shield', 'โล่'], ['Cape', 'ผ้าคลุม'], ['Boot', 'รองเท้า'], ['Glove', 'ถุงมือ'], ['Costume', 'คอสตูม']],
    accessory: [['Acc', 'เครื่องประดับ'], ['Gem', 'เจม']]
  };
  const RARITIES = [['common', 'ธรรมดา'], ['uncommon', 'ดี'], ['rare', 'หายาก'], ['epic', 'มหากาพย์'], ['legendary', 'ตำนาน']];
  const fmt = (n) => (n == null ? '' : Number(n).toLocaleString('en-US'));
  const itemTitle = (it) => {
    const c = it.cards ? it.cards.length : 0;
    const n = it.slots ? it.name + ' [' + (c ? c + '/' : '') + it.slots + ']' : it.name;
    return it.refine ? '+' + it.refine + ' ' + n : n;
  };
  const affixText = (a) => {
    const lb = AFFIX_TH[a.type] || a.type;
    if (a.mode === 'base') return lb + ' +' + a.value + (AFFIX_PCT.has(a.type) ? '%' : '');
    return lb + ' +' + a.value + '%' + (a.mode === 'morePercent' ? ' (คูณ)' : '');
  };
  const attrText = (a) => (ATTR_TH[a.type] || a.type) + ' +' + a.value;

  // ---------------------------------------------------------------- market client
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const CACHE_KEY = 'amk.lastScan.v1';
  const Market = {
    ws: null, chain: Promise.resolve(), waiters: new Set(), zeny: null, charName: null,
    ready() { return !!(this.ws && this.ws.readyState === 1); },
    bind() {
      W.__amktWS && (this.ws = W.__amktWS);
      if (this.ws) attach(this.ws);
      listeners.add((type, data) => {
        if (type === 'character') { this.zeny = data && data.zeny != null ? data.zeny : this.zeny; this.charName = data && data.name ? data.name : this.charName; ui.zeny(); }
        for (const w of [...this.waiters]) {
          let out;
          try { out = w.test(type, data, w.st); } catch (e) { /* noop */ }
          if (out !== undefined && out !== null && out !== false) { this.waiters.delete(w); clearTimeout(w.timer); w.resolve(out); }
        }
      });
      setInterval(() => { if (W.__amktWS && W.__amktWS !== this.ws) { this.ws = W.__amktWS; attach(this.ws); } }, 1500);
    },
    send(type, payload) { const s = this.ws || W.__amktWS; if (!s || s.readyState !== 1) throw new Error('ยังไม่ได้เชื่อมต่อเกม'); s.send(frameBytes(type, payload)); },
    op(payload, test, timeoutMs) {
      const run = async () => {
        const st = {}; const self = this;
        const resP = new Promise((resolve, reject) => {
          const w = { test, st, resolve, reject, timer: setTimeout(() => { self.waiters.delete(w); if (st.results !== undefined) resolve(st.results); else if (st.done) resolve(st.done); else reject(new Error('หมดเวลา (' + (payload.op || '?') + ')')); }, timeoutMs || 5000) };
          this.waiters.add(w);
        });
        this.send('market', payload);
        return resP;
      };
      const next = this.chain.catch(() => {}).then(run);
      this.chain = next.catch(() => {});
      return next;
    },
    async searchPage(filters) {
      const res = await this.op({ op: 'search', filters }, (type, data, st) => {
        if (type === 'market_results' && data && data.page === filters.page) st.results = data;
        if (type === 'market_done') st.done = true;
        if (st.results && st.done) return st.results;
      }, 6000);
      return res;
    },
    async searchRetry(filters) {
      let err;
      for (let i = 0; i < 3; i++) {
        try { return await this.searchPage(filters); }
        catch (e) { err = e; await sleep(250 + i * 300); }
      }
      throw err;
    },
    async scan(base, onProgress, token) {
      const all = []; const seen = new Set(); let total = 0; let page = 0; const MAX = 250;
      for (; page < MAX; page++) {
        if (token && token.cancelled) break;
        const r = await this.searchRetry(Object.assign({}, base, { page }));
        total = r.total || 0;
        const ls = r.listings || [];
        // dedupe by listingId: pages shift while the scan runs (items sell / new listings)
        for (const l of ls) { if (l && !seen.has(l.listingId)) { seen.add(l.listingId); all.push(l); } }
        onProgress && onProgress({ got: all.length, total, page, pageSize: r.pageSize || 20 });
        if (!ls.length || all.length >= total) break;
      }
      return { listings: all, total, pages: page + 1, capped: page >= MAX };
    },
    async buy(listingId, price) {
      return this.op({ op: 'buy', listingId, price }, (type, data, st) => {
        if (type === 'market_done' && data && data.op === 'buy') return data;
      });
    },
    async collectAll() {
      return this.op({ op: 'collect_all' }, (type, data, st) => {
        if (type === 'market_done' && data && data.op === 'collect_all') return data;
      });
    },
    cacheSave(base, res) {
      try {
        const s = JSON.stringify({ v: 1, t: Date.now(), base, total: res.total, pages: res.pages, listings: res.listings });
        if (s.length < 2800000) W.localStorage.setItem(CACHE_KEY, s);
      } catch (e) { /* quota */ }
    },
    cacheLoad() {
      try {
        const s = W.localStorage.getItem(CACHE_KEY);
        if (!s) return null;
        const c = JSON.parse(s);
        if (!c || !Array.isArray(c.listings) || !c.listings.length) return null;
        return c;
      } catch (e) { return null; }
    }
  };

  // ---------------------------------------------------------------- UI
  const CSS = `
  .amk-launch{position:fixed;right:14px;bottom:64px;z-index:99998;background:#121826e0;border:2px solid #c9a45c;border-radius:10px;color:#ffd166;font:600 13px/1 'Noto Sans Thai',system-ui,sans-serif;padding:10px 14px;cursor:pointer;box-shadow:0 6px 20px #00000073}
  .amk-launch:hover{background:#1a2233f0}
  .amk-panel{position:fixed;right:14px;top:56px;bottom:56px;width:min(780px,94vw);z-index:99999;background:#121826f2;border:2px solid #c9a45c;border-radius:12px;color:#f3f0e8;font:12px/1.45 'Noto Sans Thai',system-ui,sans-serif;display:flex;flex-direction:column;box-shadow:0 10px 40px #000000b0;overflow:hidden}
  .amk-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #ffffff1f;background:#0e1420cc}
  .amk-head b{color:#ffd166;font-size:13px}
  .amk-head .amk-status{color:#a9b1c2;font-size:11px;margin-left:auto}
  .amk-x{background:none;border:none;color:#a9b1c2;font-size:15px;cursor:pointer}
  .amk-body{display:flex;flex:1;min-height:0}
  .amk-side{width:250px;min-width:250px;border-right:1px solid #ffffff1f;padding:8px;overflow-y:auto;display:flex;flex-direction:column;gap:6px}
  .amk-main{flex:1;min-width:0;display:flex;flex-direction:column}
  .amk-filters{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:8px;border-bottom:1px solid #ffffff1f}
  .amk-filters label{display:flex;flex-direction:column;gap:2px;color:#a9b1c2;font-size:11px}
  .amk-filters select,.amk-filters input{background:#0e1420;border:1px solid #ffffff2e;border-radius:6px;color:#f3f0e8;padding:4px 6px;font:inherit;min-width:0}
  .amk-filters .amk-wide{grid-column:1/3}
  .amk-chips{display:flex;flex-wrap:wrap;gap:4px}
  .amk-chip{border:1px solid #ffffff2e;border-radius:999px;padding:2px 8px;cursor:pointer;color:#cdd3df;background:#0e142066;font-size:11px;user-select:none}
  .amk-chip.on{background:#ffd166;color:#1a1a1a;border-color:#ffd166;font-weight:700}
  .amk-sechead{color:#ffd166;font-weight:700;margin:4px 0 2px;font-size:11px}
  .amk-actions{display:flex;gap:6px;padding:8px;border-bottom:1px solid #ffffff1f;align-items:center;flex-wrap:wrap}
  .amk-btn{background:#1c2740;border:1px solid #c9a45c;color:#ffd166;border-radius:8px;padding:6px 10px;font:inherit;font-weight:700;cursor:pointer}
  .amk-btn:disabled{opacity:.45;cursor:default}
  .amk-btn.gold{background:#ffd166;color:#1a1a1a}
  .amk-prog{color:#a9b1c2;font-size:11px;margin-left:auto}
  .amk-list{flex:1;overflow-y:auto;min-height:0}
  .amk-row{display:grid;grid-template-columns:minmax(140px,1.2fr) 86px 104px 1fr 64px;gap:6px;padding:5px 8px;border-bottom:1px solid #ffffff12;align-items:center}
  .amk-row:hover{background:#ffffff08}
  .amk-row.bought{opacity:.5}
  .amk-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .amk-sub{color:#a9b1c2;font-size:10px}
  .amk-price{color:#ffd166;font-weight:700;white-space:nowrap}
  .amk-seller{color:#a9b1c2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .amk-badges{display:flex;flex-wrap:wrap;gap:3px}
  .amk-b{font-size:10px;border-radius:4px;padding:1px 5px;background:#ffffff14;white-space:nowrap}
  .amk-b.a-primary{background:#ffd16626;color:#ffd166}
  .amk-b.a-secondary{background:#7cc4ff24;color:#7cc4ff}
  .amk-b.a-special{background:#c792ea24;color:#c792ea}
  .amk-b.attr{background:#8de0a624;color:#8de0a6}
  .amk-b.auc{background:#ff9f4326;color:#ff9f43}
  .amk-rarity-common{color:#f3f0e8}.amk-rarity-uncommon{color:#8de0a6}.amk-rarity-rare{color:#7cc4ff}.amk-rarity-epic{color:#c792ea}.amk-rarity-legendary{color:#ffd166}
  .amk-buy{background:#ffd166;color:#1a1a1a;border:none;border-radius:6px;padding:4px 8px;font:inherit;font-weight:700;cursor:pointer}
  .amk-buy:disabled{opacity:.35;cursor:default}
  .amk-empty{padding:16px;color:#a9b1c2;text-align:center}
  .amk-toast{padding:6px 10px;border-top:1px solid #ffffff1f;color:#8de0a6;min-height:26px;font-size:11px;display:flex;gap:8px;align-items:center}
  .amk-toast.err{color:#ff6b6b}
  .amk-muted{color:#a9b1c2;font-size:11px}
  .amk-warn{color:#ff9f43;font-size:11px;display:none}
  .amk-warn.on{display:inline}
  .amk-note{color:#a9b1c2;font-size:10px;margin-top:2px}
  .amk-summary{padding:4px 8px;color:#ffd166;font-size:11px;border-bottom:1px solid #ffffff12;background:#0e142066}
  `;

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  const ui = {
    panel: null, raw: [], filterAffixes: new Set(), filterAttrs: new Set(), mode: 'and', token: null, scanning: false, lastScanAt: 0,
    mount() {
      const style = el('style'); style.textContent = CSS; document.head.appendChild(style);
      const launch = el('button', 'amk-launch', 'ตลาด+ ค้นหาละเอียด');
      launch.addEventListener('click', () => this.open());
      document.body.appendChild(launch);
      this.launch = launch;
    },
    open() {
      if (this.panel) return;
      const p = el('div', 'amk-panel');
      p.innerHTML = `
        <div class="amk-head"><b>ตลาด+</b><span class="amk-muted">ค้นหาตามความสามารถ · ซื้อได้ทันที</span><span class="amk-status">รอเชื่อมต่อ…</span><button class="amk-x" title="ปิด">✕</button></div>
        <div class="amk-body">
          <div class="amk-side">
            <div class="amk-sechead">กรองฝั่งเซิร์ฟเวอร์</div>
            <div class="amk-filters" id="amk-f">
              <label>หมวด<select data-k="category"></select></label>
              <label>ประเภท<select data-k="kind"></select></label>
              <label>ความหายาก<select data-k="rarity"></select></label>
              <label>เรียง<select data-k="sort"></select></label>
              <label class="amk-wide">ชื่อไอเทม<input data-k="q" type="text" placeholder="เช่น Red Bandana"></label>
              <label>ราคาต่ำสุด<input data-k="minPrice" inputmode="numeric" placeholder="0"></label>
              <label>ราคาสูงสุด<input data-k="maxPrice" inputmode="numeric" placeholder="ว่าง = ไม่จำกัด"></label>
              <label>ตีบวก ≥<input data-k="minRefine" inputmode="numeric" placeholder="0"></label>
            </div>
            <div class="amk-sechead">ความสามารถติดตัว (attributes)</div>
            <div class="amk-chips" id="amk-attrs"></div>
            <div class="amk-sechead">ออปชันพิเศษ (affixes)</div>
            <div class="amk-chips" id="amk-affixes"></div>
            <label class="amk-muted"><input type="radio" name="amk-mode" value="and" checked> ต้องมีทั้งหมด</label>
            <label class="amk-muted"><input type="radio" name="amk-mode" value="or"> มีอย่างใดอย่างหนึ่ง</label>
            <div class="amk-note">โน้ต: ชิปทั้ง 2 ส่วนจับคู่กับ “ความสามารถทั้งหมดของไอเทม” อัตโนมัติ — เลือกจากส่วนไหนก็เจอเหมือนกัน</div>
          </div>
          <div class="amk-main">
            <div class="amk-actions">
              <button class="amk-btn gold" id="amk-scan">สแกนตลาด</button>
              <button class="amk-btn" id="amk-stop" disabled>หยุด</button>
              <button class="amk-btn" id="amk-collect">รับของทั้งหมด</button>
              <label class="amk-muted"><input type="checkbox" id="amk-auto" checked> รับของอัตโนมัติหลังซื้อ</label>
              <span class="amk-warn" id="amk-warn"></span>
              <span class="amk-prog" id="amk-prog">ยังไม่ได้สแกน</span>
            </div>
            <div class="amk-summary" id="amk-summary"></div>
            <div class="amk-list" id="amk-list"><div class="amk-empty">เลือกตัวกรองแล้วกด “สแกนตลาด” — ระบบจะดึงรายการทั้งหมดมาให้ค้นตามความสามารถ</div></div>
            <div class="amk-toast" id="amk-toast"></div>
          </div>
        </div>`;
      document.body.appendChild(p);
      this.panel = p;
      p.querySelector('.amk-x').addEventListener('click', () => this.close());
      this.fillSelect(p.querySelector('[data-k=category]'), CATS, 'ทุกหมวด');
      this.fillSelect(p.querySelector('[data-k=rarity]'), RARITIES, 'ทุกระดับ');
      this.fillSelect(p.querySelector('[data-k=sort]'), [['price_asc', 'ราคาต่ำ → สูง'], ['price_desc', 'ราคาสูง → ต่ำ'], ['newest', 'ลงขายล่าสุด'], ['ending', 'ใกล้หมดเวลา']], null);
      p.querySelector('[data-k=category]').value = 'armor';
      this.syncKinds();
      p.querySelector('[data-k=category]').addEventListener('change', () => this.syncKinds());
      const ac = p.querySelector('#amk-affixes');
      Object.keys(AFFIX_TH).forEach((k) => ac.appendChild(this.chip(k, AFFIX_TH[k], this.filterAffixes, 'a-' + (AFFIX_PCT.has(k) ? 'primary' : 'secondary'))));
      const at = p.querySelector('#amk-attrs');
      Object.keys(ATTR_TH).forEach((k) => at.appendChild(this.chip(k, ATTR_TH[k], this.filterAttrs, 'attr', true)));
      p.querySelectorAll('input[name=amk-mode]').forEach((r) => r.addEventListener('change', () => { this.mode = r.value; this.render(); }));
      // restore visuals from persistent state — chips/mode survive panel close/reopen,
      // so re-created DOM must reflect the real selection (fixes sticky/desynced filters)
      const modeSel = p.querySelector('input[name=amk-mode][value=' + (this.mode === 'or' ? 'or' : 'and') + ']');
      if (modeSel) modeSel.checked = true;
      // server-side filter fields: warn that a rescan is needed when they change
      p.querySelectorAll('.amk-filters [data-k]').forEach((inp) => {
        inp.addEventListener(inp.tagName === 'SELECT' ? 'change' : 'input', () => this.setDirty(true));
      });
      p.querySelector('#amk-scan').addEventListener('click', () => this.scan());
      p.querySelector('#amk-stop').addEventListener('click', () => { if (this.token) this.token.cancelled = true; });
      p.querySelector('#amk-collect').addEventListener('click', () => this.collect());
      this.els = {
        status: p.querySelector('.amk-status'), prog: p.querySelector('#amk-prog'), list: p.querySelector('#amk-list'),
        toast: p.querySelector('#amk-toast'), scan: p.querySelector('#amk-scan'), stop: p.querySelector('#amk-stop'),
        f: p.querySelector('#amk-f'), warn: p.querySelector('#amk-warn'), summary: p.querySelector('#amk-summary')
      };
      this.setDirty(!!this.formDirty);
      // restore last scan (cache) so reopening after the game's auto-reload is instant
      const c = Market.cacheLoad();
      if (c) {
        this.lastScanAt = c.t;
        this.raw = c.listings;
        this.restoreForm(c.base || {});
        const age = Math.max(1, Math.round((Date.now() - c.t) / 60000));
        this.els.prog.textContent = 'ผลสแกนล่าสุด: ' + fmt(c.listings.length) + ' รายการ (' + age + ' นาทีที่แล้ว) — กด “สแกนตลาด” เพื่ออัปเดต';
        this.render();
      }
      this.tick();
    },
    close() { this.panel && this.panel.remove(); this.panel = null; },
    fillSelect(sel, items, anyLabel) {
      if (anyLabel) { const o = el('option', null, anyLabel); o.value = ''; sel.appendChild(o); }
      for (const [v, l] of items) { const o = el('option', null, l); o.value = v; sel.appendChild(o); }
    },
    syncKinds() {
      const cat = this.panel.querySelector('[data-k=category]').value;
      const sel = this.panel.querySelector('[data-k=kind]');
      sel.innerHTML = '';
      const o = el('option', null, 'ทุกประเภท'); o.value = ''; sel.appendChild(o);
      (KINDS[cat] || []).forEach(([v, l]) => { const x = el('option', null, l); x.value = v; sel.appendChild(x); });
    },
    restoreForm(base) {
      try {
        const cat = this.panel.querySelector('[data-k=category]');
        if (base.category) { cat.value = base.category; this.syncKinds(); }
        ['kind', 'rarity', 'sort', 'q', 'minPrice', 'maxPrice', 'minRefine'].forEach((k) => {
          const inp = this.panel.querySelector('[data-k=' + k + ']');
          if (inp && base[k] != null && base[k] !== '') inp.value = base[k];
        });
      } catch (e) { /* noop */ }
    },
    setDirty(v) {
      this.formDirty = !!v;
      if (this.els && this.els.warn) {
        this.els.warn.textContent = v ? '⚠ ตัวกรองเปลี่ยนแล้ว — กด “สแกนตลาด” เพื่ออัปเดตผล' : '';
        this.els.warn.className = 'amk-warn' + (v ? ' on' : '');
      }
    },
    chip(key, label, set, cls) {
      const c = el('span', 'amk-chip ' + (cls || ''), label);
      if (set.has(key)) c.classList.add('on'); // reflect real state on reopen
      c.addEventListener('click', () => { set.has(key) ? set.delete(key) : set.add(key); c.classList.toggle('on'); this.render(); });
      return c;
    },
    readForm() {
      const f = {};
      this.els.f.querySelectorAll('[data-k]').forEach((inp) => {
        const k = inp.getAttribute('data-k'); let v = inp.value;
        if (v !== '' && v != null) {
          if (['minPrice', 'maxPrice', 'minRefine'].includes(k)) { const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10); if (isFinite(n)) f[k] = n; }
          else f[k] = v;
        }
      });
      f.sort = f.sort || 'price_asc';
      return f;
    },
    async scan() {
      if (this.scanning) return;
      if (!Market.ready()) { this.toast('ยังไม่ได้เชื่อมต่อเกม — เข้าเล่นก่อนแล้วค่อยสแกน', true); return; }
      this.scanning = true; this.token = { cancelled: false };
      this.els.scan.disabled = true; this.els.stop.disabled = false;
      this.setDirty(false);
      this.els.prog.textContent = 'เริ่มสแกน…';
      const base = this.readForm();
      try {
        const res = await Market.scan(base, ({ got, total, page }) => {
          this.els.prog.textContent = 'สแกนแล้ว ' + fmt(got) + ' / ' + fmt(total) + ' รายการ (' + (page + 1) + ' หน้า)';
        }, this.token);
        this.raw = res.listings;
        this.lastScanAt = Date.now();
        Market.cacheSave(base, res);
        this.els.prog.textContent = 'สแกนเสร็จ: ' + fmt(this.raw.length) + ' รายการ จาก ' + res.pages + ' หน้า' + (this.token.cancelled ? ' (หยุดก่อน)' : '') + (res.capped ? ' — ถึงขีดจำกัด' : '');
        this.render();
      } catch (e) {
        this.toast('สแกนไม่สำเร็จ: ' + e.message, true);
        this.els.prog.textContent = 'สแกนไม่สำเร็จ';
      } finally {
        this.scanning = false; this.els.scan.disabled = false; this.els.stop.disabled = true;
      }
    },
    match(l) {
      // UNION semantics: a selected chip matches if the ability is EITHER an innate
      // attribute OR an affix — so it does not matter which chip group was clicked.
      const wanted = new Set([...this.filterAffixes, ...this.filterAttrs]);
      if (!wanted.size) return true;
      const it = l.item || {};
      const have = new Set();
      (it.attributes || []).forEach((a) => have.add(a.type));
      (it.affixes || []).forEach((a) => have.add(a.type));
      const tests = [...wanted].map((k) => have.has(k));
      return this.mode === 'and' ? tests.every(Boolean) : tests.some(Boolean);
    },
    render() {
      if (!this.panel) return;
      const list = this.els.list;
      const now = Date.now();
      const rows = this.raw.filter((l) => this.match(l));
      // always-visible filter summary (ground truth: what is actually applied)
      if (this.els.summary) {
        const wanted = [...new Set([...this.filterAffixes, ...this.filterAttrs])];
        const lbl = (k) => AFFIX_TH[k] || ATTR_TH[k] || k;
        this.els.summary.textContent = wanted.length
          ? 'ตัวกรอง: ' + wanted.map(lbl).join(' + ') + ' — ' + (this.mode === 'and' ? 'ต้องมีทั้งหมด' : 'อย่างใดอย่างหนึ่ง') + ' — พบ ' + fmt(rows.length) + ' รายการ'
          : 'ยังไม่ได้เลือกความสามารถ — แสดงทั้งหมด ' + fmt(this.raw.length) + ' รายการ';
      }
      list.innerHTML = '';
      if (!rows.length) { list.appendChild(el('div', 'amk-empty', this.raw.length ? 'ไม่พบไอเทมที่ตรงกับตัวกรองความสามารถ (ลดตัวกรองหรือสแกนใหม่)' : 'ยังไม่มีข้อมูล — กดสแกนตลาด')); return; }
      const head = el('div', 'amk-row amk-muted');
      head.style.fontWeight = '700';
      ['ไอเทม', 'ราคา', 'ผู้ขาย', 'ความสามารถ', ''].forEach((t) => head.appendChild(el('div', null, t)));
      list.appendChild(head);
      for (const l of rows.slice(0, 400)) list.appendChild(this.row(l, now));
      if (rows.length > 400) list.appendChild(el('div', 'amk-empty', 'แสดง 400 จาก ' + fmt(rows.length) + ' รายการ — เพิ่มตัวกรองเพื่อแคบลง'));
    },
    row(l, now) {
      const it = l.item || {};
      const row = el('div', 'amk-row');
      const name = el('div', null);
      name.appendChild(el('div', 'amk-name amk-rarity-' + (it.rarity || 'common'), itemTitle(it)));
      const sub = el('div', 'amk-sub', (it.equipType || it.type || '') + (it.levelReq ? ' · Lv.' + it.levelReq : '') + (l.qty > 1 ? ' · x' + l.qty : ''));
      name.appendChild(sub);
      row.appendChild(name);
      row.appendChild(el('div', 'amk-price', fmt(l.price) + ' z'));
      row.appendChild(el('div', 'amk-seller', l.mine ? '(ของคุณ)' : l.sellerName));
      const badges = el('div', 'amk-badges');
      (it.attributes || []).forEach((a) => badges.appendChild(el('span', 'amk-b attr', attrText(a) + (a.minRefine ? ' (ตีบวก +' + a.minRefine + ')' : ''))));
      (it.affixes || []).forEach((a) => badges.appendChild(el('span', 'amk-b a-' + (a.category || 'secondary'), affixText(a))));
      const auc = !!(l.auctionEndsAt && l.auctionEndsAt > now);
      if (auc) badges.appendChild(el('span', 'amk-b auc', 'ประมูล'));
      if (l.expiresAt && l.expiresAt < now) badges.appendChild(el('span', 'amk-b auc', 'หมดเวลา'));
      row.appendChild(badges);
      const btn = el('button', 'amk-buy', auc ? 'ประมูล' : 'ซื้อ');
      const noMoney = Market.zeny != null && l.price > Market.zeny;
      btn.disabled = !!l.mine || auc || noMoney || (l.expiresAt && l.expiresAt < now);
      if (noMoney && !l.mine) btn.title = 'Zeny ไม่พอ';
      btn.addEventListener('click', () => this.buy(l, btn, row));
      row.appendChild(btn);
      return row;
    },
    async buy(l, btn, row) {
      const it = l.item || {};
      if (!confirm('ซื้อ ' + itemTitle(it) + ' จาก ' + l.sellerName + ' ราคา ' + fmt(l.price) + ' z ?')) return;
      btn.disabled = true; btn.textContent = '…';
      try {
        const done = await Market.buy(l.listingId, l.price);
        if (done && done.ok === false) throw new Error('เซิร์ฟเวอร์ปฏิเสธการซื้อ');
        row.classList.add('bought'); btn.textContent = 'ซื้อแล้ว';
        const auto = document.getElementById('amk-auto');
        if (auto && auto.checked) { try { await Market.collectAll(); this.toast('ซื้อแล้ว + รับของเข้ากระเป๋าเรียบร้อย', false); } catch (e) { this.toast('ซื้อแล้ว — กด “รับของทั้งหมด” เพื่อรับของ', false); } }
        else this.toast('ซื้อแล้ว — กด “รับของทั้งหมด” เพื่อรับของ', false);
      } catch (e) {
        btn.disabled = false; btn.textContent = 'ซื้อ';
        this.toast('ซื้อไม่สำเร็จ: ' + e.message, true);
      }
    },
    async collect() {
      try { await Market.collectAll(); this.toast('รับของทั้งหมดแล้ว', false); }
      catch (e) { this.toast('รับของไม่สำเร็จ: ' + e.message, true); }
    },
    toast(msg, err) { if (!this.els) return; this.els.toast.textContent = msg; this.els.toast.className = 'amk-toast' + (err ? ' err' : ''); },
    zeny() { if (this.panel && this.els && this.els.status) this.els.status.textContent = (Market.charName ? Market.charName + ' · ' : '') + (Market.zeny != null ? fmt(Market.zeny) + ' z' : '') + ' · ' + (Market.ready() ? 'ออนไลน์' : 'รอเชื่อมต่อ…'); },
    tick() { if (!this.panel) return; this.zeny(); setTimeout(() => this.tick(), 2000); }
  };

  Market.bind();
  function boot() { try { ui.mount(); } catch (e) { LOG('mount failed', e); } }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
