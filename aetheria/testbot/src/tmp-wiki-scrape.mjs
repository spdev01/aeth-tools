// tmp-wiki-scrape.mjs — SCRAPED WIKI BUILDER.
// Downloads every game art asset we can reach (icons, monster sheets, class art, cards, NPC
// portraits, world atlas, loading art, event banners) into aetheria/wiki/assets/ and joins
// them with scraped data (wiki-data + patch notes + events) into aetheria/wiki/data.json.
// Re-runnable: existing files are skipped (resume).
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const BASE = 'https://www.aetheria-online.in.th';
const WIKI = 'E:/GitHub/lumivaraonline/aetheria/wiki';
const RECON = 'E:/GitHub/lumivaraonline/aetheria/recon';
fs.mkdirSync(WIKI, { recursive: true });

const jget = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(r.status + ' ' + u); return r.json(); };
const wikiData = JSON.parse(fs.readFileSync(RECON + '/wiki-data-2026-10-15.json', 'utf8'));
const patchNotes = JSON.parse(fs.readFileSync(RECON + '/patch-notes.json', 'utf8'));
const events = JSON.parse(fs.readFileSync(RECON + '/world-events.json', 'utf8'));

console.log('fetching manifests...');
const icons = await jget(`${BASE}/art/icons/manifest.json`);
const mons = await jget(`${BASE}/art/monsters/manifest.json`);
const classes = await jget(`${BASE}/art/classes/manifest.json`);
const spirits = await jget(`${BASE}/art/spirits/manifest.json`);
console.log(`manifests: icons.items=${Object.keys(icons.items).length} icons.skills=${Object.keys(icons.skills).length} monsters=${Object.keys(mons).length} classes=${Object.keys(classes).length} spirits=${Object.keys(spirits).length}`);

// ---------- build job list ----------
const jobs = [];
const D = (p) => path.join(WIKI, 'assets', p);
const add = (url, dest) => jobs.push({ url, dest });
for (const group of ['items', 'itemKeys', 'skills', 'ui']) {
  for (const rel of new Set(Object.values(icons[group] ?? {}))) add(`${BASE}/art/icons/${rel}`, D('art/icons/' + rel));
}
for (const m of Object.values(mons)) add(`${BASE}/art/monsters/${m.file}`, D('art/monsters/' + m.file));
add(`${BASE}/art/monsters/anims.json`, D('art/monsters/anims.json'));
for (const c of Object.values(classes)) {
  for (const key of ['full', 'face']) {
    if (c[key]) add(`${BASE}/art/classes/${c[key]}`, D('art/classes/' + c[key]));
    if (c.female?.[key]) add(`${BASE}/art/classes/${c.female[key]}`, D('art/classes/' + c.female[key]));
  }
}
const cardIds = wikiData.items.filter((i) => i.type === 'Card').map((i) => i.id);
for (const id of cardIds) add(`${BASE}/art/cards/${id}.webp`, D(`art/cards/${id}.webp`));
const NPCS = ['arena-master', 'armorer-hilda', 'auctioneer', 'bag-merchant', 'beauty-shop', 'blacksmith-enok', 'card-alchemist', 'event-lily', 'farmer-ploy', 'healer-mira', 'kafra', 'lucky-lulu', 'shopkeeper-bor', 'training-master', 'valkyrie', 'wise-witch'];
for (const s of NPCS) {
  add(`${BASE}/art/npcs/portraits/${s}.webp`, D(`art/npcs/portraits/${s}.webp`));
  add(`${BASE}/art/npcs/${s}-face.webp`, D(`art/npcs/${s}-face.webp`));
}
for (const n of [1, 2, 3, 4]) {
  add(`${BASE}/art/world/ui/globe-${n}.webp`, D(`art/world/ui/globe-${n}.webp`));
  add(`${BASE}/art/world/atlas-world${n}.webp`, D(`art/world/atlas-world${n}.webp`));
}
for (const e of events) if (e.banner) add(`${BASE}/art/${e.banner}`, D('art/' + e.banner));
const LOADING = ['capital', 'egg-hall', 'meadow', 'forest', 'water', 'snow', 'cave', 'dark', 'ruins'];
for (const n of LOADING) add(`${BASE}/art/loading/${n}.webp`, D(`art/loading/${n}.webp`));
// mapId -> biome (extracted from the client bundle's loading-screen table)
const MAP_BIOME = {
  capital: 'capital', capital_market: 'capital', egg_hall: 'egg-hall', novice_garden: 'meadow', field_01: 'meadow', clover_meadow: 'meadow', sun_farm: 'meadow',
  willow_road: 'meadow', verdant_basin: 'meadow', moon_forest: 'forest', goblin_trail: 'forest', orc_camp: 'forest', azure_lake: 'water', coral_coast: 'water',
  frost_pass: 'snow', gale_high: 'snow', crystal_mine: 'cave', ember_cavern: 'cave', shadow_crypt: 'dark', venom_swamp: 'dark', anc_ruins: 'ruins',
};
for (const s of Object.values(spirits)) for (const v of Object.values(s.views ?? {})) if (v?.file) add(`${BASE}/art/spirits/${v.file}`, D('art/spirits/' + v.file));

console.log(`jobs: ${jobs.length}`);

// ---------- download pool ----------
let ok = 0, skip = 0, done = 0; const failed = [];
const fetchTo = async (j) => {
  const r = await fetch(j.url);
  if (!r.ok) throw new Error(String(r.status));
  const b = Buffer.from(await r.arrayBuffer());
  fs.mkdirSync(path.dirname(j.dest), { recursive: true });
  fs.writeFileSync(j.dest, b);
};
const worker = async () => {
  while (jobs.length) {
    const j = jobs.shift();
    if (fs.existsSync(j.dest)) { skip++; done++; continue; }
    try { await fetchTo(j); ok++; }
    catch (e) {
      if (String(e.message) !== '404') { try { await fetchTo(j); ok++; } catch (e2) { failed.push(`${j.url} (${e2.message})`); } }
      else failed.push(`${j.url} (404)`);
    }
    done++;
    if (done % 250 === 0) console.log(`  …${done} files (ok=${ok} skip=${skip} fail=${failed.length})`);
  }
};
await Promise.all(Array.from({ length: 10 }, worker));
console.log(`downloads done: ok=${ok} skipped=${skip} failed=${failed.length}`);
for (const f of failed.slice(0, 12)) console.log('  fail: ' + f);
fs.writeFileSync(WIKI + '/scrape-failures.txt', failed.join('\n'));

// ---------- monster thumbs (first frame crop when sheet is a clean horizontal strip) ----------
fs.mkdirSync(WIKI + '/assets/thumbs/monsters', { recursive: true });
let thumbs = 0;
for (const [id, m] of Object.entries(mons)) {
  const src = D('art/monsters/' + m.file);
  if (!fs.existsSync(src)) continue;
  try {
    const meta = await sharp(src).metadata();
    const w = meta.width ?? 0, h = meta.height ?? 0;
    let buf;
    if (w && h && w % h === 0 && w / h >= 2) buf = await sharp(src).extract({ left: 0, top: 0, width: h, height: h }).resize({ height: 96 }).webp().toBuffer();
    else buf = await sharp(src).resize({ height: 96 }).webp().toBuffer();
    fs.writeFileSync(`${WIKI}/assets/thumbs/monsters/${id}.webp`, buf);
    thumbs++;
  } catch {}
}
console.log('monster thumbs:', thumbs);

// ---------- data.json ----------
const A = (rel) => ('assets/' + rel).replace(/\\/g, '/');
const has = (p) => fs.existsSync(path.join(WIKI, 'assets', p));
const items = wikiData.items.map((i) => {
  const rel = icons.items[String(i.id)];
  return {
    id: i.id, name: i.name, type: i.type ?? null, rarity: i.rarity ?? null, sellPrice: i.sellPrice ?? null, weight: i.weight ?? null,
    equipLevelMin: i.equipLevelMin ?? null, equipmentType: i.equipmentType && i.equipmentType !== 'None' ? i.equipmentType : null,
    weaponType: i.weaponType && i.weaponType !== 'None' ? i.weaponType : null, slots: i.slots ?? null, description: i.description ?? null,
    attributes: i.attributes ?? [], effects: i.effects ?? [], jobs: i.jobs ?? [], droppedBy: i.droppedBy ?? [], soldBy: i.soldBy ?? [],
    icon: rel ? A('art/icons/' + rel) : null,
    cardArt: has(`art/cards/${i.id}.webp`) ? A(`art/cards/${i.id}.webp`) : null,
  };
});
const monsters = wikiData.monsters.map((m) => {
  const man = mons[String(m.id)] ?? mons[String(m.monsterId)] ?? null;
  return {
    id: m.id, name: m.name, level: m.level ?? null, hp: m.hp ?? null, atk: m.atk ?? null, atkMax: m.atkMax ?? null, def: m.def ?? null, mdef: m.mdef ?? null,
    exp: m.exp ?? null, jobExp: m.jobExp ?? null, element: m.element ?? null, elementLevel: m.elementLevel ?? null, race: m.race ?? null, size: m.size ?? null,
    attackDelayMs: m.attackDelayMs ?? null, attackRangeTiles: m.attackRangeTiles ?? null, walkSpeed: m.walkSpeed ?? null, stats: m.stats ?? null,
    drops: m.drops ?? [], spawns: m.spawns ?? [], trainingDummy: !!m.trainingDummy,
    sheet: man && has('art/monsters/' + man.file) ? A('art/monsters/' + man.file) : null,
    thumb: has(`thumbs/monsters/${m.id}.webp`) ? A(`thumbs/monsters/${m.id}.webp`) : null,
  };
});
const skills = wikiData.skills.map((s) => {
  const rel = icons.skills[String(s.id)];
  return { id: s.id, name: s.name, classId: s.classId ?? null, maxLevel: s.maxLevel ?? null, kind: s.kind ?? null, target: s.target ?? null, icon: rel ? A('art/icons/' + rel) : null };
});
const classesData = Object.entries(classes).map(([id, c]) => ({
  id, name: wikiData.classes?.find((x) => x.id === id)?.name ?? id,
  face: c.face && has('art/classes/' + c.face) ? A('art/classes/' + c.face) : null,
  full: c.full && has('art/classes/' + c.full) ? A('art/classes/' + c.full) : null,
  femaleFace: c.female?.face && has('art/classes/' + c.female.face) ? A('art/classes/' + c.female.face) : null,
  femaleFull: c.female?.full && has('art/classes/' + c.female.full) ? A('art/classes/' + c.female.full) : null,
}));
const npcs = NPCS.map((s) => ({
  slug: s, name: s.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '),
  portrait: has(`art/npcs/portraits/${s}.webp`) ? A(`art/npcs/portraits/${s}.webp`) : null,
  face: has(`art/npcs/${s}-face.webp`) ? A(`art/npcs/${s}-face.webp`) : null,
}));
const loading = LOADING.filter((n) => has(`art/loading/${n}.webp`)).map((n) => ({ name: n, img: A(`art/loading/${n}.webp`) }));
const world = {
  atlas: [1, 2, 3, 4].filter((n) => has(`art/world/atlas-world${n}.webp`)).map((n) => ({ world: n, img: A(`art/world/atlas-world${n}.webp`) })),
  globes: [1, 2, 3, 4].filter((n) => has(`art/world/ui/globe-${n}.webp`)).map((n) => ({ world: n, img: A(`art/world/ui/globe-${n}.webp`) })),
};
// maps + spawn aggregation
const maps = (wikiData.maps ?? []).map((mp) => {
  const ms = monsters.filter((m) => m.spawns.some((s) => s.mapId === mp.id)).map((m) => ({
    id: m.id, name: m.name, level: m.level, thumb: m.thumb,
    areas: [...new Set(m.spawns.filter((s) => s.mapId === mp.id).map((s) => `${s.area ?? ''} ×${s.count ?? '?'}`))],
  }));
  return { id: mp.id, name: mp.name ?? mp.id, loading: loading.find((l) => l.name === MAP_BIOME[mp.id])?.img ?? null, monsters: ms };
});
const data = {
  generatedAt: new Date().toISOString(), source: BASE,
  counts: { items: items.length, monsters: monsters.length, skills: skills.length, classes: classesData.length, maps: maps.length, npcs: npcs.length },
  items, monsters, skills, classes: classesData, npcs, maps, world, loading, events, patchNotes,
};
fs.writeFileSync(WIKI + '/data.json', JSON.stringify(data));
console.log(`data.json: items=${items.length} withIcon=${items.filter((i) => i.icon).length} monsters=${monsters.length} withSheet=${monsters.filter((m) => m.sheet).length} skills=${skills.length} classes=${classesData.length} maps=${maps.length}`);
console.log('WIKI READY at', WIKI);
