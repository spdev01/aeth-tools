// fetch-icons.mjs — optional: mirror every item icon locally (public/icons/) via Tor.
// After running this, the UI automatically uses the local copies (no game host access while browsing).
//
// Usage:
//   node tools/fetch-icons.mjs            # fetch missing icons
//   node tools/fetch-icons.mjs --force    # refresh all
// Notes:
//   - rides both house circuits (21000 / 22000) with a small worker pool
//   - safe to re-run: it resumes from disk and stops early on repeated failures
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { torFetchText } from '../../rova/tools/tor-net.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(here, '..', 'public', 'data', 'rova-db.json');
const outDir = path.resolve(here, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const force = process.argv.includes('--force');
const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

const wanted = [];
for (const [, it] of Object.entries(db.items)) {
  if (it.i) wanted.push({ url: `/pub/ui/${encodeURIComponent(it.i)}`, dest: path.join(outDir, it.i) });
}
for (const m of db.mobs) {
  if (m.sheet) wanted.push({ url: `/pub/mob/${encodeURIComponent(m.sheet)}.png`, dest: path.join(outDir, 'mob', `${m.sheet}.png`) });
}
console.log(`assets referenced by db: ${wanted.length} (items + mobs)`);

const PORTS = [21000, 22000];
const WORKERS = 8;
let done = 0, skipped = 0, failed = 0;
const queue = [...wanted];
const failStreak = { n: 0 };

async function fetchIcon(entry, port) {
  const { url, dest } = entry;
  if (!force && fs.existsSync(dest)) { skipped++; return; }
  const r = await torFetchText(`https://rovaonline.net${url}`, { port, timeoutMs: 60000, binary: true });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // binary mode: body is a latin1 string that maps 1:1 back to bytes
  fs.writeFileSync(dest, Buffer.from(r.body, 'latin1'));
  done++;
  failStreak.n = 0;
}

async function worker(wid) {
  const port = PORTS[wid % PORTS.length];
  while (queue.length) {
    if (failStreak.n >= 40) return; // circuit trouble; abort early
    const entry = queue.shift();
    try {
      await fetchIcon(entry, port);
      if ((done + skipped) % 100 === 0) console.log(`  ${done + skipped}/${wanted.length} (fetched ${done}, skipped ${skipped}, failed ${failed})`);
    } catch (e) {
      failed++;
      failStreak.n++;
      if (failed <= 20) console.log(`  fail ${entry.dest}: ${e.message}`);
    }
  }
}

const t0 = Date.now();
await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));
console.log(`\nfetched ${done}, already had ${skipped}, failed ${failed} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

// manifest flips the UI to local icons
const countPng = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.png')).length : 0;
const mobCount = countPng(path.join(outDir, 'mob'));
const itemCount = countPng(outDir);
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
  count: itemCount, mobs: mobCount, builtAt: new Date().toISOString(), source: 'rovaonline.net/pub', via: 'tor',
}, null, 1));
console.log(`wrote public/icons/manifest.json (${itemCount} item icons, ${mobCount} mob sprites) - the UI will now use local images`);
