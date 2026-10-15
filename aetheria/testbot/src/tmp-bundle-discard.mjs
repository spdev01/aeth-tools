// tmp-bundle-discard.mjs — find the inv_destroy (discard) payload + UI flow (safe to delete)
import fs from 'node:fs';
const b = fs.readFileSync(process.env.TEMP + '/aetheria-bundle.js', 'utf8');
for (const p of ['inv_destroy', 'destroy(', 'ทิ้ง', 'inv_lock']) {
  const idx = [];
  let i = b.indexOf(p);
  while (i >= 0 && idx.length < 5) { idx.push(i); i = b.indexOf(p, i + 1); }
  console.log('===== ' + p + ' (' + idx.length + ') =====');
  for (const j of idx) {
    console.log(b.slice(Math.max(0, j - 400), j + 400).replace(/\n/g, ' '));
    console.log('-----');
  }
}
