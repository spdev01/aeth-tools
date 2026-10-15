// tmp-state-check.mjs — per-bot activity + captcha/jail state from newest run file (safe to delete)
import fs from 'fs';
import path from 'path';

const BOTS = 'E:/GitHub/lumivaraonline/aetheria/command-center/data/bots';
const ids = process.argv.slice(2);
for (const id of ids) {
  const dir = path.join(BOTS, id);
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m).map(x => x.f);
  } catch { console.log(`${id}: no dir`); continue; }
  const lines = fs.readFileSync(path.join(dir, files[0]), 'utf8').split(/\r?\n/).filter(Boolean);
  let lastKill = null, lastEvt = null, cap = null, jail = null, lastReconnect = null, holds = 0, wingAfterHold = 0, holdStartTs = null;
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    const t = o.t || o.ts || '';
    lastEvt = t;
    if (o.evt === 'kill') lastKill = t;
    if (o.evt === 'message:human_check') cap = t;
    if (o.evt === 'jail_detected' || (o.evt === 'message:alert' && JSON.stringify(o.data).includes('\u0e04\u0e38\u0e01'))) jail = t;
    if (o.evt === 'reconnect_start' || o.evt === 'relogin_ok') lastReconnect = t;
    if (o.evt === 'jail_hold_start') { holdStartTs = t; holds++; }
    if (holdStartTs && (o.evt === 'wing_use' || o.evt === 'travel_approach_capital' || o.evt === 'STEP_FAIL')) wingAfterHold++;
  }
  const minSinceKill = lastKill ? Math.round((Date.now() - Date.parse(lastKill)) / 60000) : null;
  console.log(`${id}: lastKill=${lastKill ?? '-'} (${minSinceKill == null ? '?' : minSinceKill + 'm ago'})  captcha=${cap ?? '-'}  JAIL=${jail ?? '-'}  jailHold=${holds}  postHoldBadEvents=${wingAfterHold}  lastEvent=${lastEvt}`);
}
