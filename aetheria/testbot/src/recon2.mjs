// Recon 2: startRoute / mapLinks / portal walking
import fs from 'node:fs';
const c = fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/index-main.js', 'utf8');
const show = (label, i, back = 100, len = 1200) => {
  console.log(`=== ${label} @ ${i} ===`);
  if (i >= 0) console.log(c.substring(Math.max(0, i - back), Math.max(0, i - back) + len).replace(/\s+/g, ' '));
};
// find definition: "startRoute(" occurrences (all)
let pos = 0, n = 0;
while ((pos = c.indexOf('startRoute(', pos)) >= 0 && n < 6) { show('startRoute#' + n, pos, 60, 500); pos += 10; n++; }
// mapLinks usage
pos = 0; n = 0;
while ((pos = c.indexOf('mapLinks', pos)) >= 0 && n < 8) { show('mapLinks#' + n, pos, 120, 420); pos += 8; n++; }
// look for map links fetch
for (const m of ['links.json', 'map-links', 'mapLinks:', 'worldMap', '/maps/']) {
  const i = c.indexOf(m); show(m, i, 150, 500);
}
// world_atlas structure
const atlas = JSON.parse(fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/world_atlas.json', 'utf8'));
console.log('=== world_atlas keys ===', Object.keys(atlas).slice(0, 20));
const str = JSON.stringify(atlas);
console.log('atlas size', str.length);
console.log('sample', str.substring(0, 400));
