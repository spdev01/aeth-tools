// how does the client cast combat skills? (useHotbar -> send)
import fs from 'node:fs';
const c = fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/index-main.js', 'utf8');
const show = (label, i, back = 300, len = 700) => {
  console.log(`\n=== ${label} @ ${i} ===`);
  if (i >= 0) console.log(c.substring(Math.max(0, i - back), Math.max(0, i - back) + len).replace(/\s+/g, ' '));
};
let pos = 0, n = 0;
while ((pos = c.indexOf('useHotbar', pos)) >= 0 && n < 4) { show('useHotbar#' + n, pos); pos += 10; n++; }
for (const m of ['`use_skill`', '`skill_use`', '`cast_skill`', '`hotbar_use`', 'startCast', '`skill`']) { show(m, c.indexOf(m)); }
// how the aim/cast happens for attack skills: search send patterns with skillId near 'target'
pos = 0; n = 0;
while ((pos = c.indexOf("skillId", pos)) >= 0 && n < 30) {
  const seg = c.substring(pos - 200, pos + 200);
  if (/send\(/.test(seg)) { console.log(`\n>>> send+skillId @ ${pos}:`, seg.replace(/\s+/g, ' ')); n++; }
  pos += 7;
}
