// Hexdump every auto_set frame from the exported record
import fs from 'node:fs';
import { decodeMulti } from '@msgpack/msgpack';
const FILE = 'E:/GitHub/lumivaraonline/aetheria/command-center/data/cc-epic-frames.jsonl';
const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
for (const line of lines) {
  let o; try { o = JSON.parse(line); } catch { continue; }
  if (o.kind !== 'frames') continue;
  for (const f of o.items ?? []) {
    let buf; try { buf = Buffer.from(f.b, 'base64'); } catch { continue; }
    if (buf[0] !== 0x0d || f.dir !== 'out') continue;
    // try decode to find type
    let type = '?';
    try { const p = [...decodeMulti(buf.subarray(1))]; type = String(p[0]); } catch {}
    if (type !== 'auto_set') continue;
    console.log(new Date(f.at).toISOString(), 'len=' + buf.length, 'hex=' + buf.toString('hex'));
    try {
      const p = [...decodeMulti(buf.subarray(1))];
      console.log('   parts:', p.length, JSON.stringify(p).slice(0, 300));
    } catch (e) { console.log('   decode err', String(e.message).slice(0, 80)); }
  }
}
