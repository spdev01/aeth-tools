// Inspect the LAST 'character' message + all auto_set frames in the exported jsonl
import fs from 'node:fs';
import { decodeMulti } from '@msgpack/msgpack';
const FILE = 'E:/GitHub/lumivaraonline/aetheria/command-center/data/cc-epic-frames.jsonl';
const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
let lastChar = null; const autoSets = [];
for (const line of lines) {
  let o; try { o = JSON.parse(line); } catch { continue; }
  if (o.kind !== 'frames') continue;
  for (const f of o.items ?? []) {
    let buf; try { buf = Buffer.from(f.b, 'base64'); } catch { continue; }
    if (buf[0] !== 0x0d) continue;
    try {
      const p = [...decodeMulti(buf.subarray(1))];
      const type = String(p[0]);
      if (type === 'character') lastChar = { at: f.at, data: p[1] };
      if (type === 'auto_set') autoSets.push({ at: f.at, dir: f.dir, data: p[1] });
    } catch {}
  }
}
if (lastChar) {
  const d = lastChar.data;
  console.log('last character @', new Date(lastChar.at).toISOString());
  console.log('auto:', JSON.stringify(d.auto));
  console.log('hpItems:', JSON.stringify(d.hpItems ?? null));
  console.log('skill count:', d.skills ? Object.keys(d.skills).length : null);
  console.log('keys:', Object.keys(d).slice(0, 40).join(','));
} else console.log('no character msg');
console.log('auto_set frames:', autoSets.length);
for (const a of autoSets.slice(-12)) console.log(JSON.stringify({ at: new Date(a.at).toISOString(), dir: a.dir, data: a.data }).slice(0, 400));
