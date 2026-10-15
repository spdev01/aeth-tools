// tmp-captcha-watch.mjs — watch newest run files of given bots for captcha events (safe to delete)
// usage: node src/tmp-captcha-watch.mjs 115,116,... [seconds=300]
import fs from 'fs';
import path from 'path';

const BOTS = 'E:/GitHub/lumivaraonline/aetheria/command-center/data/bots';
const ids = (process.argv[2] || '').split(',').map((s) => s.trim()).filter(Boolean);
const total = parseInt(process.argv[3] || '300', 10);
const printed = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`watching ${ids.length} bots for ${total}s — printing captcha-related events as they appear`);
for (let t = 0; t <= total; t += 15) {
  for (const id of ids) {
    const dir = path.join(BOTS, id);
    let file;
    try {
      file = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m)[0]?.f;
    } catch { continue; }
    if (!file) continue;
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/).filter(Boolean).slice(-500);
    for (const l of lines) {
      if (l.includes('"evt":"HEARTBEAT"')) continue;
      if (!/captcha|human_check|whisper|gm_reply|jail/.test(l)) continue;
      let o; try { o = JSON.parse(l); } catch { continue; }
      const key = `${id}:${o.t}:${o.evt}:${(o.data && o.data.id) || ''}`;
      if (printed.has(key)) continue;
      printed.add(key);
      let d = ''; try { d = JSON.stringify(o.data); } catch {}
      if (d.length > 260) d = d.slice(0, 260);
      console.log(`[${new Date().toISOString().slice(11, 19)}] bot ${id}  ${o.t ?? o.ts}  ${o.evt}  ${d}`);
    }
  }
  await sleep(15000);
}
console.log('done watching');
