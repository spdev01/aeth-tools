// Recon 8: travel listener -> rejoin call
import fs from 'node:fs';
const c = fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/index-main.js', 'utf8');
const show = (label, i, back, len) => {
  console.log(`=== ${label} @ ${i} ===`);
  if (i >= 0) console.log(c.substring(Math.max(0, i - back), Math.max(0, i - back) + len).replace(/\s+/g, ' '));
  else console.log('(not found)');
};
let pos = 0, n = 0;
while ((pos = c.indexOf('onTravel(', pos)) >= 0 && n < 8) { show('onTravel#' + n, pos, 150, 600); pos += 9; n++; }
pos = 0; n = 0;
while ((pos = c.indexOf('travelListeners', pos)) >= 0 && n < 10) { show('tl#' + n, pos, 100, 320); pos += 15; n++; }
show('joinById game usage', c.indexOf('joinById(', c.indexOf('joinById(') + 10), 300, 800);
