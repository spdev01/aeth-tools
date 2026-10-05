// Extract regions from minified bundle with wrapping for readability
import fs from 'node:fs';

const BUNDLE = 'e:/GitHub/lumivaraonline/aetheria/index-main.js';
const OUT = 'e:/GitHub/lumivaraonline/aetheria/out-grep';
const c = fs.readFileSync(BUNDLE, 'utf8');

function findAll(key, limit = 200) {
  const res = [];
  let i = -1;
  while (res.length < limit) {
    i = c.indexOf(key, i + 1);
    if (i < 0) break;
    res.push(i);
  }
  return res;
}

function wrap(s, width = 160) {
  // insert newline every width chars, prefix with continuing marker
  const lines = [];
  for (let i = 0; i < s.length; i += width) lines.push(s.slice(i, i + width));
  return lines.join('\n');
}

function dumpRegion(start, len, name) {
  const s = Math.max(0, start);
  const l = Math.min(len, c.length - s);
  const text = `OFFSET ${s} LEN ${l}\n` + wrap(c.slice(s, s + l), 160);
  fs.writeFileSync(`${OUT}/${name}.txt`, text, 'utf8');
  console.log(`WROTE ${name}: @${s} len ${l}`);
}

const args = process.argv.slice(2);
if (args[0] === 'find') {
  const term = args[1];
  const limit = Number(args[2] ?? 20);
  const vals = findAll(term, limit);
  console.log(term, '=>', vals.join(', '));
} else if (args[0] === 'dump') {
  const [start, len, name] = [Number(args[1]), Number(args[2]), args[3]];
  dumpRegion(start, len, name);
} else if (args[0] === 'dumpkey') {
  // dump N regions around each occurrence of key
  const key = args[1];
  const before = Number(args[2] ?? 100);
  const len = Number(args[3] ?? 600);
  const name = args[4];
  const occ = findAll(key, 50);
  occ.forEach((o, idx) => dumpRegion(o - before, len, `${name}-${idx + 1}`));
  console.log('occurrences:', occ.length);
}
