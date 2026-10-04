// List all NPC-type objects in capital map (and check for peco/stable/mount keywords)
import fs from 'node:fs';
const j = JSON.parse(fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/testbot/maps/capital.json', 'utf8'));
const out = [];
for (const layer of j.layers ?? []) {
  if (layer.type !== 'objectgroup') continue;
  for (const o of layer.objects ?? []) {
    const props = Object.fromEntries((o.properties ?? []).map((p) => [p.name, p.value]));
    if ((o.type ?? '').toLowerCase().includes('npc') || props.npcKey || props.npc || /npc/i.test(o.name ?? '')) {
      out.push({ name: o.name, type: o.type, x: o.x, y: o.y, w: o.width, h: o.height, props });
    }
  }
}
console.log('NPC-like objects:', out.length);
for (const o of out) {
  const cx = (o.x + (o.w ?? 0) / 2), cy = (o.y + (o.h ?? 0) / 2);
  console.log(JSON.stringify({ name: o.name, type: o.type, cx, cy, props: o.props }));
}
// also list distinct object names for orientation
const names = new Set();
for (const layer of j.layers ?? []) if (layer.type === 'objectgroup') for (const o of layer.objects ?? []) names.add(`${o.type}|${o.name}`);
console.log('=== all object type|name ===');
console.log([...names].sort().join('\n'));
