// session.js — standalone session tracker (isolated world, document_start).
// Consumes semantic events from page-hook.js (MAIN world) via window.postMessage and keeps compact
// per-local-hour buckets per character in chrome.storage.local. No raw log, no server — counters only:
//   v = value of loot drops (qty × NPC sellPrice; cards/potions/scrolls/wings excluded, like the CC)
//   e / s = realized zeny up / spent-or-moved, k = kills, q = drop qty, c = cards, x = excluded value
// Accounting mirrors command-center/server/earnings.js for identical numbers.
// Tool bridge: window.postMessage({src:'ax-q', id, m, args}) -> {src:'ax-a', id, ok, data}.
(() => {
  'use strict';
  if (window.__axSessionLoaded) return;
  window.__axSessionLoaded = true;

  const HOURS_KEEP = 72;
  const REPLAY_MS = 90_000;
  const PEND_MAX = 300;
  const CARD_RE = /(?:\bcard\b|การ์ด)/i;
  const SCROLL_RE = /weight\s*limit|น้ำหนัก/i;
  const POTION_RE = /potion|ยา/i;
  const WING_RE = /butterfly\s*wing/i;

  const p2 = (x) => String(x).padStart(2, '0');
  const hourKeyOf = (t) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}`;
  };
  const lastHourKeys = (n) => {
    const out = [];
    const base = new Date();
    base.setMinutes(0, 0, 0);
    for (let i = 1; i <= n; i++) out.push(hourKeyOf(new Date(base.getTime() - i * 3600e3)));
    return out;
  };

  let charId = null;
  let charName = null;
  let joinAt = 0;
  let lastZeny = null;
  let paused = false;
  let hours = {};
  let pending = [];
  let loadedKey = null;
  let dirty = false;
  let flushTimer = null;
  let prices = null;
  let priceBusy = false;

  const blank = () => ({ v: 0, q: 0, k: 0, c: 0, x: 0, e: 0, s: 0, zd: 0, top: {} });
  const bucket = (k) => (hours[k] ??= blank());
  const prune = () => {
    const cut = hourKeyOf(Date.now() - HOURS_KEEP * 3600e3);
    for (const k of Object.keys(hours)) if (k < cut) delete hours[k];
  };

  const keyFor = (id) => 'axs:' + (id != null ? String(id) : 'pending');
  const snapshot = () => ({ v: 1, name: charName, lastZeny, byHour: hours, pend: pending.slice(0, PEND_MAX), updatedAt: Date.now() });

  const touch = () => {
    dirty = true;
    if (!flushTimer) flushTimer = setTimeout(flush, 15000);
  };

  async function flush() {
    flushTimer = null;
    if (!dirty || !loadedKey) return;
    dirty = false;
    prune();
    try {
      await chrome.storage.local.set({ [loadedKey]: snapshot() });
    } catch {}
  }

  let changedAt = 0;
  let changedTimer = null;
  const announce = () => {
    const now = Date.now();
    if (now - changedAt > 10000) {
      changedAt = now;
      try { window.dispatchEvent(new Event('ax-session-changed')); } catch {}
    } else if (!changedTimer) {
      changedTimer = setTimeout(() => {
        changedTimer = null;
        changedAt = Date.now();
        try { window.dispatchEvent(new Event('ax-session-changed')); } catch {}
      }, 10000);
    }
  };

  async function loadFor(id) {
    loadedKey = keyFor(id);
    hours = {};
    pending = [];
    lastZeny = null;
    try {
      const got = await chrome.storage.local.get(loadedKey);
      const st = got && got[loadedKey];
      if (st) {
        if (st.byHour) hours = st.byHour;
        if (Array.isArray(st.pend)) pending = st.pend;
        if (Number.isFinite(st.lastZeny)) lastZeny = st.lastZeny;
        if (st.name && !charName) charName = st.name;
      }
    } catch {}
    prune();
  }

  const postPaused = () => {
    try { window.postMessage({ src: 'ax-ctl', paused }, '*'); } catch {}
  };

  // ---------- accounting (mirrors command-center/server/earnings.js) ----------
  const valueInto = (k, name, qty) => {
    const p = prices ? prices.get(name) || 0 : 0;
    if (!(p > 0)) return;
    const h = bucket(k);
    if (CARD_RE.test(name)) { h.c += qty; return; }
    if (SCROLL_RE.test(name) || POTION_RE.test(name) || WING_RE.test(name)) { h.x += p * qty; return; }
    h.v += p * qty;
    if (h.top[name] == null && Object.keys(h.top).length >= 14) return;
    h.top[name] = (h.top[name] ?? 0) + qty;
  };

  const foldPending = () => {
    if (!prices || !prices.size || !pending.length) return;
    const list = pending;
    pending = [];
    for (const it of list) valueInto(it.h, it.n, it.q);
    touch();
  };

  const drop = (name, qty, ts) => {
    const k = hourKeyOf(ts);
    bucket(k).q += qty;
    if (!prices || !prices.size) {
      if (pending.length < PEND_MAX) pending.push({ n: name, q: qty, h: k });
      return;
    }
    valueInto(k, name, qty);
  };

  const zenyPush = (ts, z) => {
    if (lastZeny != null && z !== lastZeny && lastZeny !== 0 && z !== 0) {
      const replay = joinAt && ts >= joinAt && ts - joinAt < REPLAY_MS;
      if (!replay) {
        const d = z - lastZeny;
        const h = bucket(hourKeyOf(ts));
        if (d > 0) h.e += d;
        else h.s += -d;
        h.zd += d;
      }
    }
    lastZeny = z;
  };

  // ---------- price table (public wiki-data; cached 24h; fetched lazily) ----------
  async function ensurePrices() {
    if (prices || priceBusy) return;
    priceBusy = true;
    try {
      const got = await chrome.storage.local.get('axPrices');
      const c = got && got.axPrices;
      if (c && c.map && Date.now() - (c.at || 0) < 24 * 3600e3) prices = new Map(Object.entries(c.map));
    } catch {}
    if (!prices) {
      try {
        const r = await fetch('https://www.aetheria-online.in.th/wiki-data', { cache: 'no-store' });
        const w = await r.json();
        const map = {};
        for (const arr of [w.items, w.ragnarokItems]) {
          for (const it of arr || []) {
            if (!it || !it.name) continue;
            const p = Number(it.sellPrice ?? 0) || 0;
            if (p <= 0) continue;
            if (!(map[it.name] > p)) map[it.name] = p;
          }
        }
        prices = new Map(Object.entries(map));
        try { await chrome.storage.local.set({ axPrices: { v: 1, at: Date.now(), map } }); } catch {}
      } catch {}
    }
    if (prices) {
      foldPending();
      announce();
    } else {
      priceBusy = false; // allow a retry on the next drop
    }
  }

  // ---------- events ----------
  const mergeBucket = (a, b) => {
    for (const f of ['v', 'q', 'k', 'c', 'x', 'e', 's', 'zd']) a[f] += b[f] || 0;
    for (const [n, q] of Object.entries(b.top || {})) {
      if (a.top[n] == null && Object.keys(a.top).length >= 14) continue;
      a.top[n] = (a.top[n] ?? 0) + q;
    }
  };

  const onIdent = async (d) => {
    if (d.characterId == null) return;
    if (String(d.characterId) === String(charId)) {
      if (d.name && d.name !== charName) { charName = d.name; touch(); }
      return;
    }
    if (dirty) await flush();
    // carry anything captured before we knew who we were (identity taps can lag the first events)
    const carry = hours;
    const carryPend = pending;
    charId = d.characterId;
    charName = d.name || null;
    await loadFor(charId);
    if (d.name) charName = d.name;
    if (carry && Object.keys(carry).length) {
      for (const [k, o] of Object.entries(carry)) mergeBucket(bucket(k), o);
      touch();
    }
    if (carryPend && carryPend.length) {
      pending = carryPend.concat(pending).slice(0, PEND_MAX);
      touch();
    }
    announce();
  };

  const recv = (d) => {
    switch (d.ev) {
      case 'ready': postPaused(); break;
      case 'join':
        if (!joinAt || Date.now() - joinAt > 300000) joinAt = Date.now(); // fresh session only (travel rejoins don't reset the replay guard)
        if (!prices) ensurePrices();
        announce();
        break;
      case 'ident': onIdent(d); break;
      case 'drop':
        if (paused || !d.name) break;
        if (!prices) ensurePrices();
        drop(String(d.name), Math.max(1, Math.floor(d.qty || 1)), Date.now());
        touch();
        announce();
        break;
      case 'kill':
        if (paused) break;
        bucket(hourKeyOf(Date.now())).k += 1;
        touch();
        announce();
        break;
      case 'char':
        if (paused || !Number.isFinite(d.zeny)) break;
        zenyPush(Date.now(), d.zeny);
        touch();
        announce();
        break;
      case 'left': touch(); break;
      default: break;
    }
  };

  // ---------- views (mirror the CC tracker) ----------
  const summary = () => {
    const v3 = lastHourKeys(3).map((k) => hours[k]).filter(Boolean);
    const rate3 = v3.length ? Math.round(v3.reduce((a, o) => a + o.v, 0) / v3.length) : null;
    let s24 = 0, n24 = 0;
    for (const k of lastHourKeys(24)) {
      const o = hours[k];
      if (o) { s24 += o.v; n24++; }
    }
    const rate24 = n24 ? Math.round(s24 / n24) : null;
    const cur = hours[hourKeyOf(Date.now())] || null;
    return {
      rate3, rate24, n24,
      characterId: charId, name: charName, paused,
      cur: cur ? { v: cur.v, e: cur.e, k: cur.k, q: cur.q } : null,
    };
  };

  const detail = (n) => {
    const keys = lastHourKeys(Math.max(4, Math.min(HOURS_KEEP, Number(n) || 12))).reverse();
    const arr = keys.map((k) => {
      const o = hours[k] ?? null;
      const top = o
        ? Object.entries(o.top)
            .map(([nm, q]) => {
              const pr = (prices && prices.get(nm)) || 0;
              return { n: nm, q, p: pr, v: pr * q };
            })
            .sort((a, b) => b.v - a.v)
            .slice(0, 6)
        : [];
      return { h: k, v: o && o.v ? o.v : 0, e: o && o.e ? o.e : 0, s: o && o.s ? o.s : 0, k: o ? o.k : 0, q: o ? o.q : 0, c: o ? o.c : 0, x: o ? o.x : 0, top };
    });
    const s = summary();
    return { ok: true, botId: charId, name: charName, hours: arr, rate3: s.rate3, rate24: s.rate24, cur: s.cur, savedAt: Date.now() };
  };

  const setPaused = (v) => {
    paused = !!v;
    try { chrome.storage.local.set({ axPaused: paused }); } catch {}
    postPaused();
    announce();
  };

  const clear = () => {
    hours = {};
    pending = [];
    lastZeny = null;
    dirty = true;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flush();
    announce();
  };

  const api = {
    getDetail: detail,
    getSummary: summary,
    identity: () => ({ characterId: charId, name: charName, zeny: lastZeny, paused }),
    setPaused,
    isPaused: () => paused,
    clear,
  };
  window.__axSession = api;

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.src === 'ax-hook') recv(d);
    else if (d.src === 'ax-q' && d.id) {
      const out = { src: 'ax-a', id: d.id, ok: true, data: null };
      try {
        const fn = api[d.m];
        out.ok = !!fn;
        if (fn) out.data = fn.apply(null, Array.isArray(d.args) ? d.args : []);
      } catch (err) {
        out.ok = false;
        out.error = String(err);
      }
      try { window.postMessage(out, '*'); } catch {}
    }
  });

  // persist on navigation away (best effort)
  window.addEventListener('pagehide', () => {
    if (dirty) flush();
  });

  // boot: restore pause state and tell the hook
  (async () => {
    try {
      const st = await chrome.storage.local.get('axPaused');
      paused = !!(st && st.axPaused);
    } catch {}
    await loadFor(null); // pre-identity buckets land under axs:pending until the ident event arrives
    postPaused();
  })();
})();
