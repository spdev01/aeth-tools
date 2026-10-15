// tmp-jail-alert.mjs — watch bots for captcha/jail/whisper events; early-exit on jail or GM whisper so the
// agent gets a terminal-completion notification (= user alert). Safe to delete.
// usage: node src/tmp-jail-alert.mjs 108,109 [seconds=1800]
import fs from 'fs';
import path from 'path';

const BOTS = 'E:/GitHub/lumivaraonline/aetheria/command-center/data/bots';
const ids = (process.argv[2] || '').split(',').map((s) => s.trim()).filter(Boolean);
const total = parseInt(process.argv[3] || '1800', 10);
const printed = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().slice(11, 19);

console.log(`[${now()}] watch start — bots ${ids.join(',')} for ${total}s; early-exit on jail or GM whisper`);

let exitAt = null;
let exitReason = '';

for (let t = 0; t <= total; t += 10) {
  if (exitAt !== null && Date.now() >= exitAt) {
    console.log(`[${now()}] >>> ALERT_EXIT: ${exitReason}`);
    process.exit(0);
  }
  for (const id of ids) {
    const dir = path.join(BOTS, id);
    let file;
    try {
      file = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m)[0]?.f;
    } catch { continue; }
    if (!file) continue;
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/).filter(Boolean).slice(-400);
    for (const l of lines) {
      if (l.includes('"evt":"HEARTBEAT"')) continue;
      if (!/captcha|human_check|whisper|gm_reply|jail|message:alert/.test(l)) continue;
      let o; try { o = JSON.parse(l); } catch { continue; }
      const key = `${id}:${o.t}:${o.evt}:${(o.data && o.data.id) || ''}`;
      if (printed.has(key)) continue;
      printed.add(key);
      let d = ''; try { d = JSON.stringify(o.data); } catch {}
      if (d.length > 240) d = d.slice(0, 240);
      console.log(`[${now()}] bot ${id}  ${o.t ?? o.ts}  ${o.evt}  ${d}`);
      const evt = String(o.evt || '');
      if (exitAt === null) {
        if (/^jail/.test(evt)) { exitAt = Date.now() + 20000; exitReason = `JAIL on bot ${id} (${evt})`; }
        else if (evt === 'whisper_recv') { exitAt = Date.now() + 60000; exitReason = `GM whisper received by bot ${id}`; }
      }
    }
  }
  if (t > 0 && t % 600 === 0) console.log(`[${now()}] quiet — ${t}s elapsed, no jail/whisper yet`);
  await sleep(10000);
}
console.log(`[${now()}] watch finished — no jail or GM whisper in ${total}s`);
