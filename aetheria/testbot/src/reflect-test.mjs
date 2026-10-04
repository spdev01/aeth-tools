// Which @colyseus/schema major can decode the captured reflection blob?
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const file = 'e:/GitHub/lumivaraonline/aetheria/testbot/out/handshake-rest.bin';
const bytes = Array.from(new Uint8Array(fs.readFileSync(file)));
console.log('reflection bytes:', bytes.length);

const base = 'e:/GitHub/lumivaraonline/aetheria/testbot';
const libs = {
  'schema3.0.76(installed)': `${base}/node_modules/@colyseus/schema/build/esm/index.mjs`,
  'schema4.0.31': `${base}/.tmpvp/schema4/package/build/index.mjs`,
  'schema5.0.36': `${base}/.tmpvp/schema5/package/build/index.mjs`,
};

for (const [name, p] of Object.entries(libs)) {
  try {
    const mod = await import(pathToFileURL(p).href);
    const R = mod.Reflection;
    try {
      const state = R.decode(bytes, { offset: 0 });
      const cls = state?.constructor;
      const fields = cls?._definition ? Object.keys(cls._definition.schema) : null;
      console.log(`${name} -> STATIC decode OK. state class fields:`, fields ? fields.slice(0, 14) : '(no _definition)');
    } catch (e) {
      console.log(`${name} -> STATIC decode FAIL: ${e.message}`);
      try {
        const r = new R();
        r.decode(bytes, { offset: 0 });
        console.log(`   instance decode OK: types=${r.types?.length} rootType=${r.rootType}`);
      } catch (e2) {
        console.log(`   instance decode FAIL: ${e2.message}`);
      }
    }
  } catch (e) { console.log(`${name} IMPORT FAIL: ${e.message}`); }
}
