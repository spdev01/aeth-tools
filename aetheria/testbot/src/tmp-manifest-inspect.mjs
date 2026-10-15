// tmp-manifest-inspect.mjs — inspect asset manifest shapes + probe sample art files.
import fs from 'node:fs';
const base = 'https://www.aetheria-online.in.th';
const b = fs.readFileSync('E:/GitHub/lumivaraonline/aetheria/recon/bundle-2026-10-15.js', 'utf8');

for (const g of ['icons', 'monsters', 'skills', 'classes', 'spirits']) {
  try {
    const r = await fetch(`${base}/art/${g}/manifest.json`);
    const j = await r.json();
    const keys = Object.keys(j);
    console.log(`\n== /art/${g}/manifest.json == status=${r.status} topKeys=${keys.length}: [${keys.slice(0, 6).join(', ')}${keys.length > 6 ? ', …' : ''}]`);
    if (g === 'icons') {
      for (const k of keys.slice(0, 5)) {
        const v = j[k];
        console.log(`   ${k}: ${typeof v === 'object' ? Object.keys(v).length + ' entries; sample ' + JSON.stringify(Object.entries(v).slice(0, 2)) : v}`);
      }
    } else {
      const entries = Object.entries(j).slice(0, 3);
      for (const [k, v] of entries) console.log('   ' + k + ' -> ' + JSON.stringify(v).slice(0, 150));
      console.log('   total entries:', keys.length);
    }
    fs.writeFileSync(`E:/GitHub/lumivaraonline/aetheria/recon/manifest-${g}.json`, JSON.stringify(j));
  } catch (e) { console.log(`/art/${g}/manifest.json ERR`, e.message); }
}

// NPC slug set from bundle
const m = b.match(/new Set\(\[(`npc\/[^\]]{10,2000}?)\]\)/);
if (m) {
  const slugs = [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1].replace(/^npc\//, ''));
  console.log('\nNPC slugs (' + slugs.length + '):', slugs.join(', '));
  fs.writeFileSync('E:/GitHub/lumivaraonline/aetheria/recon/npc-slugs.json', JSON.stringify(slugs));
} else console.log('NPC slug set not found — searching alt pattern');
let i = b.indexOf('arena-master');
if (i >= 0) console.log('alt NPC context: ...' + b.slice(Math.max(0, i - 100), i + 400).replace(/\s+/g, ' ').slice(0, 480));

// probes
const probes = [
  '/art/loading/venom_swamp.webp', '/art/loading/field_01.webp', '/art/loading/capital.webp',
  '/art/world/atlas-world1.webp', '/art/world/atlas-world2.webp',
  '/art/bosses/94001.webp', '/art/bosses/94041.webp',
  '/art/cards/94046.webp', '/art/cards/94001.webp',
  '/art/pets/9001.webp', '/art/npcs/portraits/healer-mira.webp', '/art/npcs/healer-mira-face.webp',
  '/art/classes/knight-face.webp', '/art/npcs/bodies/pet-anims.json', '/art/monsters/anims.json',
];
console.log('\n--- probes ---');
for (const p of probes) {
  try { const r = await fetch(base + p); console.log(r.status, p, r.headers.get('content-type'), r.headers.get('content-length') ?? ''); }
  catch (e) { console.log('ERR', p, e.message); }
}
