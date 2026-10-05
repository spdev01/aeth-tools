// full pet/collection flow: message handlers, pets store, egg item actions
import fs from 'node:fs';
const c = fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/index-main.js', 'utf8');
const show = (label, i, back = 300, len = 700) => {
  if (i < 0) { console.log(`\n${label}: NOT FOUND`); return; }
  console.log(`\n### ${label} @${i}: ${c.substring(Math.max(0, i - back), i - back + len).replace(/\s+/g, ' ')}`);
};
// collection message + pet data usage
let pos = 0, n = 0;
while ((pos = c.indexOf('`collection`', pos)) >= 0 && n < 3) { show('collection-msg#' + n, pos); pos += 5; n++; }
pos = 0; n = 0;
while ((pos = c.indexOf('pets', pos)) >= 0 && n < 8) { show('pets#' + n, pos, 200, 380); pos += 4; n++; }
show('eggItemId', c.indexOf('eggItemId'));
show('setPet(', c.indexOf('setPet('));
// item use / menu logic for eggs: search type 'Egg' / 'Pet'
for (const m of ["`Egg`", "'Egg'", '`Pet`', 'petId:', 'hatch']) show(m, c.indexOf(m));
// where does client send pet-related on egg click? search 'pet' room.send beyond pet_set
pos = 0; n = 0;
while ((pos = c.indexOf("send(`pet", pos)) >= 0 && n < 6) { show('send-pet#' + n, pos); pos += 5; n++; }
