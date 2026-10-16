// engine.js — data loading, EV calculation, filtering, shared state for the ROVA wiki.
export const ICON_BASE_REMOTE = 'https://rovaonline.net/pub/ui/'; // public UI assets (same files the official wiki shows)
export const ICON_BASE_LOCAL = 'icons/';                           // used after tools/fetch-icons.mjs mirrors them
export const MOB_BASE_REMOTE = 'https://rovaonline.net/pub/mob/';
export const MOB_BASE_LOCAL = 'icons/mob/';
let iconBase = ICON_BASE_REMOTE;
let mobBase = MOB_BASE_REMOTE;

export const TYPES = [
  ['Weapon', 'Weapon'],
  ['Armor', 'Armor'],
  ['Card', 'Card'],
  ['Healing', 'Healing'],
  ['Usable', 'Usable'],
  ['Etc', 'Materials'],
  ['Ammo', 'Ammo'],
  ['Petegg', 'Pet Egg'],
  ['Petarmor', 'Pet Armor'],
];

export const QUICK_SETS = {
  all: TYPES.map(([t]) => t),
  none: [],
  nocards: TYPES.map(([t]) => t).filter((t) => t !== 'Card'),
  gear: ['Weapon', 'Armor'],
  loot: ['Healing', 'Usable', 'Etc', 'Ammo'],
};

export const CLASSES = [
  ['drop', 'drops'],
  ['mvp', 'mvp'],
  ['spc', 'spc'],
];

const LS_KEY = 'rova.wiki.cfg.v1';

export const state = {
  db: null,
  cfg: {
    types: new Set(TYPES.map(([t]) => t)),
    classes: { drop: true, mvp: true, spc: true },
    scale: 100,
    search: { monsters: '', items: '', maps: '' },
    filters: { search: '', lvMin: null, lvMax: null, bossOnly: false, noBoss: false, noSpawn: false, map: '' },
    mobSort: { key: 'ev', dir: -1 },
    itemSort: { key: 'name', dir: 1 },
    mapSort: { key: 'name', dir: 1 },
    itemTypes: new Set(),
  },
  mobs: [],   // filtered + sorted
  selected: null,
};

export function saveCfg() {
  const c = state.cfg;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      types: [...c.types], classes: c.classes, scale: c.scale, search: c.search, filters: c.filters,
      mobSort: c.mobSort, itemSort: c.itemSort, mapSort: c.mapSort, itemTypes: [...c.itemTypes],
    }));
  } catch {}
}

export function loadCfg() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const j = JSON.parse(raw);
    if (Array.isArray(j.types)) state.cfg.types = new Set(j.types.filter((t) => TYPES.some(([x]) => x === t)));
    if (j.classes) for (const [k] of CLASSES) state.cfg.classes[k] = j.classes[k] !== false;
    if (j.scale) state.cfg.scale = Number(j.scale) || 100;
    if (j.search && typeof j.search === 'object') Object.assign(state.cfg.search, j.search);
    if (j.filters) Object.assign(state.cfg.filters, j.filters, { search: '' });
    if (j.mobSort) state.cfg.mobSort = j.mobSort;
    if (j.itemSort) state.cfg.itemSort = j.itemSort;
    if (j.mapSort) state.cfg.mapSort = j.mapSort;
    if (Array.isArray(j.itemTypes)) state.cfg.itemTypes = new Set(j.itemTypes);
  } catch {}
}

export async function loadDb() {
  // switch to local icons if they have been mirrored (tools/fetch-icons.mjs)
  try {
    const m = await fetch('icons/manifest.json', { cache: 'no-store' });
    if (m.ok) {
      iconBase = ICON_BASE_LOCAL;
      const j = await m.json();
      if (j.mobs > 0) mobBase = MOB_BASE_LOCAL;
    }
  } catch {}
  const r = await fetch('data/rova-db.json', { cache: 'no-store' });
  if (!r.ok) throw new Error('rova-db.json -> HTTP ' + r.status + ' (run: npm run build)');
  const db = await r.json();
  state.db = db;
  // spawn lookup per mob already baked in db.mobs[].spawns
  for (const m of db.mobs) {
    m._name = (m.n + ' ' + m.id).toLowerCase();
    m._maps = m.spawns.map((s) => s.map);
  }
  for (const [id, item] of Object.entries(db.items)) {
    item._id = Number(id);
    item._lname = item.n.toLowerCase();
  }
  return db;
}

// ---------------- EV ----------------
/** Compute EV rows + totals for a monster under the current toggles. */
export function evOfMob(m) {
  const cfg = state.cfg;
  const rows = [];
  for (const [cls, field] of CLASSES) {
    if (!cfg.classes[cls]) continue;
    for (const row of m[field]) {
      const [itemId, chance, cond] = row;
      const item = state.db.items[itemId];
      if (!item) continue;
      const included = cfg.types.has(item.t);
      const p = chance / 10000;
      const ev = p * (item.s || 0);
      rows.push({ itemId, chance, cls, item, ev, included, cond });
    }
  }
  rows.sort((a, b) => b.ev - a.ev);
  let total = 0, n = 0;
  for (const r of rows) if (r.included) { total += r.ev; n++; }
  return { rows, total, included: n, excluded: rows.length - n };
}

export function evSummary(mobs) {
  const out = [];
  for (const m of mobs) {
    const ev = evOfMob(m);
    let top = null;
    for (const r of ev.rows) if (r.included && (top === null || r.ev > top.ev)) top = r;
    out.push({ m, ev, top });
  }
  return out;
}

// ---------------- filtering ----------------
export function applyFilters(search = '') {
  const { db, cfg } = state;
  const f = cfg.filters;
  const q = search.trim().toLowerCase();
  // strip a trailing "(map id)" that the datalist suggestion appends
  const mapQ = f.map.trim().toLowerCase().replace(/\s*\([^)]*\)\s*$/, '');
  let mobs = db.mobs;

  if (q) {
    // search monsters by name; if it matches a map name, filter by that map too
    const mapHit = Object.entries(db.maps).find(([, mp]) => mp.n.toLowerCase().includes(q));
    mobs = mobs.filter((m) => m._name.includes(q) || (mapHit && m._maps.includes(mapHit[0])));
  }
  if (f.lvMin != null) mobs = mobs.filter((m) => m.lv >= f.lvMin);
  if (f.lvMax != null) mobs = mobs.filter((m) => m.lv <= f.lvMax);
  if (f.bossOnly) mobs = mobs.filter((m) => m.boss);
  if (f.noBoss) mobs = mobs.filter((m) => !m.boss);
  if (f.noSpawn) mobs = mobs.filter((m) => m.spawns.length > 0);
  if (mapQ) {
    const hits = new Set(
      Object.entries(db.maps)
        .filter(([id, mp]) => mp.n.toLowerCase().includes(mapQ) || id.toLowerCase().includes(mapQ))
        .map(([id]) => id)
    );
    mobs = mobs.filter((m) => m._maps.some((id) => hits.has(id)));
  }
  return mobs;
}

export function sortMobs(list) {
  const { key, dir } = state.cfg.mobSort;
  const evCache = new Map();
  const ev = (m) => {
    if (!evCache.has(m.id)) evCache.set(m.id, evOfMob(m).total);
    return evCache.get(m.id);
  };
  const cmp = {
    name: (a, b) => a.n.localeCompare(b.n),
    lv: (a, b) => a.lv - b.lv || a.hp - b.hp,
    hp: (a, b) => a.hp - b.hp,
    boss: (a, b) => a.boss - b.boss,
    ev: (a, b) => ev(a) - ev(b),
    drops: (a, b) => a.drops.length + a.mvp.length + a.spc.length - (b.drops.length + b.mvp.length + b.spc.length),
    top: () => 0,
  }[key] || ((a, b) => ev(a) - ev(b));
  return [...list].sort((a, b) => dir * cmp(a, b) || a.lv - b.lv || a.id.localeCompare(b.id));
}

// ---------------- sorting for items / maps ----------------
export function sortItems(list) {
  const { key, dir } = state.cfg.itemSort;
  const cmp = {
    name: (a, b) => a.n.localeCompare(b.n),
    sell: (a, b) => (a.s || 0) - (b.s || 0),
    buy: (a, b) => (a.b || 0) - (b.b || 0),
    weight: (a, b) => (a.w || 0) - (b.w || 0),
  }[key] || (() => 0);
  return [...list].sort((a, b) => dir * cmp(a, b));
}

export function sortMaps(list) {
  const { key, dir } = state.cfg.mapSort;
  const cmp = {
    name: (a, b) => a.n.localeCompare(b.n),
    mobs: (a, b) => a.mobCount - b.mobCount,
    avg: (a, b) => a.avg - b.avg,
    best: (a, b) => (a.best?.m.n ?? '').localeCompare(b.best?.m.n ?? ''),
    bestev: (a, b) => (a.best?.ev.total ?? 0) - (b.best?.ev.total ?? 0),
  }[key] || (() => 0);
  return [...list].sort((a, b) => dir * cmp(a, b));
}

// ---------------- formatting ----------------
export function fmtZ(v, opts = {}) {
  const n = v * (opts.raw ? 1 : 1);
  if (!isFinite(n)) return '-';
  const abs = Math.abs(n);
  if (opts.compact && abs >= 1e6) return trimNum(n / 1e6, 2) + 'M';
  if (opts.compact && abs >= 1e4) return trimNum(n / 1e3, 1) + 'k';
  if (!opts.compact && abs >= 1000) return Math.round(n).toLocaleString('en-US');
  if (abs >= 100) return Math.round(n).toLocaleString('en-US');
  if (abs >= 10) return trimNum(n, 1);
  if (abs >= 1) return trimNum(n, 1);
  if (abs === 0) return '0';
  return trimNum(n, 2);
}
function trimNum(n, d) {
  const s = n.toFixed(d);
  return s.replace(/\.?0+$/, '');
}
export function fmtPct(chance) {
  const p = chance / 100;
  if (p >= 10) return trimNum(p, 1) + '%';
  if (p >= 1) return trimNum(p, 2) + '%';
  return trimNum(p, 3) + '%';
}
export function fmtWeight(w10) {
  if (!w10) return '-';
  const v = w10 / 10;
  return trimNum(v, 1);
}
export function fmtSeconds(s) {
  if (s == null || s === 0) return 'instant';
  if (s < 60) return s + 's';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(s / 3600), mm = Math.round((s % 3600) / 60);
  return mm ? `${h}h ${mm}m` : `${h}h`;
}
export function fmtRespawn(lo, hi) {
  if (!lo && !hi) return 'instant';
  return lo === hi ? fmtSeconds(lo) : `${fmtSeconds(lo)}-${fmtSeconds(hi)}`;
}
export function itemIconUrl(item) {
  if (!item || !item.i) return null;
  return iconBase + item.i;
}
export function mobImgUrl(m) {
  if (!m || !m.sheet) return null;
  return mobBase + m.sheet + '.png';
}
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------- item source index (dropped by / shops / quests / boxes / src) ----------------
let _srcIndex = null;
export function buildSrcIndex() {
  const db = state.db;
  const idx = {};
  const add = (itemId, kind, rec) => {
    (idx[itemId] ??= { droppedBy: [], shops: [], quests: [], src: [], boxes: [] })[kind].push(rec);
  };
  for (const m of db.mobs) {
    for (const [cls, field] of CLASSES) {
      for (const row of m[field]) add(row[0], 'droppedBy', { mob: m, cls, chance: row[1], cond: row[2] });
    }
  }
  for (const [shopId, shop] of Object.entries(db.shops)) {
    for (const [itemId, price] of shop.items) add(itemId, 'shops', { shopId, price, npcs: shop.npcs });
  }
  for (const q of db.quests) {
    for (const [itemId, qty] of q.rew) add(itemId, 'quests', { quest: q, qty });
  }
  for (const [itemId, list] of Object.entries(db.src)) {
    for (const entry of list) add(itemId, 'src', { entry });
  }
  for (const [boxId, rows] of Object.entries(db.boxes)) {
    for (const row of rows) add(row[0], 'boxes', { boxId: Number(boxId), chance: row[1], qty: row[2] });
  }
  for (const v of Object.values(idx)) v.droppedBy.sort((a, b) => b.chance - a.chance);
  _srcIndex = idx;
  return idx;
}
export function srcIndex() {
  return _srcIndex || buildSrcIndex();
}
