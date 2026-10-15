// tmp-captcha-origins.mjs — what each captcha victim was doing right before the challenge (safe to delete)
import fs from 'fs';
import path from 'path';

const bases = [
  'E:/GitHub/lumivaraonline/aetheria/testbot/evidence/jailed-110-113',
  'E:/GitHub/lumivaraonline/aetheria/testbot/evidence/jail-2026-10-12',
  'E:/GitHub/lumivaraonline/aetheria/testbot/evidence/main-group-205-213',
];
const liveDir = 'E:/GitHub/lumivaraonline/aetheria/command-center/data/bots';
const victims = [110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 203, 205];
const parse = (l) => { try { return JSON.parse(l); } catch { return null; } };

for (const id of victims) {
  const cands = [];
  for (const b of bases) {
    if (!fs.existsSync(b)) continue;
    for (const f of fs.readdirSync(b)) if (f.startsWith(`bot-${id}-`) && f.endsWith('.jsonl')) cands.push(path.join(b, f));
  }
  const live = path.join(liveDir, String(id));
  if (fs.existsSync(live)) for (const f of fs.readdirSync(live)) if (f.endsWith('.jsonl')) cands.push(path.join(live, f));
  let hit = null;
  for (const f of cands) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean);
    const idx = lines.findIndex((l) => l.includes('"evt":"message:human_check"'));
    if (idx >= 0) { hit = { f, lines, idx }; break; }
  }
  if (!hit) { console.log(`\n## ${id}: no captcha file available (purged)`); continue; }
  const { lines, idx } = hit;
  const cap = parse(lines[idx]);
  const capT = cap.t;
  let anchor = null;
  for (let i = idx; i >= 0; i--) {
    const o = parse(lines[i]); if (!o) continue;
    if (['joined', 'run_start', 'relogin_ok', 'reconnect_done'].includes(o.evt)) { anchor = o; break; }
  }
  const deltaSec = anchor ? Math.round((Date.parse(capT) - Date.parse(anchor.t)) / 1000) : null;
  const prev = [];
  for (let i = idx - 1; i >= 0 && prev.length < 8; i--) {
    const o = parse(lines[i]); if (!o || o.evt === 'HEARTBEAT') continue;
    prev.push(`${o.t.slice(11, 19)} ${o.evt}`);
  }
  console.log(`\n## ${id}: captcha ${capT.slice(11, 19)}  (last ${anchor?.evt ?? '?'} ${anchor?.t?.slice(11, 19)} → +${deltaSec}s)`);
  console.log('   before:', prev.reverse().join(' | '));
  console.log('   prompt:', JSON.stringify(cap.data?.prompt || ''), 'items:', JSON.stringify(cap.data?.items || []), 'tries:', cap.data?.triesLeft);
}
