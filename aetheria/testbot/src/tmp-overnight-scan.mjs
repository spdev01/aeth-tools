// tmp-overnight-scan.mjs — what happened fleet-wide since the watchdog died (10-14T02:05 → now)?
// Reads each bot's newest run log; prints jail/captcha/whisper/alert events after the cutoff.
import fs from 'fs';
import path from 'path';

const BOTS = 'E:/GitHub/lumivaraonline/aetheria/command-center/data/bots';
const CUT = '2026-10-14T02:05:00';
let total = 0;
for (const d of fs.readdirSync(BOTS)) {
  const dir = path.join(BOTS, d);
  let st; try { st = fs.statSync(dir); } catch { continue; }
  if (!st.isDirectory()) continue;
  let rf; try { rf = fs.readdirSync(dir).filter((f) => f.startsWith('run-')).sort().pop(); } catch { continue; }
  if (!rf) continue;
  let lines; try { lines = fs.readFileSync(path.join(dir, rf), 'utf8').split('\n'); } catch { continue; }
  const hits = [];
  for (const l of lines) {
    if (!l || !/jail|captcha|whisper|message:alert/.test(l)) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (!o.t || o.t <= CUT) continue;
    if (/jail_hold_tick|HEARTBEAT/.test(o.evt)) continue;
    hits.push(`${o.t} ${o.evt} ${JSON.stringify(o.data ?? '').slice(0, 170)}`);
  }
  if (hits.length) { total += hits.length; console.log(`== ${d} (${rf}) ==`); for (const h of hits.slice(-30)) console.log('  ' + h); }
}
console.log(`scan done — ${total} events since ${CUT}`);
