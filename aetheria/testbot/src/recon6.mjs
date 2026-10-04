// Recon 6: default auto config + download map tilemaps + extract exits (toMap rects)
import fs from 'node:fs';

// 1) default auto config from captured character message
const snap = JSON.parse(fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/testbot/out/character-snapshot.json', 'utf8'));
console.log('=== default auto config ===');
console.log(JSON.stringify(snap.auto, null, 1));

// 2) toMap parse context
const c = fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/index-main.js', 'utf8');
const i = c.indexOf('toMap');
console.log('=== toMap context @', i, '===');
console.log(c.substring(Math.max(0, i - 600), i + 700).replace(/\s+/g, ' '));

// 3) download maps + extract exits
const maps = ['capital', 'clover_meadow', 'novice_garden', 'sun_farm', 'willow_road', 'goblin_trail', 'gale_high', 'frost_pass', 'crystal_mine', 'verdant_basin'];
const dir = 'e:/GitHub/lumivaraonline/aetheria/testbot/maps';
fs.mkdirSync(dir, { recursive: true });
const summary = {};
for (const m of maps) {
  try {
    const r = await fetch(`https://www.aetheria-online.in.th/maps/${m}.json`);
    if (!r.ok) { console.log(m, 'HTTP', r.status); continue; }
    const j = await r.json();
    fs.writeFileSync(`${dir}/${m}.json`, JSON.stringify(j));
    const objs = [];
    for (const layer of j.layers ?? []) {
      if (layer.type === 'objectgroup') {
        for (const o of layer.objects ?? []) objs.push({ name: o.name, type: o.type, x: o.x, y: o.y, w: o.width, h: o.height, props: o.properties });
      }
    }
    const exits = objs.filter((o) => (o.props ?? []).some((p) => p.name === 'toMap') || /exit|warp|portal/i.test(o.type ?? '') || /exit|warp|portal/i.test(o.name ?? ''));
    summary[m] = {
      width: j.width, height: j.height,
      exits: exits.map((o) => ({
        type: o.type, name: o.name,
        cx: o.x + o.w / 2, cy: o.y + o.h / 2,
        toMap: (o.props ?? []).find((p) => p.name === 'toMap')?.value,
        props: o.props,
      })),
      allTypes: [...new Set(objs.map((o) => o.type))],
      allNames: [...new Set(objs.map((o) => o.name))].slice(0, 25),
    };
    console.log(m, '->', JSON.stringify(summary[m].exits));
  } catch (e) { console.log(m, 'ERR', e.message); }
}
fs.writeFileSync(`${dir}/_exits.json`, JSON.stringify(summary, null, 1));
console.log('saved', `${dir}/_exits.json`);
