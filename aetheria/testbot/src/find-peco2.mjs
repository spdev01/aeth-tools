// find peco-rental references in the game bundle + all map files
import fs from 'node:fs';
const c = fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/index-main.js', 'utf8');
const pats = ['pego-rental', 'peco-rental', 'peco_rental', 'pecoRental', 'rental', 'เช่า', 'เปโก', 'พีโก', 'Pegog', 'Peco'];
for (const p of pats) {
  let pos = 0, n = 0;
  while ((pos = c.indexOf(p, pos)) >= 0 && n < 4) {
    const seg = c.substring(Math.max(0, pos - 220), pos + 340).replace(/\s+/g, ' ');
    console.log(`\n### "${p}" @${pos}: ${seg}`);
    pos += p.length; n++;
  }
}
console.log('\n=== map files mention ===');
const dir = 'e:/GitHub/lumivaraonline/aetheria/testbot/maps';
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  const t = fs.readFileSync(`${dir}/${f}`, 'utf8');
  if (/peco|pego|rent|เช่า/i.test(t)) console.log(f, 'MATCH');
}
