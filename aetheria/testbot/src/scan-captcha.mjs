// Fleet-wide captcha/jail scanner — scans the newest run log of every bot.
// Usage: node src/scan-captcha.mjs [--all-logs]
import fs from 'fs';
import path from 'path';

const base = 'E:/GitHub/lumivaraonline/aetheria/command-center/data/bots';
const allLogs = process.argv.includes('--all-logs');

const rows = [];
for (const id of fs.readdirSync(base)) {
  const dir = path.join(base, id);
  if (!fs.statSync(dir).isDirectory()) continue;
  let files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  if (!allLogs) files = files.slice(-1);
  let cap = 0, jailAlert = 0, inJailAt = null, lastT = null;
  const caps = [];
  for (const f of files) {
    const p = path.join(dir, f);
    let lines;
    try { lines = fs.readFileSync(p, 'utf8').split('\n'); } catch { continue; }
    for (const l of lines) {
      if (!l.trim()) continue;
      let o;
      try { o = JSON.parse(l); } catch { continue; }
      lastT = o.t || lastT;
      if (o.evt === 'message:human_check') {
        cap++;
        caps.push(`${o.t.slice(11, 19)} "${String(o.data?.prompt || '').replace('กดรูป ', '')}" tries=${o.data?.triesLeft} items=${(o.data?.items || []).join(',')}`);
      }
      if (o.evt === 'message:alert' && JSON.stringify(o.data || '').includes('คุก')) jailAlert++;
      if (o.data && JSON.stringify(o.data).includes('jail')) inJailAt = o.t;
    }
  }
  if (cap || jailAlert || inJailAt) {
    rows.push({ id, cap, jailAlert, inJailAt, lastT, caps });
  }
}
rows.sort((a, b) => Number(a.id) - Number(b.id));
for (const r of rows) {
  console.log(`== ${r.id} : captchas=${r.cap} jailAlert=${r.jailAlert} lastJailMention=${r.inJailAt || '-'} lastEvent=${r.lastT}`);
  for (const c of r.caps) console.log(`     ${c}`);
}
console.log(`scanned ${fs.readdirSync(base).length} dirs; hits: ${rows.length}`);
