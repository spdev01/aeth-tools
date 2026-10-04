// find the real refine payload from the game bundle
import fs from 'node:fs';
const c = fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/index-main.js', 'utf8');
let pos = 0, n = 0;
console.log('=== refineItem( call sites ===');
while ((pos = c.indexOf('refineItem(', pos)) >= 0 && n < 8) {
  console.log(`\n#${n} @ ${pos}:`);
  console.log(c.substring(Math.max(0, pos - 500), pos + 300).replace(/\s+/g, ' '));
  pos += 11; n++;
}
console.log('\n=== refine send payload area ===');
pos = c.indexOf('send(`refine`');
console.log(c.substring(Math.max(0, pos - 700), pos + 300).replace(/\s+/g, ' '));
console.log('\n=== refine window selection state (refineSel/refineSource) ===');
for (const m of ['refineSlot', 'refineSource', 'refineSel', 'setRefine', 'refine &&']) {
  const i = c.indexOf(m);
  if (i >= 0) { console.log(`\n-- ${m} @ ${i}:`); console.log(c.substring(Math.max(0, i - 350), i + 350).replace(/\s+/g, ' ')); }
}
