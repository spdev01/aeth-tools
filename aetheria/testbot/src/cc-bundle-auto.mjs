// cc-bundle-auto.mjs — print regions of the game bundle around the auto-mode monster config code
import fs from 'node:fs';
const t = fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/index-main.js', 'utf8');
const all = (needle, w = 700, max = 6) => {
  let i = 0, n = 0;
  while ((i = t.indexOf(needle, i)) >= 0 && n < max) {
    console.log(`\n=== '${needle}' @${i} ===`);
    console.log(t.slice(Math.max(0, i - w), i + w).replace(/\s+/g, ' '));
    i += needle.length; n++;
  }
  if (!n) console.log(`\nNOT FOUND: ${needle}`);
};
all('หามอน', 900, 4);
all('monsters:', 600, 8);
all('monsterIds', 400, 6);
all('setAuto(', 500, 6);
