import fs from 'node:fs';
const P = 'E:/GitHub/lumivaraonline/aetheria/recon/wiki-data.json';
const j = JSON.parse(fs.readFileSync(P, 'utf8'));
console.log('top-level:', Array.isArray(j) ? 'array len ' + j.length : Object.keys(j).map((k) => {
  const v = j[k];
  return k + ':' + (Array.isArray(v) ? 'arr ' + v.length : typeof v);
}).join('  '));
let items = null;
if (Array.isArray(j)) items = j;
else {
  for (const k of Object.keys(j)) {
    const v = j[k];
    if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] && 'sellPrice' in v[0]) items = v;
  }
}
if (!items) { console.log('no items array found'); process.exit(0); }
console.log('items:', items.length);
const byName = new Map(); let dup = 0;
for (const it of items) { if (byName.has(it.name)) dup++; byName.set(it.name, it); }
console.log('unique names:', byName.size, 'dups:', dup);
const probe = ['Bottled Smoke', 'Dry Husk', 'Sand Wyrm Scale', 'Mirage Sand', 'Royal Stinger', 'Crown Ruby', 'Brass Lamp', 'Wyrm Tooth', 'Desert Chitin', 'Enchant Rune', 'Oridecon', 'Frostbite Katar', 'Fire Converter', 'Mirage Djinn Card', 'Sand Wyrm Card', 'Butterfly Wing', 'White Potion', 'Red Potion', 'Enriched Elunium'];
for (const n of probe) {
  const it = byName.get(n);
  console.log(n.padEnd(22), it ? (`id=${it.id} sell=${it.sellPrice} stack=${it.maxStack} type=${it.type}`) : 'NOT FOUND');
}
console.log('--- top 25 sellPrice>0 ---');
const top = [...items].filter((x) => (x.sellPrice ?? 0) > 0).sort((a, b) => b.sellPrice - a.sellPrice).slice(0, 25);
for (const t of top) console.log(String(t.sellPrice).padStart(10), t.name, '|', t.type);
const zero = items.filter((x) => !((x.sellPrice ?? 0) > 0));
console.log('items with sellPrice 0/undefined:', zero.length, 'of', items.length);
