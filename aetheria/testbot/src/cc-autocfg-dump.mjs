// cc-autocfg-dump.mjs — dump the FULL auto config schema the server keeps for a character
// (from the captured official-client session pushes in cc-epic-frames.jsonl).
import fs from 'node:fs';
import { decodeMulti } from '@msgpack/msgpack';

const FILE = 'E:/GitHub/lumivaraonline/aetheria/command-center/data/cc-epic-frames.jsonl';
const name = process.argv[2] || 'EpicWillow';
const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
let last = null;
for (const line of lines) {
  let o; try { o = JSON.parse(line); } catch { continue; }
  if (!Array.isArray(o)) continue;
  for (const batch of o) {
    if (batch?.kind !== 'frames') continue;
    for (const f of batch.items ?? []) {
      if (f.dir !== 'in') continue;
      const buf = Buffer.from(f.b, 'base64');
      if (buf[0] !== 0x0d) continue;
      try {
        const p = [...decodeMulti(buf.subarray(1))];
        if (String(p[0]) === 'character' && p[1]?.name === name) last = { at: f.at, d: p[1] };
      } catch {}
    }
  }
}
if (last) {
  console.log('captured at', new Date(last.at).toISOString());
  console.log('auto object:', JSON.stringify(last.d.auto, null, 1).slice(0, 1800));
} else console.log('no character push found for', name);
