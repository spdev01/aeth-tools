// wiki-fetch.mjs — build-time mirror for the Mob Map wiki page (mob-map.html).
//   - GET /wiki-data                    → fallback snapshot (the page PREFERS a live browser fetch;
//                                         /wiki-data reflects our Pages origin in CORS, verified)
//   - GET /maps/<id>.json (all maps with monster spawns) → numbered monsterArea zones
//     (พื้นที่ N = N-th object with type "monsterArea" in the object layer, in JSON order)
//   - GET /maps/<minimapImage>          → map thumbnails (same-origin <img>, no CORS issues)
// Output: _site/wiki/data/{wiki-data.json, areas.json, version.json, maps/<id>.webp}
//
// Run AFTER aetheria/tools/assemble-site.mjs (assemble wipes _site). CI step: publish.yml.
// Local: node aetheria/tools/assemble-site.mjs && node aetheria/tools/wiki-fetch.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const OUT = path.join(REPO, '_site', 'wiki', 'data');
const MAPS_DIR = path.join(OUT, 'maps');
const BASE = 'https://www.aetheria-online.in.th';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 3) {
  let err = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      err = e;
      await sleep(700);
    }
  }
  throw err;
}
async function getBin(url, tries = 3) {
  let err = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const type = r.headers.get('content-type') || '';
      if (/text\/html/i.test(type)) throw new Error('html fallback (asset missing)');
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 500) throw new Error('too small: ' + buf.length);
      return buf;
    } catch (e) {
      err = e;
      await sleep(700);
    }
  }
  throw err;
}

fs.mkdirSync(MAPS_DIR, { recursive: true });

console.log('wiki-fetch: GET /wiki-data …');
const wiki = await getJson(`${BASE}/wiki-data`);
fs.writeFileSync(path.join(OUT, 'wiki-data.json'), JSON.stringify(wiki));
console.log(`wiki-fetch: wiki-data snapshot saved (${wiki.monsters?.length ?? '?'} monsters, ${wiki.maps?.length ?? '?'} maps)`);

// every map that has at least one monster spawn row
const mapIds = new Set();
for (const m of wiki.monsters || []) for (const s of m.spawns || []) if (s.mapId) mapIds.add(s.mapId);

const areas = {
  fetchedAt: new Date().toISOString(),
  source: { base: BASE, wikiGeneratedAt: wiki.generatedAt ?? null },
  maps: {},
};
const errors = [];
let okMinis = 0;

for (const id of [...mapIds].sort()) {
  try {
    const tm = await getJson(`${BASE}/maps/${id}.json`);
    // numbered spawn zones: object type "monsterArea", array order = พื้นที่ 1..N
    const zones = [];
    for (const L of tm.layers || []) {
      if (L.type !== 'objectgroup') continue;
      for (const o of L.objects || []) {
        if ((o.type || '') !== 'monsterArea') continue;
        const props = Object.fromEntries((o.properties || []).map((p) => [p.name, p.value]));
        const mobs = String(props.monsters || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((pair) => {
            const [mid, n] = pair.split(':');
            return { id: Number(mid), n: Number(n || 0) };
          });
        zones.push({
          i: zones.length + 1,
          name: o.name || 'area' + (zones.length + 1),
          x: Number(o.x || 0),
          y: Number(o.y || 0),
          w: Number(o.width || 0),
          h: Number(o.height || 0),
          count: Number(props.count || 0),
          mobs,
        });
      }
    }
    if (!zones.length) continue; // not a spawn map

    const mprops = Object.fromEntries((tm.properties || []).map((p) => [p.name, p.value]));
    let mini = null;
    const miniFile = mprops.minimapImage;
    if (miniFile) {
      try {
        const buf = await getBin(`${BASE}/maps/${miniFile}`);
        fs.writeFileSync(path.join(MAPS_DIR, `${id}.webp`), buf);
        mini = `maps/${id}.webp`;
        okMinis++;
      } catch (e) {
        errors.push(`${id} minimap: ${e.message}`);
      }
    }
    areas.maps[id] = {
      name: mprops.displayName || id,
      width: Number(tm.width || 0),
      height: Number(tm.height || 0),
      tileW: Number(tm.tilewidth || 32),
      tileH: Number(tm.tileheight || 32),
      mini,
      areas: zones,
    };
    console.log(`wiki-fetch: ${id} — ${zones.length} areas${mini ? ' + minimap' : ''}`);
  } catch (e) {
    errors.push(`${id}: ${e.message}`);
  }
}

areas.stats = {
  maps: Object.keys(areas.maps).length,
  areas: Object.values(areas.maps).reduce((n, m) => n + m.areas.length, 0),
  minimaps: okMinis,
  errors: errors.length,
};
fs.writeFileSync(path.join(OUT, 'areas.json'), JSON.stringify(areas));
fs.writeFileSync(
  path.join(OUT, 'version.json'),
  JSON.stringify(
    {
      fetchedAt: areas.fetchedAt,
      wikiGeneratedAt: areas.source.wikiGeneratedAt,
      stats: areas.stats,
      errors: errors.slice(0, 25),
    },
    null,
    2,
  ),
);

console.log(`wiki-fetch: done — ${areas.stats.maps} maps / ${areas.stats.areas} areas / ${okMinis} minimaps, ${errors.length} errors`);
if (errors.length) console.log(errors.slice(0, 8).join('\n'));
