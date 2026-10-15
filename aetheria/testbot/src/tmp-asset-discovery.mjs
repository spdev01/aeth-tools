// tmp-asset-discovery.mjs — find every /art/<group>/ path pattern the game uses (for asset scraping) + probe manifests.
import fs from 'node:fs';
const b = fs.readFileSync('E:/GitHub/lumivaraonline/aetheria/recon/bundle-2026-10-15.js', 'utf8');
const groups = ['icons', 'monsters', 'skills', 'classes', 'npcs', 'bosses', 'pets', 'spirits', 'cards', 'elements', 'world', 'town', 'title', 'cashshop', 'gacha', 'costume-box', 'bags', 'fusion', 'refine', 'fx', 'loading', 'news', 'guild', 'landing', 'cursors'];

for (const g of groups) {
  const re = new RegExp('/art/' + g.replace(/[-]/g, '[-]') + '/[^`"\'\\s)]{0,90}', 'g');
  const found = new Set();
  let m;
  while ((m = re.exec(b)) && found.size < 10) found.add(m[0]);
  if (!found.size) continue;
  console.log('== ' + g + ' (' + found.size + ' shown) ==');
  for (const f of found) console.log('   ' + f);
}

// wider context for the ones that matter most
for (const g of ['monsters', 'skills', 'classes', 'npcs', 'world']) {
  let i = b.indexOf('/art/' + g + '/');
  if (i < 0) continue;
  console.log('\n--- context: ' + g + ' ---');
  console.log(b.slice(Math.max(0, i - 200), i + 300).replace(/\s+/g, ' '));
}

console.log('\n--- icon manifest (local cache) ---');
try {
  const man = JSON.parse(fs.readFileSync('E:/GitHub/lumivaraonline/aetheria/testbot/icon-manifest.json', 'utf8'));
  const entries = Object.entries(man);
  console.log('entries:', entries.length);
  for (const [k, v] of entries.slice(0, 5)) console.log('  ', k, '->', v);
} catch (e) { console.log('no local manifest:', e.message); }

console.log('\n--- probing group manifests ---');
for (const g of groups) {
  const u = 'https://www.aetheria-online.in.th/art/' + g + '/manifest.json';
  try {
    const r = await fetch(u);
    const t = await r.text();
    console.log(g.padEnd(12), r.status, t.slice(0, 90).replace(/\s+/g, ' '));
  } catch (e) { console.log(g.padEnd(12), 'ERR', e.message); }
}
