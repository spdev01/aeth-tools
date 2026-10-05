// STATUS — one-glance readout of what the bot is doing right now.
// Usage:  node src/status.js            (snapshot)
//         node src/status.js --watch    (refresh every 15s)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out');
const STEP_NAMES = [
  '01-stats-initial', '02-travel-east-meadow', '03-farm-job10', '04-basic-skill-9',
  '05-back-to-capital', '06-valkyrie-swordsman', '07-stats-dex10-rest-str', '08-travel-willow-road',
  '09-farm-lv12', '10-skills-bash-sword', '11-auto-bash', '12-travel-capital',
  '13-market-probe', '14-blacksmith-probe', '15-capital-npc-scan',
  '16-extra-npc-hunt', '17-sell-junk', '18-buy-saber', '19-buy-ores', '20-refine-saber', '21-equip-saber',
  '22-travel-goblin', '23-farm-j50-stats', '23b-gems-refine-equip', '23c-orc-egg', '24-skills-j50', '25-knight-change', '26-stats-knight',
  '27a-pet-hatch', '27-travel-gale', '28-farm-gale-job27', '29-skills-gale', '30-peco-rental', '31-frost-farm',
];

function snapshot() {
  const files = fs.readdirSync(OUT).filter((f) => f.startsWith('run-') && f.endsWith('.jsonl')).sort();
  if (!files.length) return 'no run logs found — bot has never run';
  const latest = files[files.length - 1];
  const lines = fs.readFileSync(path.join(OUT, latest), 'utf8').trim().split('\n');
  const evs = [];
  for (const l of lines) { try { evs.push(JSON.parse(l)); } catch {} }
  const last = (evt) => { for (let i = evs.length - 1; i >= 0; i--) if (evs[i].evt === evt) return evs[i]; return null; };
  let si = -1, di = -1, ei = -1, ai = -1;
  evs.forEach((e, i) => { if (e.evt === 'STEP_START') si = i; if (e.evt === 'STEP_DONE') di = i; if (e.evt === 'run_end') ei = i; if (e.evt === 'ABORT') ai = i; });
  const lastStepStart = si >= 0 ? evs[si] : null, lastAbort = ai >= 0 ? evs[ai] : null, runEnd = ei >= 0 ? evs[ei] : null;
  const running = si >= 0 && si > di && ei < si;
  const state = fs.existsSync(path.join(OUT, 'run-state.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'run-state.json'), 'utf8')) : {};
  const farm = last('farm_status');
  const charEv = last('CHARACTER');
  const hb = last('HEARTBEAT');
  const auto = last('setAuto');
  const lvlUp = last('message:levelup');
  const death = last('death_detected') || last('DEATH');
  const respawned = last('respawned');
  const notice = last('message:center_notice');
  const err = last('STEP_FAIL') || last('client_error') || last('UNCAUGHT');

  // last 10 minutes activity
  const T0 = Date.now() - 10 * 60 * 1000;
  let kills = 0, baseExp = 0, jobExp = 0, boxExp = 0;
  const drops = {};
  for (const e of evs) {
    if (!e.t || new Date(e.t).getTime() < T0) continue;
    if (e.evt === 'kill' || e.evt === 'message:exp_gain') { kills++; baseExp += e.data.base || 0; jobExp += e.data.job || 0; boxExp += e.data.box || 0; }
    if ((e.evt === 'drop' || e.evt === 'message:item_gain') && e.data.name) drops[e.data.name] = (drops[e.data.name] || 0) + (e.data.qty || 1);
  }

  const lines2 = [];
  lines2.push(`RUN LOG   ${latest}  (${evs.length} events)`);
  if (running) lines2.push(`STATUS    ▶ RUNNING step: ${lastStepStart.data.step}   [cursor done: ${state.cursor}/${STEP_NAMES.length} → next: ${STEP_NAMES[state.cursor] ?? 'end'}]`);
  else if (runEnd) lines2.push(`STATUS    ■ run ended (cursor ${runEnd.data.cursor}/15). Resume: node src/runner.js --upto 15`);
  else if (lastAbort) lines2.push(`STATUS    ✖ ABORTED at ${lastAbort.data.step} — check STEP_FAIL above it`);
  else lines2.push(`STATUS    ? unknown`);
  if (hb) {
    const d = hb.data;
    const lm = d.lastMoveTile ? `(${d.lastMoveTile[0]}, ${d.lastMoveTile[1]}) ${d.lastMoveAgeSec}s ago` : '? (no move sent yet)';
    const an = d.anchorTile ? `(${d.anchorTile[0]}, ${d.anchorTile[1]})` : '?';
    lines2.push(`POSITION  ${d.map}  ·  last move→ ${lm}  ·  hunt anchor ${an}`);
    const bagTot = (d.bag.used != null && d.bag.free != null) ? d.bag.used + d.bag.free : null;
    lines2.push(`CONDITION hp ~${d.hp ?? '?'}/${d.maxHp ?? '?'}  ·  sp ~${d.sp ?? '?'}/${d.maxSp ?? '?'}  ·  bag ${d.bag.used ?? '?'}/${bagTot ?? '?'} (free ${d.bag.free ?? '?'})  ·  weight ${d.bag.weight ?? '?'}/${d.bag.weightLimit ?? '?'}  ·  zeny ${d.zeny ?? '?'}  ·  auto:${d.auto}  dead:${d.dead}`);
    lines2.push(`LEVELS    base ${d.base ?? '?'} / job ${d.job ?? '?'}  ·  class ${d.classId ?? '?'}  ·  step ${d.step ?? '?'}  ·  kills ${d.killsTotal ?? 0} / hits taken ${d.hitsInTotal ?? 0}  ·  bashLv ${d.bashLv ?? '?'}  ·  weaves ${d.weaves ?? 0}  ·  hpPots ${d.hpItems ?? 0}  ·  pets ${d.pets ? d.pets.owned : '?'}${d.pets?.active ? ' (active: ' + d.pets.active + ')' : ''}  ·  ${d.stats ? `STR${d.stats.STR}/AGI${d.stats.AGI}/VIT${d.stats.VIT}/DEX${d.stats.DEX}` : ''}`);
  } else if (farm) lines2.push(`CHARACTER base ${farm.data.baseLevel} / job ${farm.data.jobLevel}  ·  exp ${farm.data.exp}  ·  job ${farm.data.job}  ·  weight ${farm.data.weight}  ·  auto:${farm.data.autoEnabled}  dead:${farm.data.dead}`);
  else if (charEv) lines2.push(`CHARACTER base ${charEv.data.base} / job ${charEv.data.job}  ·  class ${charEv.data.classId}  ·  skillPts ${charEv.data.skillPts}  ·  statPts ${charEv.data.statPts}  ·  zeny ${charEv.data.zeny}  (auto-farming)`);
  else lines2.push(`CHARACTER (no data yet this run)`);
  lines2.push(`ACTIVITY  last 10 min: ${kills} kills, ~${baseExp} base + ${jobExp} job exp  (~${(baseExp / 10).toFixed(0)} base/min)`);
  // skill usage + attack activity (last 10 min)
  const cut10 = Date.now() - 600000;
  const casts10 = evs.filter((e) => e.evt === 'skill_use' && new Date(e.t).getTime() >= cut10);
  const fx10 = evs.filter((e) => e.evt === 'skill_fx_self' && new Date(e.t).getTime() >= cut10);
  const bySkill = {};
  for (const cs of casts10) { const kk = cs.data?.s ?? '?'; bySkill[kk] = (bySkill[kk] || 0) + 1; }
  const lastCast = [...evs].reverse().find((e) => e.evt === 'skill_use');
  if (casts10.length || lastCast) {
    const skillStr = Object.entries(bySkill).sort((a, b) => b[1] - a[1]).map(([k2, v2]) => `${k2}×${v2}`).join(', ') || 'none';
    const lastAgo = lastCast ? Math.round((Date.now() - new Date(lastCast.t).getTime()) / 1000) : null;
    lines2.push(`SKILLS    last 10 min: ${skillStr}  ·  fx landed ×${fx10.length}  ·  last: ${lastCast ? `${lastCast.data.s}→${lastCast.data.t}` : 'n/a'}${lastAgo != null ? ` (${lastAgo}s ago)` : ''}`);
  }
  const hbSeen = evs.filter((e) => e.evt === 'HEARTBEAT' && e.data && e.data.mobHits != null);
  if (hbSeen.length >= 2) {
    const a = hbSeen[0].data.mobHits, b2 = hbSeen[hbSeen.length - 1].data.mobHits;
    const mins2 = (new Date(hbSeen[hbSeen.length - 1].t) - new Date(hbSeen[0].t)) / 60000;
    lines2.push(`ATTACKS   mob hits seen ×${b2} (~${mins2 > 0 ? Math.round((b2 - a) / mins2) : '?'}/min)  ·  incoming hits taken ×${hbSeen[hbSeen.length - 1].data.hitsInTotal ?? '?'}`);
  }
  const dropStr = Object.entries(drops).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}×${v}`).join(', ');
  if (dropStr) lines2.push(`DROPS     ${dropStr}`);
  if (auto) {
    const d = auto.data.cfg ?? auto.data;
    const m = d.monsters;
    const mStr = m == null ? '?' : (typeof m === 'number' ? (m === 0 ? 'ALL' : `${m} types`) : (m.length === 0 ? 'ALL' : m.join(',')));
    const s = d.skills;
    const sStr = typeof s === 'number' ? s : (s ? (Array.isArray(s) ? s.join(',') || 'none' : s) : 'none');
    lines2.push(`AUTO CFG  huntRadius:${d.huntRadiusTiles ?? d.radius} monsters:${mStr} skills:[${sStr}] hp<${d.hpPercent}%  pickup:${d.pickupLoot}  (enabled: ${auto.data.enabled})`);
  }
  else lines2.push(`AUTO CFG  (none set yet)`);
  if (lvlUp) lines2.push(`LAST LEVELUP  ${lvlUp.t}${lvlUp.data.base ? ' (base)' : ''}${lvlUp.data.job ? ' (job)' : ''}`);
  if (death) lines2.push(`DEATHS    last: ${death.t}  (respawned: ${respawned ? respawned.t : 'n/a'})`);
  if (notice) lines2.push(`QUEST     ${notice.data.text}`);
  if (err) lines2.push(`LAST WARN ${err.evt}: ${JSON.stringify(err.data).slice(0, 140)}`);
  lines2.push(`--- last 6 events ---`);
  for (const e of evs.slice(-6)) lines2.push(`${e.t}  ${e.evt}  ${JSON.stringify(e.data).slice(0, 120)}`);
  return lines2.join('\n');
}

if (process.argv.includes('--watch')) {
  setInterval(() => {
    console.clear();
    console.log(snapshot());
    console.log('\n(watch mode — refreshes every 15s, Ctrl+C to stop)');
  }, 15000);
  console.clear();
  console.log(snapshot());
  console.log('\n(watch mode — refreshes every 15s, Ctrl+C to stop)');
} else {
  console.log(snapshot());
}
