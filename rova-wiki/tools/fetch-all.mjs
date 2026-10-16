// fetch-all.mjs — download every raw dataset the wiki needs, via Tor only.
//
// Sources (rovaonline.net):
//   /api/meta                  -> content version hash
//   /api/wiki/full             -> mobs+drops, maps+spawns, shops, quests, boxes, src  (guest session needed)
//   /api/wiki/index            -> lean index (cardmob mapping etc.)
//   /content/client.json?hot=  -> native item db (sell prices), zones
//   /content/item_icons.json   -> item id -> icon filename (/pub/ui/<file>)
//   /content/item_facts.json   -> item effect facts (heal etc.)
//   /content/locales/{en,th}.json -> mob names, zone names, wiki labels
//
// Usage:
//   node tools/fetch-all.mjs            # fetch what is missing
//   node tools/fetch-all.mjs --force    # re-fetch everything
//
// Guest token: reuses rova/recon/dev/dev-session.json (mint one with
// `node rova/tools/dev-connect.mjs` if expired -> /api/wiki/full returns 401).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { torFetchText } from '../../rova/tools/tor-net.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const rawDir = path.resolve(here, '..', 'data', 'raw');
fs.mkdirSync(rawDir, { recursive: true });

const force = process.argv.includes('--force');
const BASE = 'https://rovaonline.net';
const PORT = Number(process.env.ROVA_WIKI_PORT || 21000);

async function get(url, { headers = {}, raw = false, timeoutMs = 300000, tag } = {}) {
  const r = await torFetchText(url, { port: PORT, headers, timeoutMs });
  if (r.status !== 200) throw new Error(`${tag || url} -> HTTP ${r.status}: ${r.body.slice(0, 200)}`);
  return raw ? r.body : JSON.parse(r.body);
}

function save(name, text) {
  fs.writeFileSync(path.join(rawDir, name), text);
  console.log(`  saved ${name} (${(text.length / 1024).toFixed(0)} KB)`);
}
const has = (name) => fs.existsSync(path.join(rawDir, name));

// ---- 1. meta (content hash) ----
console.log('[1/7] /api/meta');
const metaPath = path.join(rawDir, 'meta.json');
let contentHash = '';
if (!force && has('meta.json')) {
  contentHash = JSON.parse(fs.readFileSync(metaPath, 'utf8')).content || '';
  console.log(`  cached (content ${contentHash})`);
} else {
  const meta = await get(`${BASE}/api/meta`, { tag: 'meta' });
  contentHash = meta.content;
  save('meta.json', JSON.stringify(meta, null, 1));
  console.log(`  content hash ${contentHash}`);
}

// ---- 2. wiki full (guest session token) ----
console.log('[2/7] /api/wiki/full');
if (force || !has('wiki-full.json')) {
  const devSession = path.resolve(here, '..', '..', 'rova', 'recon', 'dev', 'dev-session.json');
  let token = null;
  try { token = JSON.parse(fs.readFileSync(devSession, 'utf8')).token; } catch {}
  if (!token) {
    console.error(`  FAIL: no guest token at ${devSession} - run: node rova/tools/dev-connect.mjs`);
    process.exit(1);
  }
  const full = await get(`${BASE}/api/wiki/full`, { headers: { Authorization: `Bearer ${token}` }, tag: 'wiki/full' });
  save('wiki-full.json', JSON.stringify(full));
} else console.log('  cached');

// ---- 3. wiki index (lean; cardmob etc.) ----
console.log('[3/7] /api/wiki/index');
if (force || !has('wiki-index.json')) {
  const idx = await get(`${BASE}/api/wiki/index`, { tag: 'wiki/index' });
  save('wiki-index.json', JSON.stringify(idx));
} else console.log('  cached');

// ---- 4. client.json (native item db) ----
console.log('[4/7] /content/client.json');
if (force || !has('client.json')) {
  const c = await get(`${BASE}/content/client.json${contentHash ? `?hot=${encodeURIComponent(contentHash)}` : ''}`, { tag: 'client.json' });
  save('client.json', JSON.stringify(c));
} else console.log('  cached');

// ---- 5. item icons + facts ----
console.log('[5/7] /content/item_icons.json + item_facts.json');
for (const [file, url] of [['item_icons.json', 'item_icons'], ['item_facts.json', 'item_facts']]) {
  if (force || !has(file)) {
    const j = await get(`${BASE}/content/${url}.json`, { tag: url });
    save(file, JSON.stringify(j));
  } else console.log(`  cached ${file}`);
}

// ---- 6. locales ----
console.log('[6/7] /content/locales/{en,th}.json');
for (const loc of ['en', 'th']) {
  if (force || !has(`locale-${loc}.json`)) {
    const j = await get(`${BASE}/content/locales/${loc}.json`, { tag: `locale-${loc}` });
    save(`locale-${loc}.json`, JSON.stringify(j));
  } else console.log(`  cached locale-${loc}.json`);
}

// ---- 7. summary ----
console.log('[7/7] done');
for (const f of fs.readdirSync(rawDir).sort()) {
  const s = fs.statSync(path.join(rawDir, f));
  console.log(`  ${f.padEnd(20)} ${(s.size / 1024).toFixed(0).padStart(7)} KB`);
}
