// Decode WS capture frames from out-grep/market-capture1.json
import fs from 'node:fs';
import { decodeMulti } from '@msgpack/msgpack';

const IN = process.argv[2] ?? 'e:/GitHub/lumivaraonline/aetheria/out-grep/market-capture1.json';
const OUT = process.argv[3] ?? 'e:/GitHub/lumivaraonline/aetheria/out-grep/market-capture1-decoded.json';

const frames = JSON.parse(fs.readFileSync(IN, 'utf8'));
const decoded = [];
for (const f of frames) {
  const buf = Buffer.from(f.data, 'base64');
  const rec = { dir: f.dir, op: f.op, len: buf.length, hex0: buf[0]?.toString(16) };
  try {
    const payload = buf[0] === 0x0d ? buf.subarray(1) : buf;
    const msgs = [...decodeMulti(payload)];
    rec.msgs = msgs.map((m) => {
      // strip huge buffers
      return JSON.parse(JSON.stringify(m, (k, v) => {
        if (typeof v === 'string' && v.length > 20000) return v.slice(0, 200) + `...(${v.length})`;
        return v;
      }));
    });
  } catch (e) {
    rec.decodeErr = String(e).slice(0, 300);
    rec.hex = buf.subarray(0, 400).toString('hex');
  }
  decoded.push(rec);
}
fs.writeFileSync(OUT, JSON.stringify(decoded, null, 1), 'utf8');

// Summarize
for (const d of decoded) {
  if (!d.msgs) { console.log(`${d.dir} len=${d.len} DECODE_ERR ${d.decodeErr}`); continue; }
  const [type, data] = d.msgs;
  let brief = '';
  if (type === 'market_results') brief = `total=${data.total} page=${data.page} pageSize=${data.pageSize} listings=${data.listings?.length}`;
  else if (d.dir === 'send') brief = JSON.stringify(d.msgs).slice(0, 220);
  console.log(`${d.dir} len=${d.len} type=${type} ${brief}`);
}
console.log('OUT:', OUT);
