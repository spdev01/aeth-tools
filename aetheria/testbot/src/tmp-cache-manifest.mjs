// tmp-cache-manifest.mjs — prefetch the icon manifest into testbot/icon-manifest.json (safe to delete)
import fs from 'fs';
const r = await fetch('https://www.aetheria-online.in.th/art/icons/manifest.json');
const j = await r.json();
fs.writeFileSync('icon-manifest.json', JSON.stringify({ items: j.items, fetchedAt: Date.now() }));
const keys = Object.keys(j.items || {});
console.log('cached items:', keys.length);
for (const k of ['2235', '91064', '90040', '2268', '90203']) console.log(k, '=>', j.items[k]);
