// hunt the peco rental NPC across maps + bundle
import fs from 'node:fs';
const dir = 'e:/GitHub/lumivaraonline/aetheria/testbot/maps';
const atlas = JSON.parse(fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/world_atlas.json', 'utf8'));
console.log('=== atlas zones with peco/rent in npcs/drops/desc ===');
for (const z of atlas.zones) {
  const blob = JSON.stringify({ npcs: z.npcs, drops: z.drops, desc: z.desc, name: z.name });
  if (/peco|rent|เช่า|mount|ขี่/i.test(blob)) console.log(z.id, '|', blob.slice(0, 220));
}
console.log('=== map files NPC names ===');
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.json') || f.startsWith('_')) continue;
  const j = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  for (const layer of j.layers ?? []) {
    if (layer.type !== 'objectgroup') continue;
    for (const o of layer.objects ?? []) {
      if ((o.type ?? '') === 'npc' && /peco|ride|stable|mount|เช่า/i.test(o.name ?? '')) console.log(f, '->', o.name, o.properties);
    }
  }
}
const c = fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/index-main.js', 'utf8');
console.log('=== bundle: peco contexts ===');
let pos = 0, n = 0;
while ((pos = c.toLowerCase().indexOf('peco', pos)) >= 0 && n < 12) {
  console.log('#', n, ':', c.substring(Math.max(0, pos - 130), pos + 200).replace(/\s+/g, ' '));
  pos += 4; n++;
}
