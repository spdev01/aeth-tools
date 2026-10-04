// Recon 4: all zones compact + mapLinks edges + tilemap/portal code
import fs from 'node:fs';
const atlas = JSON.parse(fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/world_atlas.json', 'utf8'));
console.log('=== ZONES (id | name | level | mapId | type) ===');
for (const z of atlas.zones) {
  const lv = Array.isArray(z.level) ? z.level.join('-') : (z.level ?? '-');
  console.log(`${z.id} | ${z.name} | ${lv} | ${z.mapId ?? '-'} | ${z.type}`);
}
console.log('=== mapLinks ===');
const ml = atlas.mapLinks;
console.log('type:', Array.isArray(ml) ? 'array' : typeof ml, 'len:', ml.length);
console.log(JSON.stringify(ml).substring(0, 900));
console.log('=== links (pairs) ===');
console.log(atlas.links.map((l) => l.join(' -> ')).join('  ;  '));

const c = fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/index-main.js', 'utf8');
const grab = (label, m, back = 200, len = 650) => {
  const i = c.indexOf(m);
  console.log(`=== ${label} @ ${i} ===`);
  if (i >= 0) console.log(c.substring(Math.max(0, i - back), Math.max(0, i - back) + len).replace(/\s+/g, ' '));
};
grab('tilemapTiledJSON', 'tilemapTiledJSON');
grab('map:key load', '`map:${');
let pos = 0, n = 0;
while ((pos = c.indexOf('this.route.', pos)) >= 0 && n < 6) { grab('route#' + n, 'this.route.', 0, 0); console.log(c.substring(pos - 30, pos + 460).replace(/\s+/g, ' ')); pos += 8; n++; }
