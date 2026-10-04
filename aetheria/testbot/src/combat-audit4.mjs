// audit4: death cycle detail + SP min across all heartbeats + any self-casts ever
import fs from 'node:fs';
const OUT = 'e:/GitHub/lumivaraonline/aetheria/testbot/out';
const runs = fs.readdirSync(OUT).filter((f) => f.startsWith('run-') && f.endsWith('.jsonl')).sort();
const latest = runs[runs.length - 1];
const evs = fs.readFileSync(`${OUT}/${latest}`, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
console.log('RUN:', latest);

console.log('\n--- death cycle events (all) ---');
for (const e of evs.filter((e) => /DEATH|death_recover|respawned|wrong_map|auto_enable|RECONNECT|reconnect_done|setAuto|travel_msg/.test(e.evt))) {
  console.log(e.t.slice(11, 19), e.evt.padEnd(16), JSON.stringify(e.data).slice(0, 130));
}

console.log('\n--- SP min across heartbeats ---');
const hbs = evs.filter((e) => e.evt === 'HEARTBEAT' && e.data.sp != null);
const minSp = Math.min(...hbs.map((h) => h.data.sp));
console.log('heartbeats:', hbs.length, '| min sp:', minSp, '| max:', Math.max(...hbs.map((h) => h.data.sp)));

console.log('\n--- any self casts across ALL logs (selfIds from levelups) ---');
for (const f of runs.slice(-4)) {
  const es = fs.readFileSync(`${OUT}/${f}`, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const selfIds = new Set(es.filter((e) => e.evt === 'levelup' && e.data.sessionId).map((e) => e.data.sessionId));
  const casts = es.filter((e) => (e.evt === 'message:cast' || e.evt === 'message:skill_fx') && selfIds.has(e.data?.casterId));
  const otherCasts = es.filter((e) => (e.evt === 'message:cast' || e.evt === 'message:skill_fx') && !selfIds.has(e.data?.casterId));
  console.log(f, '| selfIds:', selfIds.size, '| own casts:', casts.length, '| other casts:', otherCasts.length);
  for (const c of casts.slice(0, 6)) console.log('   OWN:', c.t.slice(11, 19), c.data.skillId ?? c.data.name);
}
