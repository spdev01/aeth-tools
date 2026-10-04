// which npc opened the general store? show context around 'shop' events
import fs from 'node:fs';
const OUT = 'e:/GitHub/lumivaraonline/aetheria/testbot/out';
const runs = fs.readdirSync(OUT).filter((f) => f.startsWith('run-') && f.endsWith('.jsonl')).sort();
for (const f of runs) {
  const es = fs.readFileSync(`${OUT}/${f}`, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  for (let i = 0; i < es.length; i++) {
    if (es[i].evt === 'shop') {
      const items = (es[i].data.items ?? []).map((x) => x.name);
      if (items.includes('Carrot')) {
        console.log('file:', f);
        for (let k = Math.max(0, i - 6); k <= i; k++) console.log('  ', es[k].t.slice(11, 19), es[k].evt, JSON.stringify(es[k].data).slice(0, 180));
        process.exit(0);
      }
    }
  }
}
