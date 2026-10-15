// Print every 'respawn' occurrence in the game bundle with context (find the X.respawn implementation)
import fs from 'node:fs';
const t = fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/index-main.js', 'utf8');
const hits = [];
let i = -1;
while ((i = t.indexOf('respawn', i + 1)) !== -1) hits.push(i);
console.log('occurrences:', hits.length);
for (const h of hits) {
  const ctx = t.slice(Math.max(0, h - 150), h + 200).replace(/\s+/g, ' ');
  console.log('--- @' + h + ': ' + ctx);
  console.log();
}
