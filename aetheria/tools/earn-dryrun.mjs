// Dry-run the earnings tracker against the live command-center data (safe: read-only for bot logs;
// writes only data/earnings.json — seeding it makes the CC's first sweep fast and consistent).
import { initWiki, getWiki } from '../command-center/server/wiki.js';
import { EarningsTracker } from '../command-center/server/earnings.js';

const BASE = 'E:/GitHub/lumivaraonline/aetheria/command-center/data';
await initWiki();
const tr = new EarningsTracker({ botsDir: BASE + '/bots', dataFile: BASE + '/earnings.json' });
const t0 = Date.now();
await tr.sweep();
console.log(`wiki=${!!getWiki()}  prices=${tr._price.size}  sweep took ${((Date.now() - t0) / 1000).toFixed(1)}s  bots scanned=${Object.keys(tr.data.bots).length}`);

const s = tr.summaryFor(213);
console.log('bot213 summary:', JSON.stringify(s));
const d = tr.detailFor(213, { hours: 24 });
console.log('bot213 hourly (non-empty):');
for (const h of d.hours) {
  if (h.q || h.v || h.e || h.k) console.log(`  ${h.h}  est=${String(h.v).padStart(11)}  earned=${String(h.e).padStart(11)}  moved=${String(h.s).padStart(9)}  kills=${String(h.k).padStart(5)}  drops=${String(h.q).padStart(4)}  cards=${h.c}`);
}
console.log('bot213 totals:', JSON.stringify(d.totals));
tr.save();
console.log('saved OK');
