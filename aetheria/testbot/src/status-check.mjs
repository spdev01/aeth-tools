// Status check: swordsman? auto on? whole-map? — all from run logs
import fs from 'node:fs';
const dir = 'e:/GitHub/lumivaraonline/aetheria/testbot/out';
const files = fs.readdirSync(dir).filter((f) => f.startsWith('run-') && f.endsWith('.jsonl')).sort();
const latest = files[files.length - 1];
console.log('=== LATEST RUN:', latest, '===');
const lines = fs.readFileSync(`${dir}/${latest}`, 'utf8').trim().split('\n');
const ev = (l) => { try { return JSON.parse(l); } catch { return null; } };
// last farm status
for (let i = lines.length - 1; i >= 0; i--) { const e = ev(lines[i]); if (e?.evt === 'farm_status') { console.log('LAST farm_status:', JSON.stringify(e.data)); break; } }
// last setAuto (full cfg)
for (let i = lines.length - 1; i >= 0; i--) { const e = ev(lines[i]); if (e?.evt === 'setAuto') { console.log('LAST setAuto cfg:', JSON.stringify(e.data.cfg)); break; } }
// count kills in this run
let gains = 0; for (const l of lines) { const e = ev(l); if (e?.evt === 'message:exp_gain') gains++; }
console.log('exp_gain events (kills) this run:', gains);

console.log('\n=== ALL STEP_DONE across runs (class-change history) ===');
for (const f of files) {
  const ls = fs.readFileSync(`${dir}/${f}`, 'utf8').trim().split('\n');
  for (const l of ls) { const e = ev(l); if (e?.evt === 'STEP_DONE') console.log(f, '->', e.data.step); }
}
console.log('\n=== Valkyrie dialog capture (from earlier run) ===');
const vlog = files.find((f) => f.includes('10-51-44'));
if (vlog) {
  const ls = fs.readFileSync(`${dir}/${vlog}`, 'utf8').split('\n');
  for (const l of ls) {
    const e = ev(l);
    if (e?.evt === 'npc_dialog') console.log('dialog:', JSON.stringify(e.data.options ?? e.data.text).slice(0, 200));
    if (e?.evt === 'chose') console.log('chose:', JSON.stringify(e.data));
  }
}
console.log('\n=== What the server thinks (latest statuses) ===');
const last = [];
for (let i = lines.length - 1; i >= 0 && last.length < 8; i--) { const e = ev(lines[i]); if (e?.evt?.startsWith('message:') || e?.evt === 'farm_done' || e?.evt === 'STEP_DONE' || e?.evt === 'STEP_START') last.unshift(`${e.t} ${e.evt} ${JSON.stringify(e.data)?.slice(0, 140)}`); }
console.log(last.join('\n'));
