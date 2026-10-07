// probe — find the correct slice of the join tail that Reflection.decode accepts
import fs from 'node:fs';
import { Reflection } from '@colyseus/schema';
const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean);
let refl = null;
for (const l of lines) {
  const { b } = JSON.parse(l);
  const buf = Buffer.from(b, 'base64');
  if (buf[0] !== 0x0a) continue;
  let off = 1;
  const l1 = buf[off++]; off += l1;
  const l2 = buf[off++]; off += l2;
  refl = buf.subarray(off);
  break;
}
console.log('tail len', refl.length, 'first8', refl.subarray(0, 8).toString('hex'));
const variants = {
  'as-is': refl,
  'skip1': refl.subarray(1),
  'skip3': refl.subarray(3),
  'skip-prefix-by-marker(LEx)': (() => {
    let o = 0; const m = refl[o++]; let len = 0;
    if (m === 0xcc) { len = refl[o]; o += 1; }
    else if (m === 0xcd) { len = refl.readUInt16LE(o); o += 2; }
    else if (m === 0xce) { len = refl.readUInt32LE(o); o += 4; }
    console.log('  marker', m.toString(16), 'declared len', len, '-> payload from', o);
    return refl.subarray(o, o + len);
  })(),
};
for (const [name, bytes] of Object.entries(variants)) {
  try {
    const dec = Reflection.decode(bytes);
    const st = dec.state;
    console.log(`[${name}] OK root type=${st.constructor.name} types-known=${Object.keys(st).length} rootType=${st.rootType}`);
  } catch (e) {
    console.log(`[${name}] FAIL ${String((e && e.message) || e).slice(0, 120)}`);
  }
}
