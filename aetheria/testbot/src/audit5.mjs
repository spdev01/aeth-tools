// audit5: hpItems shape + item_used freq + bash learned?
import fs from 'node:fs';
const c = fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/index-main.js', 'utf8');
console.log('=== hpItems usage in auto editor ===');
let pos = 0, n = 0;
while ((pos = c.indexOf('hpItems', pos)) >= 0 && n < 10) {
  console.log(`\n#${n} @ ${pos}:`);
  console.log(c.substring(Math.max(0, pos - 300), pos + 400).replace(/\s+/g, ' '));
  pos += 7; n++;
}

const OUT = 'e:/GitHub/lumivaraonline/aetheria/testbot/out';
const runs = fs.readdirSync(OUT).filter((f) => f.startsWith('run-') && f.endsWith('.jsonl')).sort();
// bash skill_up history
console.log('\n=== skill_up history (bash/sword) ===');
for (const f of runs) {
  const es = fs.readFileSync(`${OUT}/${f}`, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const ups = es.filter((e) => e.evt === 'skill_up');
  if (ups.length) {
    const byId = {};
    for (const u of ups) byId[u.data.id] = (byId[u.data.id] || 0) + 1;
    console.log(f, JSON.stringify(byId));
  }
}
// item_used frequency in latest run
const latest = runs[runs.length - 1];
const es = fs.readFileSync(`${OUT}/${latest}`, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const used = es.filter((e) => e.evt === 'message:item_used');
console.log('\n=== item_used in', latest, '===');
console.log('count:', used.length, '| items:', JSON.stringify([...new Set(used.map((u) => u.data.itemId))]));
const deaths = es.filter((e) => e.evt === 'DEATH').length;
console.log('DEATH events:', deaths, '| duration min:', ((new Date(es[es.length - 1].t) - new Date(es[0].t)) / 60000).toFixed(1));
