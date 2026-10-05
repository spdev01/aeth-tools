// verify-fixes: did the new behaviors land? (connect retry, weave, SP dips, deaths, potions)
import fs from 'node:fs';
const OUT = 'e:/GitHub/lumivaraonline/aetheria/testbot/out';
const runs = fs.readdirSync(OUT).filter((f) => f.startsWith('run-') && f.endsWith('.jsonl')).sort();
const latest = runs[runs.length - 1];
const es = fs.readFileSync(`${OUT}/${latest}`, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
console.log('RUN:', latest, '| events:', es.length);
const t0 = new Date(es[0].t), tLast = new Date(es[es.length - 1].t);
const mins = (tLast - t0) / 60000;
console.log('window:', t0.toISOString().slice(11, 19), '->', tLast.toISOString().slice(11, 19), `(${mins.toFixed(1)} min)`);

console.log('\n--- connect/join ---');
for (const e of es.filter((x) => /connect_retry|joined|run_start|STEP_START|STEP_DONE|STEP_FAIL/.test(x.evt))) console.log(e.t.slice(11, 19), e.evt.padEnd(12), JSON.stringify(e.data).slice(0, 150));

console.log('\n--- setAuto readback (bashLv + hpItems) ---');
for (const e of es.filter((x) => x.evt === 'setAuto')) console.log(e.t.slice(11, 19), JSON.stringify(e.data));

console.log('\n--- skill casts (skill_use) ---');
for (const e of es.filter((x) => x.evt === 'skill_use').slice(0, 12)) console.log(e.t.slice(11, 19), JSON.stringify(e.data));

console.log('\n--- SP across heartbeats (dips = skill casts happening) ---');
const hbs = es.filter((e) => e.evt === 'HEARTBEAT' && e.data.sp != null);
for (const h of hbs) console.log(h.t.slice(11, 19), `sp=${h.data.sp}/${h.data.maxSp}`, `hp=${h.data.hp}/${h.data.maxHp}`, `bashLv=${h.data.bashLv}`, `hpItems=${h.data.hpItems}`, `weaves=${h.data.weaves}`);

console.log('\n--- deaths / kills ---');
const deaths = es.filter((e) => e.evt === 'DEATH');
const kills = es.filter((e) => e.evt === 'kill');
console.log('deaths:', deaths.length, '| kills:', kills.length, '| deaths/min:', mins > 0 ? (deaths.length / mins).toFixed(2) : 0, '| kills/min:', mins > 0 ? (kills.length / mins).toFixed(1) : 0);
for (const d of deaths) console.log('  DEATH', d.t.slice(11, 19));
