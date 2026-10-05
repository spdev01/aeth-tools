// how does the client hatch pet eggs / handle pets?
import fs from 'node:fs';
const c = fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/index-main.js', 'utf8');
const show = (label, i, back = 260, len = 500) => {
  if (i < 0) { console.log(`\n${label}: NOT FOUND`); return; }
  console.log(`\n### ${label} @${i}: ${c.substring(Math.max(0, i - back), i - back + len).replace(/\s+/g, ' ')}`);
};
show('hatch-thai ฟัก', c.indexOf('ฟัก'));
show('incubat', c.indexOf('incubat'));
show('hatch(en)', c.indexOf('hatch'));
show('inv_use', c.indexOf('inv_use'));
// pet messages
for (const m of ['pet_set', 'pet_take', 'pet_rename', 'pet_hatch', 'pet_equip', 'pet_use', '`pet`']) show(m, c.indexOf(m));
// search for egg item handling: "egg" near "type"
let pos = 0, n = 0;
while ((pos = c.indexOf('egg', pos)) >= 0 && n < 10) {
  const seg = c.substring(pos - 160, pos + 160);
  if (/type|equip|use|item/i.test(seg)) { console.log(`\negg@${pos}: ${seg.replace(/\s+/g, ' ')}`); n++; }
  pos += 3;
}
// pet panel UI: find 'pet' renders
pos = 0; n = 0;
while ((pos = c.indexOf('pet-', pos)) >= 0 && n < 8) {
  console.log(`\npet-@${pos}: ${c.substring(pos - 200, pos + 260).replace(/\s+/g, ' ')}`);
  pos += 4; n++;
}
