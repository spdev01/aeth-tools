// combat audit v2: precise — uses selfId from heartbeat
import fs from 'node:fs';
const OUT = 'e:/GitHub/lumivaraonline/aetheria/testbot/out';
const runs = fs.readdirSync(OUT).filter((f) => f.startsWith('run-') && f.endsWith('.jsonl')).sort();
const latest = runs[runs.length - 1];
const evs = fs.readFileSync(`${OUT}/${latest}`, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const last = (evt) => { for (let i = evs.length - 1; i >= 0; i--) if (evs[i].evt === evt) return evs[i]; return null; };
const selfId = last('HEARTBEAT')?.data?.selfId ?? null;
console.log('RUN:', latest, '| events:', evs.length, '| selfId:', selfId);
console.log('window:', evs[0]?.t?.slice(11, 19), '->', evs[evs.length - 1]?.t?.slice(11, 19));

const T0 = new Date(evs[evs.length - 1].t).getTime() - 10 * 60 * 1000;
const inWin = evs.filter((e) => e.t && new Date(e.t).getTime() >= T0);

const myCasts = inWin.filter((e) => (e.evt === 'message:cast' || e.evt === 'message:skill_fx') && e.data?.casterId === selfId);
const myBash = myCasts.filter((e) => /bash/i.test(e.data.skillId ?? ''));
console.log('\n--- OUR skill usage (10 min) ---');
console.log('our casts/skill_fx:', myCasts.length, '| bash casts:', myBash.length, '| skills:', JSON.stringify([...new Set(myCasts.map((e) => e.data.skillId))]));
const kills = inWin.filter((e) => e.evt === 'kill');
let base = 0, job = 0;
for (const k of kills) { base += k.data.base || 0; job += k.data.job || 0; }
console.log(`kills: ${kills.length} (${(kills.length / 10).toFixed(1)}/min) | base/min ${Math.round(base / 10)} | job/min ${Math.round(job / 10)}`);
console.log('deaths:', inWin.filter((e) => e.evt === 'DEATH' || e.evt === 'death_recover').length, '| death_recover:', inWin.filter((e) => e.evt === 'death_recover').length, '| death_recovered:', inWin.filter((e) => e.evt === 'death_recovered').length);
console.log('wrong_map_return:', inWin.filter((e) => e.evt === 'wrong_map_return').length, '| auto_enable_failed:', inWin.filter((e) => e.evt === 'auto_enable_failed').length);
for (const e of inWin.filter((e) => /death|wrong_map|auto_enable|setAuto|travel_msg/.test(e.evt)).slice(-10)) console.log(' ', e.t.slice(11, 19), e.evt, JSON.stringify(e.data).slice(0, 150));
const st = evs.filter((e) => e.evt === 'farm_status' || e.evt === 'HEARTBEAT').slice(-4);
console.log('\n--- latest state ---');
for (const e of st) console.log(e.t.slice(11, 19), e.evt, JSON.stringify(e.data).slice(0, 220));
