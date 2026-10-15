// tmp-bundle-sell.mjs — exact client payloads for the sell/storage/warp chain (safe to delete)
import fs from 'node:fs';
const b = fs.readFileSync(process.env.TEMP + '/aetheria-bundle.js', 'utf8');
const pats = ['shop_sell_many', 'shop_sell', 'storage_put', 'npc_warp', "send(`market`", 'market_open', 'sellPrice'];
for (const p of pats) {
  const idx = [];
  let i = b.indexOf(p);
  while (i >= 0 && idx.length < 4) { idx.push(i); i = b.indexOf(p, i + 1); }
  console.log('===== ' + p + ' (' + idx.length + ' shown) =====');
  for (const j of idx) {
    console.log(b.slice(Math.max(0, j - 330), j + 330).replace(/\n/g, ' '));
    console.log('-----');
  }
}
