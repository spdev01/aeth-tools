// combat audit v3: bash detection via SP trend + damage profile + kill pace
import fs from 'node:fs';
const OUT = 'e:/GitHub/lumivaraonline/aetheria/testbot/out';
const runs = fs.readdirSync(OUT).filter((f) => f.startsWith('run-') && f.endsWith('.jsonl')).sort();
const latest = runs[runs.length - 1];
const evs = fs.readFileSync(`${OUT}/${latest}`, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const last = (evt) => { for (let i = evs.length - 1; i >= 0; i--) if (evs[i].evt === evt) return evs[i]; return null; };
const selfId = last('HEARTBEAT')?.data?.selfId ?? null;
const t0 = new Date(evs[0].t).getTime();
const tN = new Date(evs[evs.length - 1].t).getTime();
const mins = Math.max(0.5, (tN - t0) / 60000);
console.log('RUN:', latest, '| selfId:', selfId, '| duration:', mins.toFixed(1), 'min');

// SP trend from heartbeats (bash costs 13 SP; continuous cast = SP stays low)
const hbs = evs.filter((e) => e.evt === 'HEARTBEAT' && e.data.sp != null);
console.log('\nSP trend:', hbs.slice(-8).map((h) => `${h.t.slice(11, 19)}=${h.data.sp}/${h.data.maxSp}${h.data.dead ? '(!)' : ''}`).join('  '));

// damage profile of OUR hits (bash should show big spikes vs basic attacks)
const hits = evs.filter((e) => e.evt === 'message:hit' && e.data?.attackerId === selfId);
const dmgs = hits.map((h) => h.data.damage).filter((d) => typeof d === 'number');
if (dmgs.length) {
  dmgs.sort((a, b) => a - b);
  const avg = Math.round(dmgs.reduce((s, d) => s + d, 0) / dmgs.length);
  console.log(`\nour hits: ${dmgs.length} | dmg min ${dmgs[0]} / median ${dmgs[Math.floor(dmgs.length / 2)]} / max ${dmgs[dmgs.length - 1]} / avg ${avg}`);
  console.log('top 10 dmgs:', dmgs.slice(-10).join(', '));
}

// kills & levels
const kills = evs.filter((e) => e.evt === 'kill');
let base = 0, job = 0;
for (const k of kills) { base += k.data.base || 0; job += k.data.job || 0; }
console.log(`\nkills: ${kills.length} (${(kills.length / mins).toFixed(1)}/min) | base ${Math.round(base / mins)}/min | job ${Math.round(job / mins)}/min`);
const fsS = evs.filter((e) => e.evt === 'farm_status');
if (fsS.length >= 2) {
  const a = fsS[0].data, b = fsS[fsS.length - 1].data;
  console.log(`progress: base ${a.baseLevel}->${b.baseLevel} | job ${a.jobLevel}->${b.jobLevel}`);
}
console.log('deaths/recoveries:', evs.filter((e) => e.evt === 'death_recover').length, '/', evs.filter((e) => e.evt === 'death_recovered').length);
