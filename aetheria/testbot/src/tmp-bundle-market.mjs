// tmp-bundle-market.mjs — what ops does the `market` message accept? (safe to delete)
import fs from 'node:fs';
const b = fs.readFileSync(process.env.TEMP + '/aetheria-bundle.js', 'utf8');
// 1) every distinct op:`xxx` in the whole bundle
const ops = new Set();
for (const m of b.matchAll(/op:`([a-z_]+)`/g)) ops.add(m[1]);
console.log('=== distinct op:`x` values in bundle ===');
console.log([...ops].sort().join(', '));
// 2) marketAction( call sites with context
console.log('\n=== marketAction( call sites (up to 8) ===');
const idx = [];
let i = b.indexOf('marketAction(');
while (i >= 0 && idx.length < 8) { idx.push(i); i = b.indexOf('marketAction(', i + 1); }
for (const j of idx) { console.log(b.slice(Math.max(0, j - 260), j + 260).replace(/\n/g, ' ')); console.log('-----'); }
// 3) listing / sell-on-market flow keywords
for (const p of ['op:`list`', 'op:`buy`', 'op:`collect`', 'op:`cancel`', 'op:`sell`', 'marketListing', 'listItem', 'ลิสต์', 'ลงขาย']) {
  const k = b.indexOf(p);
  console.log(`=== ${p} @ ${k} ===`);
  if (k >= 0) console.log(b.slice(Math.max(0, k - 300), k + 300).replace(/\n/g, ' '));
}
