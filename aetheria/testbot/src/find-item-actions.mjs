// all inv_use / equip call sites + item action menu logic
import fs from 'node:fs';
const c = fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/index-main.js', 'utf8');
let pos = 0, n = 0;
console.log('=== inv_use call sites ===');
while ((pos = c.indexOf('inv_use', pos)) >= 0 && n < 10) {
  console.log(`\ninv_use@${pos}: ${c.substring(pos - 300, pos + 120).replace(/\s+/g, ' ')}`);
  pos += 7; n++;
}
pos = 0; n = 0;
console.log('\n=== equip call sites (send) ===');
while ((pos = c.indexOf("send(`equip", pos)) >= 0 && n < 10) {
  console.log(`\nequip@${pos}: ${c.substring(pos - 300, pos + 120).replace(/\s+/g, ' ')}`);
  pos += 7; n++;
}
// item detail / menu with 'Use' text (ใช้งาน)
pos = 0; n = 0;
console.log('\n=== ใช้งาน (use) usage in item menus ===');
while ((pos = c.indexOf('ใช้งาน', pos)) >= 0 && n < 10) {
  console.log(`\nuse@${pos}: ${c.substring(pos - 260, pos + 200).replace(/\s+/g, ' ')}`);
  pos += 6; n++;
}
