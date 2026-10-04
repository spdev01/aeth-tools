// combat audit: are we casting Bash? how fast are we killing?
import fs from 'node:fs';
const OUT = 'e:/GitHub/lumivaraonline/aetheria/testbot/out';
const runs = fs.readdirSync(OUT).filter((f) => f.startsWith('run-') && f.endsWith('.jsonl')).sort();
const latest = runs[runs.length - 1];
const evs = fs.readFileSync(`${OUT}/${latest}`, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
console.log('RUN:', latest, '| events:', evs.length, '| window:', evs[0]?.t?.slice(11, 19), '->', evs[evs.length - 1]?.t?.slice(11, 19));

const T0 = new Date(evs[evs.length - 1].t).getTime() - 10 * 60 * 1000;
const inWin = evs.filter((e) => e.t && new Date(e.t).getTime() >= T0);
const count = (evt) => inWin.filter((e) => e.evt === evt).length;
console.log('\n--- last 10 min activity ---');
console.log('kills:', count('kill'), '| drops:', count('drop'), '| levelups:', count('levelup'), '| item_used:', count('message:item_used'));

// skill usage: any cast/skill_fx in window
const casts = inWin.filter((e) => e.evt === 'message:cast');
const fx = inWin.filter((e) => e.evt === 'message:skill_fx');
console.log('\n--- skill usage (window) ---');
console.log('cast events:', casts.length, '| skill_fx events:', fx.length);
const bySkill = {};
for (const e of fx) bySkill[e.data.skillId] = (bySkill[e.data.skillId] || 0) + 1;
for (const e of casts) bySkill[e.data.skillId] = (bySkill[e.data.skillId] || 0) + 1;
console.log('by skill:', JSON.stringify(bySkill));
const byCaster = {};
for (const e of fx) byCaster[e.data.casterId] = (byCaster[e.data.casterId] || 0) + 1;
for (const e of casts) byCaster[e.data.casterId] = (byCaster[e.data.casterId] || 0) + 1;
console.log('by caster:', JSON.stringify(byCaster));

// identify our sessionId: the one whose levelup messages base:true appear (ours gained base levels rapidly)
const lvl = inWin.filter((e) => e.evt === 'levelup');
console.log('levelup ids:', JSON.stringify([...new Set(lvl.map((e) => e.data.sessionId))]));

// kills per minute & exp per minute
const kills = inWin.filter((e) => e.evt === 'kill');
let base = 0, job = 0;
for (const k of kills) { base += k.data.base || 0; job += k.data.job || 0; }
console.log(`\nkills/min: ${(kills.length / 10).toFixed(1)} | base exp/min: ${Math.round(base / 10)} | job exp/min: ${Math.round(job / 10)}`);

// farm_status snaps for pace check
const fs2 = evs.filter((e) => e.evt === 'farm_status');
console.log('\n--- farm_status progression (last 6) ---');
for (const e of fs2.slice(-6)) console.log(e.t.slice(11, 19), JSON.stringify(e.data));
