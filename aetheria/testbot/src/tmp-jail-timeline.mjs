// tmp-jail-timeline.mjs — print key event timeline for given bots (safe to delete)
import fs from 'fs';
import path from 'path';

const BOTS = 'E:/GitHub/lumivaraonline/aetheria/command-center/data/bots';
const ids = process.argv.slice(2);
const KEYS = ['human_check', 'ถูกส่งเข้าคุก', 'sold_except_keep', 'errand_done', 'auto_enable', 'auto_rescue', 'relogin', 'reconnect', 'jail', 'STEP_FAIL', 'wing_use', 'setAuto', 'loop_wedged', 'farm_mode_start', 'auto_off', 'pot_low_trip', 'pot_trip', 'channel_switch'];

for (const id of ids) {
  const dir = path.join(BOTS, id);
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m).map(x => x.f);
  } catch { console.log(`## ${id}: no dir`); continue; }
  console.log(`\n########## BOT ${id} — timeline of ${files[0]} ##########`);
  const lines = fs.readFileSync(path.join(dir, files[0]), 'utf8').split(/\r?\n/).filter(Boolean);
  let shown = 0;
  for (const l of lines) {
    if (!KEYS.some(k => l.includes(k))) continue;
    if (l.startsWith('{') && l.includes('"evt":"HEARTBEAT"')) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.evt === 'HEARTBEAT') continue;
    let d = '';
    try { d = JSON.stringify(o.data); } catch {}
    if (d.length > 150) d = d.slice(0, 150);
    console.log(`  ${o.t || o.ts}  ${o.evt}  ${d}`);
    if (++shown > 120) { console.log('  … (truncated)'); break; }
  }
}
