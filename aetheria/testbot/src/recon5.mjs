// Recon 5: tilemap warp objects, route walker, auto config editor
import fs from 'node:fs';
const c = fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/index-main.js', 'utf8');
const atlas = JSON.parse(fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/world_atlas.json', 'utf8'));
const cm = atlas.zones.find((z) => z.id === 'clover_meadow');
console.log('clover_meadow mapName:', cm?.mapName, '| mapId:', cm?.mapId, '| desc:', cm?.desc);
console.log('clover monsters:', (cm?.liveMonsters ?? []).map((m) => `${m.name}(${m.level})`).join(', '));

const show = (label, i, back, len) => {
  console.log(`\n=== ${label} @ ${i} ===`);
  if (i >= 0) console.log(c.substring(Math.max(0, i - back), Math.max(0, i - back) + len).replace(/\s+/g, ' '));
};
// 1) second tilemapTiledJSON usage (the real load)
let pos = 0, n = 0;
while ((pos = c.indexOf('tilemapTiledJSON(', pos)) >= 0 && n < 4) { show('tilemapLoad#' + n, pos, 160, 420); pos += 12; n++; }
// 2) map json fetch pattern
show('maps json', c.indexOf('maps/${'), 120, 300);
show('.tilemapJSON', c.indexOf('tilemapJSON'), 200, 400);
// 3) route walker
pos = 0; n = 0;
while ((pos = c.indexOf('this.route', pos)) >= 0 && n < 8) { show('route#' + n, pos, 80, 520); pos += 9; n++; }
// 4) auto config editor: search 'pickupLoot'
show('pickupLoot', c.indexOf('pickupLoot'), 250, 1100);
// 5) 'warp' object property
show('objtype warp', c.indexOf('`warp`'), 250, 700);
