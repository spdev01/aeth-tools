// build-db.mjs — join raw datasets into the single db the wiki UI loads.
// Input:  data/raw/*.json  (see fetch-all.mjs)
// Output: public/data/rova-db.json
//
// The UI computes expected value (EV) itself so category toggles can re-sum live:
//   EV(mob) = SUM over drops of  chance/10000 * sellPrice(item)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rawDir = path.resolve(here, '..', 'data', 'raw');
const outDir = path.resolve(here, '..', 'public', 'data');
fs.mkdirSync(outDir, { recursive: true });

const rd = (f) => JSON.parse(fs.readFileSync(path.join(rawDir, f), 'utf8'));

const wiki = rd('wiki-full.json');
const index = rd('wiki-index.json');
const client = rd('client.json');
const icons = rd('item_icons.json');
const facts = rd('item_facts.json');
const localeEn = rd('locale-en.json');
const meta = fs.existsSync(path.join(rawDir, 'meta.json')) ? rd('meta.json') : {};

// ---------- items ----------
const nativeItems = client?.runtime_profile110?.native_items?.items ?? [];
const items = {};
for (const it of nativeItems) {
  const f = it.effective_source_fields ?? {};
  const tr = f.trade ?? {};
  const rec = {
    // display name comes from the locale (native.item.<id>), the db carries the aegis-style name
    n: localeEn[`native.item.${it.source_item_id}`] ?? it.name ?? `item ${it.source_item_id}`,
    t: f.type ?? 'Etc',
    sb: f.subtype ?? '',
    s: f.sell ?? 0,
    b: f.buy ?? 0,
    w: f.weight_native_tenths ?? 0,
  };
  const icon = icons[String(it.source_item_id)];
  if (icon) rec.i = icon;
  if (f.attack) rec.atk = f.attack;
  if (f.magic_attack) rec.ma = f.magic_attack;
  if (f.defense) rec.def = f.defense;
  if (f.range) rec.rng = f.range;
  if (f.slots) rec.sl = f.slots;
  if (f.weapon_level) rec.wlv = f.weapon_level;
  if (f.equip_level_min) rec.elv = f.equip_level_min;
  if (f.refineable) rec.ref = 1;
  if (tr.NoSell) rec.ns = 1;
  if (tr.NoDrop) rec.nd = 1;
  if (tr.NoTrade) rec.nt = 1;
  const fact = facts?.items?.[String(it.source_item_id)];
  if (fact) rec.f = fact;
  items[it.source_item_id] = rec;
}

// ---------- mobs ----------
const L = (k, fb) => localeEn[k] ?? fb;
const mobs = (wiki.mobs ?? []).map((m) => {
  const rec = {
    id: m.id,
    n: L(`mob.${m.id}`, m.id),
    sheet: m.sheet ?? '',
    lv: m.lv,
    hp: m.hp,
    el: m.el,
    ell: m.ell,
    race: m.race,
    size: m.size,
    ag: m.ag,
    boss: m.boss,
    atk: m.atk,
    def: m.def,
    mdef: m.mdef,
    hit: m.hit,
    flee: m.flee,
    bexp: m.bexp,
    jexp: m.jexp,
    drops: m.drops ?? [],
    mvp: m.mvp ?? [],
    spc: m.special ?? [],
    spawns: [],
  };
  if (m.mvpexp) rec.mvpexp = m.mvpexp;
  return rec;
});
const mobById = new Map(mobs.map((m) => [m.id, m]));

// ---------- maps + spawn join ----------
const maps = {};
let spawnRows = 0;
const unmatchedSpawns = new Set();
for (const [mapId, rows] of Object.entries(wiki.maps ?? {})) {
  const spawns = [];
  for (const row of rows) {
    const [mobId, count, lo, hi] = row;
    if (!mobById.has(mobId)) { unmatchedSpawns.add(mobId); continue; }
    spawns.push(row);
    mobById.get(mobId).spawns.push({ map: mapId, count, lo: lo ?? 0, hi: hi ?? 0 });
    spawnRows++;
  }
  maps[mapId] = { n: L(`zone.${mapId}.name`, mapId), spawns };
}
for (const m of mobs) m.spawns.sort((a, b) => b.count - a.count);

// ---------- shops ----------
const shops = {};
for (const [shopId, s] of Object.entries(wiki.shops ?? {})) {
  shops[shopId] = {
    items: s.items ?? [],
    npcs: (s.npcs ?? []).map(([npcId, mapId]) => [npcId, mapId, L(`npc.${npcId}.name`, npcId)]),
  };
}

// ---------- quests ----------
const quests = (wiki.quests ?? []).map((q) => ({
  id: q.id,
  n: L(`quest.${q.id}.name`, q.id),
  k: q.k,
  lv: q.lv,
  map: q.map,
  giver: q.giver,
  rew: q.rew ?? [],
  learn: q.learn ?? '',
}));

// ---------- validation ----------
let dropRows = 0, unresolved = new Set();
for (const m of mobs) {
  for (const list of [m.drops, m.mvp, m.spc]) {
    for (const row of list) {
      dropRows++;
      if (!items[row[0]]) unresolved.add(row[0]);
    }
  }
}
const noSpawn = mobs.filter((m) => !m.spawns.length).length;
const bosses = mobs.filter((m) => m.boss).length;

console.log(`items      ${Object.keys(items).length} (${Object.keys(items).filter((k) => items[k].s > 0).length} with sell>0)`);
console.log(`mobs       ${mobs.length} (${bosses} boss, ${noSpawn} without spawns)`);
console.log(`drops      ${dropRows} rows across drops/mvp/special${unresolved.size ? ` — UNRESOLVED ITEM IDS: ${[...unresolved].join(',')}` : ' — all resolve to items'}`);
console.log(`maps       ${Object.keys(maps).length} (${spawnRows} spawn rows)${unmatchedSpawns.size ? ` — unmatched mob ids: ${[...unmatchedSpawns].join(',')}` : ''}`);
console.log(`shops      ${Object.keys(shops).length}`);
console.log(`quests     ${quests.length}`);

// top-EV sanity check (all categories, drops+mvp+special)
const ev = (m) => {
  let v = 0;
  for (const list of [m.drops, m.mvp, m.spc]) {
    for (const row of list) v += (row[1] / 10000) * (items[row[0]]?.s ?? 0);
  }
  return v;
};
const top = [...mobs].sort((a, b) => ev(b) - ev(a)).slice(0, 10);
console.log('\ntop EV/kill (all categories):');
for (const m of top) console.log(`  ${m.n.padEnd(28)} lv ${String(m.lv).padStart(3)}  ${Math.round(ev(m)).toLocaleString()} z/kill`);

// ---------- write ----------
const db = {
  meta: {
    builtAt: new Date().toISOString(),
    contentVersion: client.version ?? '',
    contentHash: meta.content ?? '',
    counts: {
      items: Object.keys(items).length,
      mobs: mobs.length,
      maps: Object.keys(maps).length,
      shops: Object.keys(shops).length,
      quests: quests.length,
    },
  },
  items,
  mobs,
  maps,
  shops,
  quests,
  src: wiki.src ?? {},
  boxes: wiki.boxes ?? {},
  cardmob: index.cardmob ?? {},
  how: index.how ?? {},
  exp: wiki.exp ?? {},
};

const outPath = path.join(outDir, 'rova-db.json');
fs.writeFileSync(outPath, JSON.stringify(db));
const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
console.log(`\nwrote ${outPath} (${kb} KB)`);
