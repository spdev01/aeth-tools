// cc-state-decode.mjs — offline proof: decode a captured frame log into REAL room state.
// usage: node src/cc-state-decode.mjs <frames.jsonl> [playerName]
import fs from 'node:fs';
import { Reflection } from '@colyseus/schema';

const file = process.argv[2];
const wantName = process.argv[3] || null;
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

let decoder = null;
let state = null;
let mySid = null;
let states0e = 0, patches = 0, errs = 0;
const timeline = [];
let lastLogged = 0;

for (const line of lines) {
  const { at, b } = JSON.parse(line);
  const buf = Buffer.from(b, 'base64');
  const code = buf[0];
  if (code === 0x0a) {
    let off = 1;
    const l1 = buf[off++]; off += l1;
    const l2 = buf[off++]; off += l2;
    let reflBytes = buf.subarray(off);
    // strip the length-prefix marker the server puts before the reflection blob (0xcd uint16-LE, maybe 0xcc/0xce)
    if (reflBytes.length > 3) {
      const m = reflBytes[0];
      if (m === 0xcc) reflBytes = reflBytes.subarray(2);
      else if (m === 0xcd) reflBytes = reflBytes.subarray(3);
      else if (m === 0xce) reflBytes = reflBytes.subarray(5);
    }
    try {
      decoder = Reflection.decode(reflBytes);
      state = decoder.state;
      console.log('reflection OK. root:', state.constructor.name);
      console.log('root keys:', Object.keys(state).filter((k) => !k.startsWith('_') && !k.startsWith('$')).join(','));
    } catch (e) {
      console.log('reflection FAIL:', String(e && e.stack || e).slice(0, 400));
      break;
    }
  } else if (code === 0x0e || code === 0x0f) {
    if (!decoder) continue;
    try {
      decoder.decode(buf.subarray(1));
      if (code === 0x0e) {
        states0e++;
        console.log(`FULL STATE: mapId=${state.mapId} ch=${state.channel} players=${state.players?.size} monsters=${state.monsters?.size} drops=${state.drops?.size ?? '-'}`);
        for (const [sid, p] of state.players) {
          console.log(`  players[${sid}] ${p.name} hp=${p.hp}/${p.maxHp} sp=${p.sp}/${p.maxSp} dead=${p.dead} pos=(${Math.round(p.x)},${Math.round(p.y)}) lv=${p.baseLevel ?? p.level} zeny=${p.zeny}`);
          if (!mySid && wantName && p.name === wantName) mySid = sid;
        }
        if (!mySid && state.players?.size === 1) mySid = [...state.players.keys()][0];
      } else patches++;
      // sample our player
      if (state.players && mySid && state.players.has?.(mySid)) {
        const p = state.players.get(mySid);
        if (at - lastLogged > 10000) {
          timeline.push({ at, hp: p.hp, maxHp: p.maxHp, dead: !!p.dead, x: Math.round(p.x), y: Math.round(p.y) });
          lastLogged = at;
        }
      }
    } catch (e) {
      errs++;
      if (errs < 4) console.log('decode err on 0x' + code.toString(16) + ':', String(e && e.message || e).slice(0, 250));
    }
  }
}

console.log(`\n--- summary: 0x0e=${states0e} patches=${patches} decodeErrs=${errs} mySid=${mySid}`);
if (mySid && state?.players?.has?.(mySid)) {
  const p = state.players.get(mySid);
  console.log('FINAL our player:', JSON.stringify({ name: p.name, hp: p.hp, maxHp: p.maxHp, sp: p.sp, maxSp: p.maxSp, dead: !!p.dead, zeny: p.zeny, baseLevel: p.baseLevel ?? p.level }));
}
console.log('timeline(last 12):');
for (const t of timeline.slice(-12)) console.log(' ', new Date(t.at).toISOString().slice(11, 19), `hp=${t.hp}/${t.maxHp} dead=${t.dead} (${t.x},${t.y})`);
