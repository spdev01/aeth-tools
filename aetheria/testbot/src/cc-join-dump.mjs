// cc-join-dump.mjs — inspect the raw JOIN frame structure from a capture
import fs from 'node:fs';
const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean);
for (const l of lines) {
  const { at, b } = JSON.parse(l);
  const buf = Buffer.from(b, 'base64');
  if (buf[0] !== 0x0a) continue;
  console.log('frameLen', buf.length);
  console.log('head hex:', buf.subarray(0, 80).toString('hex').replace(/(..)/g, '$1 '));
  let off = 1;
  const l1 = buf[off++];
  console.log('str1 len', l1, JSON.stringify(buf.subarray(off, off + l1).toString('utf8')));
  off += l1;
  const l2 = buf[off++];
  console.log('str2 len', l2, JSON.stringify(buf.subarray(off, off + l2).toString('utf8')));
  off += l2;
  console.log('after strings offset =', off, '(remaining', buf.length - off, 'bytes)');
  console.log('refl head hex:', buf.subarray(off, off + 24).toString('hex').replace(/(..)/g, '$1 '));
  break;
}
