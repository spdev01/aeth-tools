// tmp-jail-scan.mjs — one-off jail/captcha forensics (safe to delete)
import fs from 'fs';
import path from 'path';

const BOTS = 'E:/GitHub/lumivaraonline/aetheria/command-center/data/bots';
const targets = process.argv.slice(2);

function newestFiles(botDir, n) {
  return fs.readdirSync(botDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({ f, m: fs.statSync(path.join(botDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, n)
    .map(x => x.f);
}

function fmt(line) {
  let o;
  try { o = JSON.parse(line); } catch { return line.slice(0, 200); }
  let d = '';
  if (o.data !== undefined) { try { d = JSON.stringify(o.data); } catch { d = ''; } }
  if (d.length > 200) d = d.slice(0, 200);
  return `${o.ts || ''} ${o.evt || ''} ${d}`;
}

function tsOf(line) {
  try { return JSON.parse(line).ts; } catch { return '?'; }
}

function scanFile(file, { detail = false } = {}) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const hc = [], jl = [];
  lines.forEach((l, i) => {
    if (l.includes('human_check')) hc.push(i);
    if (l.includes('jail')) jl.push(i);
  });
  const out = { file, total: lines.length, hc, jl };
  if (detail) {
    out.aroundHc = hc.length ? lines.slice(Math.max(0, hc[0] - 6), hc[0] + 17).map(fmt) : [];
    out.aroundJl = jl.length ? lines.slice(Math.max(0, jl[0] - 10), jl[0] + 21).map(fmt) : [];
    out.tail = lines.slice(-8).map(fmt);
    if (hc.length) out.lastHcTs = tsOf(lines[hc[hc.length - 1]]);
    if (jl.length) out.lastJlTs = tsOf(lines[jl[jl.length - 1]]);
  }
  return out;
}

if (targets.length) {
  for (const id of targets) {
    const dir = path.join(BOTS, id);
    console.log(`\n########## BOT ${id} ##########`);
    let files;
    try { files = newestFiles(dir, 3); } catch { console.log('  (no bot dir)'); continue; }
    for (const f of files) {
      const r = scanFile(path.join(dir, f), { detail: true });
      console.log(`--- ${f}  lines=${r.total} human_check=${r.hc.length} jail=${r.jl.length}${r.lastHcTs ? ' lastHcTs=' + r.lastHcTs : ''}${r.lastJlTs ? ' lastJlTs=' + r.lastJlTs : ''}`);
      if (r.aroundHc.length) { console.log('  >> around first human_check:'); r.aroundHc.forEach(x => console.log('   ' + x)); }
      if (r.aroundJl.length) { console.log('  >> around first jail:'); r.aroundJl.forEach(x => console.log('   ' + x)); }
      console.log('  >> tail:'); r.tail.forEach(x => console.log('   ' + x));
    }
  }
} else {
  const ids = fs.readdirSync(BOTS).filter(d => fs.statSync(path.join(BOTS, d)).isDirectory())
    .sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
  for (const id of ids) {
    let files;
    try { files = newestFiles(path.join(BOTS, id), 1); } catch { continue; }
    if (!files.length) { console.log(`${id}: (no logs)`); continue; }
    const r = scanFile(path.join(BOTS, id, files[0]));
    const flags = [];
    if (r.hc.length) flags.push('HC');
    if (r.jl.length) flags.push('JAIL');
    console.log(`${id}: lines=${r.total} human_check=${r.hc.length} jail=${r.jl.length} ${flags.join(' ')} ${files[0]}`);
  }
}
