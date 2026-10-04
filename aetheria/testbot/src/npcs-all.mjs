// Download remaining maps + list ALL npc objects everywhere
import fs from 'node:fs';
const dir = 'e:/GitHub/lumivaraonline/aetheria/testbot/maps';
const maps = ['field_01', 'caravan_market', 'venom_swamp', 'orc_camp', 'moon_forest', 'azure_lake', 'fort_city', 'port_city'];
for (const m of maps) {
  const f = `${dir}/${m}.json`;
  if (fs.existsSync(f)) continue;
  try {
    const r = await fetch(`https://www.aetheria-online.in.th/maps/${m}.json`);
    if (!r.ok) { console.log(m, 'HTTP', r.status); continue; }
    fs.writeFileSync(f, JSON.stringify(await r.json()));
    console.log('downloaded', m);
  } catch (e) { console.log(m, 'ERR', e.message); }
}
console.log('=== ALL NPC objects in all maps ===');
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.json') || f.startsWith('_')) continue;
  const j = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  const npcs = [];
  for (const layer of j.layers ?? []) {
    if (layer.type !== 'objectgroup') continue;
    for (const o of layer.objects ?? []) {
      if ((o.type ?? '') === 'npc') {
        const props = Object.fromEntries((o.properties ?? []).map((p) => [p.name, p.value]));
        npcs.push(`${o.name}@(${(o.x + (o.width ?? 0) / 2).toFixed(0)},${(o.y + (o.height ?? 0) / 2).toFixed(0)})${props.pet ? ' pet:' + props.pet : ''}${props.npcId ? ' id:' + props.npcId : ''}`);
      }
    }
  }
  if (npcs.length) console.log(f.replace('.json', ''), '=>', npcs.join(' | '));
}
