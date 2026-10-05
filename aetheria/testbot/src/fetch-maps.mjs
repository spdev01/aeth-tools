// re-fetch live maps and diff NPCs vs cached copies
import fs from 'node:fs';
const BASE = 'https://www.aetheria-online.in.th';
const maps = ['capital', 'caravan_market', 'sun_farm', 'gale_high', 'frost_pass'];
for (const m of maps) {
  try {
    const res = await fetch(`${BASE}/maps/${m}.json`);
    if (!res.ok) { console.log(`${m}: HTTP ${res.status}`); continue; }
    const j = await res.json();
    const npcs = [];
    for (const layer of j.layers ?? []) {
      if (layer.type !== 'objectgroup') continue;
      for (const o of layer.objects ?? []) {
        const props = Object.fromEntries((o.properties ?? []).map((p) => [p.name, p.value]));
        if ((o.type ?? '').toLowerCase().includes('npc') || props.npcKey || props.npcId) {
          npcs.push(`${o.name}@(${Math.round((o.x ?? 0) + (o.width ?? 0) / 2)},${Math.round((o.y ?? 0) + (o.height ?? 0) / 2)}) npcId=${props.npcId ?? '-'}`);
        }
      }
    }
    console.log(`\n== ${m} (live) == npcs: ${npcs.length}`);
    for (const x of npcs) console.log('  ', x);
    // diff vs cached
    const cachedPath = `e:/GitHub/lumivaraonline/aetheria/testbot/maps/${m}.json`;
    if (fs.existsSync(cachedPath)) {
      const cj = JSON.parse(fs.readFileSync(cachedPath, 'utf8'));
      const cnt = JSON.stringify(cj).length, live = JSON.stringify(j).length;
      console.log(`   cached size=${cnt} live size=${live} ${cnt === live ? 'SAME' : 'DIFFERENT!'}`);
    }
  } catch (e) { console.log(`${m}: ERR ${e.message}`); }
}
// search ALL map json objects for top-right capital-ish or peco word in ANY map object names
console.log('\n== full-text scan of live capital for rent/mount/peco words ==');
const cap = await (await fetch(`${BASE}/maps/capital.json`)).text();
for (const w of ['rent', 'peco', 'pego', 'mount', 'stable', 'Peco', 'เช่า']) {
  const i = cap.indexOf(w);
  console.log(`  "${w}": ${i >= 0 ? 'FOUND @' + i : 'no'}`);
}
