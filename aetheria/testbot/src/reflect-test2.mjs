// Slicing matrix: which slice + which schema major decodes the reflection payload?
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const file = 'e:/GitHub/lumivaraonline/aetheria/testbot/out/handshake-rest.bin';
const raw = Array.from(new Uint8Array(fs.readFileSync(file)));
console.log('blob len:', raw.length, 'first bytes:', raw.slice(0, 8).map(b => b.toString(16)).join(' '));

const base = 'e:/GitHub/lumivaraonline/aetheria/testbot';
const libs = {
  's3.0.76': `${base}/node_modules/@colyseus/schema/build/esm/index.mjs`,
  's4.0.31': `${base}/.tmpvp/schema4/package/build/index.mjs`,
  's5.0.36': `${base}/.tmpvp/schema5/package/build/index.mjs`,
};

const slices = { 'full': 0, 'skip1': 1, 'skip2': 2, 'skip3': 3, 'skip4': 4, 'skip5': 5 };

for (const [name, p] of Object.entries(libs)) {
  let mod;
  try { mod = await import(pathToFileURL(p).href); } catch (e) { console.log(name, 'import fail:', e.message); continue; }
  const R = mod.Reflection;
  for (const [sname, n] of Object.entries(slices)) {
    const bytes = raw.slice(n);
    try {
      const state = R.decode(bytes, { offset: 0 });
      const cls = state?.constructor;
      const fields = cls?._definition ? Object.keys(cls._definition.schema) : null;
      console.log(`${name} / ${sname} -> OK! fields:`, fields ? fields.slice(0, 10) : '(none)', '| state keys:', Object.keys(state).slice(0, 8));
    } catch (e) {
      console.log(`${name} / ${sname} -> FAIL: ${e.message.slice(0, 90)}`);
    }
  }
}
