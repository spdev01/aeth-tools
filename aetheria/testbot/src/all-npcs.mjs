// all npc-type objects across every map file + atlas map list
import fs from 'node:fs';
const dir = 'e:/GitHub/lumivaraonline/aetheria/testbot/maps';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
console.log('map files:', files.join(', '));
for (const f of files) {
  let j;
  try { j = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')); } catch { continue; }
  const npcs = [];
  for (const layer of j.layers ?? []) {
    if (layer.type !== 'objectgroup') continue;
    for (const o of layer.objects ?? []) {
      const props = Object.fromEntries((o.properties ?? []).map((p) => [p.name, p.value]));
      if ((o.type ?? '').toLowerCase().includes('npc') || props.npcKey || props.npcId) {
        npcs.push({ name: o.name, cx: Math.round((o.x ?? 0) + (o.width ?? 0) / 2), cy: Math.round((o.y ?? 0) + (o.height ?? 0) / 2), props });
      }
    }
  }
  for (const n of npcs) console.log(`${f.padEnd(22)} ${String(n.name).padEnd(22)} @(${n.cx},${n.cy})  ${JSON.stringify(n.props)}`);
}
const atlas = JSON.parse(fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/world_atlas.json', 'utf8'));
console.log('\natlas zones:', (atlas.zones ?? []).map((z) => `${z.mapId}=${z.mapName}`).join(' | '));
console.log('\natlas maps:', (atlas.maps ?? []).map((m) => m.id ?? m.mapId).join(', '));
console.log('\nkeys:', Object.keys(atlas).join(', '));
