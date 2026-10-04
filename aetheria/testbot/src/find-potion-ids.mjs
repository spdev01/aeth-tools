// potion itemIds from the General Goods shop dump
import fs from 'node:fs';
const OUT = 'e:/GitHub/lumivaraonline/aetheria/testbot/out';
const runs = fs.readdirSync(OUT).filter((f) => f.startsWith('run-') && f.endsWith('.jsonl')).sort();
for (const f of runs) {
  const es = fs.readFileSync(`${OUT}/${f}`, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  for (const e of es) {
    if (e.evt === 'shop' && (e.data.items ?? []).some((x) => x.name === 'Red Potion')) {
      for (const it of e.data.items) {
        if (/potion|carrot/i.test(it.name)) console.log(`${it.itemId}  ${it.name}  ${it.price}z  ${it.type}`);
      }
      process.exit(0);
    }
  }
}
