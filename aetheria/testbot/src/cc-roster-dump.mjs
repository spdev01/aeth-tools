// cc-roster-dump.mjs — decode a captured session and dump the room roster + sample monsters
// (to confirm how the auto config's monster templateIds map to in-room monsters).
import fs from 'node:fs';
import { Reflection } from '@colyseus/schema';

const lines = fs.readFileSync('out/frames-bot47.jsonl', 'utf8').split('\n').filter(Boolean);
let decoder = null, state = null;
for (const line of lines) {
  const { b } = JSON.parse(line);
  const buf = Buffer.from(b, 'base64');
  const code = buf[0];
  if (code === 0x0a) {
    let off = 1;
    const l1 = buf[off++]; off += l1;
    const l2 = buf[off++]; off += l2;
    let rb = buf.subarray(off);
    if (rb.length > 3) { const m = rb[0]; if (m === 0xcc) rb = rb.subarray(2); else if (m === 0xcd) rb = rb.subarray(3); else if (m === 0xce) rb = rb.subarray(5); }
    decoder = Reflection.decode(rb);
    state = decoder.state;
  } else if ((code === 0x0e || code === 0x0f) && decoder) {
    try { decoder.decode(buf.subarray(1)); } catch {}
  }
}
if (!state) { console.log('no state'); process.exit(1); }
console.log('ROSTER entries:', JSON.stringify([...(state.roster ?? [])], null, 1).slice(0, 1200));
let n = 0;
for (const [id, mo] of state.monsters) {
  console.log('MONSTER', id, '::', JSON.stringify({ ...mo }).slice(0, 400));
  if (++n >= 3) break;
}
console.log('map:', state.mapId, 'players:', state.players?.size, 'monsters:', state.monsters?.size);
