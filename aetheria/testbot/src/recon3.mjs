// Recon 3: zones + mapLinks structure + tilemap fetch + portal mechanics
import fs from 'node:fs';
const atlas = JSON.parse(fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/world_atlas.json', 'utf8'));
console.log('=== zones ===');
console.log(JSON.stringify(atlas.zones, null, 1).substring(0, 2500));
console.log('=== mapLinks structure (sample) ===');
console.log(JSON.stringify(atlas.mapLinks).substring(0, 1200));
console.log('=== links count ===', atlas.links.length);

const c = fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/index-main.js', 'utf8');
const show = (label, i, back = 150, len = 700) => {
  console.log(`=== ${label} @ ${i} ===`);
  if (i >= 0) console.log(c.substring(Math.max(0, i - back), Math.max(0, i - back) + len).replace(/\s+/g, ' '));
};
for (const m of ['tilemapTiledJSON', 'warp:', 'spawnPoint', 'portal', '`map:`']) {
  show(m, c.indexOf(m));
}
// how route finds the walk target: search "this.route" walking code
let pos = 0, n = 0;
while ((pos = c.indexOf('this.route.', pos)) >= 0 && n < 8) { show('route#' + n, pos, 200, 500); pos += 8; n++; }
