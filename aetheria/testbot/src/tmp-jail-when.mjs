// tmp-jail-when.mjs — captcha history (all recent files) + exact jail timestamps (safe to delete)
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
  } catch { console.log(`## ${id}: no dir`); continue; }
  let capTotal = 0;
  const caps = [], jails = [];
  for (const f of files.slice(0, 6)) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;
      if (line.includes('human_check')) {
        capTotal++;
        try { const o = JSON.parse(line); caps.push(`${o.t || o.ts}  ${f.slice(0, 26)}  ${o.data?.prompt || ''}`); } catch {}
      }
      if (line.includes('ถูกส่งเข้าคุก')) {
        try { const o = JSON.parse(line); jails.push(`${o.t || o.ts}  ALERT: ${(o.data?.title || '').slice(0, 40)}`); } catch {}
      }
    }
  }
  console.log(`\n## ${id}: captchas in last 6 files = ${capTotal}`);
  caps.forEach(c => console.log('   cap :', c));
  jails.forEach(j => console.log('   jail:', j));
}
