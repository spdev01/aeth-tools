// Decode frames exported from the live game page (cc-epic-frames.jsonl) to inspect real wire messages.
// Frame format: byte0 0x0d = [msgpack(type), msgpack(data)]; 0x0e full state; 0x0f patch; 0x0a/0x0b/0x0c ctrl.
import fs from 'node:fs';
import { decodeMulti, decode } from '@msgpack/msgpack';

const FILE = process.argv[2] ?? 'E:/GitHub/lumivaraonline/aetheria/command-center/data/cc-epic-frames.jsonl';
const INTEREST = new Set((process.argv[3] ?? 'death,respawned,died,chat,hit,skill_fx,levelup,kicked,travel,error').split(','));

const MAX_SHOW = Number(process.argv[4] ?? 60);
let frames = 0; let watchItems = [];
const typeHist = {};
const shown = [];
const firstBytes = {};
const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
for (const line of lines) {
  let obj; try { obj = JSON.parse(line); } catch { continue; }
  if (obj.kind === 'watch') { watchItems = watchItems.concat(obj.items ?? []); continue; }
  if (obj.kind !== 'frames') continue;
  for (const f of obj.items ?? []) {
    frames++;
    const buf = Buffer.from(f.b, 'base64');
    const b0 = buf[0];
    firstBytes[b0] = (firstBytes[b0] ?? 0) + 1;
    if (b0 === 0x0d) {
      try {
        const items = [...decodeMulti(buf.subarray(1))];
        const type = items[0]; const data = items[1];
        typeHist[String(type)] = (typeHist[String(type)] ?? 0) + 1;
        if (INTEREST.has(String(type)) && shown.length < MAX_SHOW) {
          const dt = new Date(f.at).toISOString();
          shown.push({ at: dt, ts: f.at, dir: f.dir, type, data });
        }
      } catch (e) { typeHist['(decode-err)'] = (typeHist['(decode-err)'] ?? 0) + 1; }
    }
  }
}
console.log('frames:', frames);
console.log('bytes0:', JSON.stringify(firstBytes));
console.log('msgTypes:', JSON.stringify(typeHist));
console.log('watchItems:', watchItems.length);
const deb = watchItems.filter((w) => w.ev !== 'hp');
if (deb.length) console.log('watch-nonhp:', JSON.stringify(deb.slice(0, 30)));
console.log('--- interesting messages ---');
for (const s of shown) console.log(JSON.stringify(s).slice(0, 700));
