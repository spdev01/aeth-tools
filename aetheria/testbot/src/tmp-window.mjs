// tmp-window.mjs — print all non-HEARTBEAT events for a bot within a time window (safe to delete)
// usage: node src/tmp-window.mjs <botId> <fromIso> <toIso>
import fs from 'fs';
import path from 'path';

const BOTS = 'E:/GitHub/lumivaraonline/aetheria/command-center/data/bots';
const [id, from, to] = process.argv.slice(2);
const dir = path.join(BOTS, id);
const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))
  .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m).map(x => x.f);
console.log(`## BOT ${id} window ${from} .. ${to}`);
for (const f of files) {
  const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/);
  for (const l of lines) {
    if (!l) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    const t = o.t || o.ts || '';
    if (t < from || t > to) continue;
    if (o.evt === 'HEARTBEAT') continue;
    let d = '';
    try { d = JSON.stringify(o.data); } catch {}
    if (d.length > 170) d = d.slice(0, 170);
    console.log(`  ${t}  ${o.evt}  ${d}`);
  }
}
