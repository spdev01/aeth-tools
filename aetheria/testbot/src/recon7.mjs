// Recon 7: how the game handles the travel message + reservation errors
import fs from 'node:fs';
const c = fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/index-main.js', 'utf8');
const show = (label, i, back, len) => {
  console.log(`=== ${label} @ ${i} ===`);
  if (i >= 0) console.log(c.substring(Math.max(0, i - back), Math.max(0, i - back) + len).replace(/\s+/g, ' '));
  else console.log('(not found)');
};
let pos = 0, n = 0;
while ((pos = c.indexOf('`travel`', pos)) >= 0 && n < 6) { show('travel#' + n, pos, 120, 700); pos += 8; n++; }
show('seat reservation', c.indexOf('seat reservation'), 200, 400);
show('joinById', c.indexOf('joinById'), 250, 700);
show('consumeSeatReservation game', c.indexOf('consumeSeatReservation'), 400, 1100);
