// scan latest run for hiccups: deaths, respawns, sells, auto-off, fails
import fs from 'node:fs';
const OUT = 'e:/GitHub/lumivaraonline/aetheria/testbot/out';
const runs = fs.readdirSync(OUT).filter((f) => f.startsWith('run-') && f.endsWith('.jsonl')).sort();
const latest = runs[runs.length - 1];
const evs = fs.readFileSync(`${OUT}/${latest}`, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
console.log('RUN:', latest, '| events:', evs.length);
const interesting = evs.filter((e) => /death|respawn|auto_off|auto_sold|banked|STEP_FAIL|farm_status|budget|sell_none|HEARTBEAT/.test(e.evt));
for (const e of interesting.slice(-28)) {
  const d = JSON.stringify(e.data);
  console.log(e.t.slice(11, 19), e.evt.padEnd(15), d.length > 150 ? d.slice(0, 150) + '…' : d);
}
const deaths = evs.filter((e) => e.evt === 'death_detected' || e.evt === 'DEATH').length;
const kills = evs.filter((e) => e.evt === 'kill').length;
console.log(`\ntotal: kills=${kills} deaths=${deaths}`);
