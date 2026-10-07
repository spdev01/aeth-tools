// cc-death-crossref.mjs — cross-reference captured death broadcasts vs the AUTO button timeline.
// Reads the LAST frames/watch batches from cc-epic-frames.jsonl (the web-client experiment export).
import fs from 'node:fs';
import { decodeMulti } from '@msgpack/msgpack';

const FILE = 'E:/GitHub/lumivaraonline/aetheria/command-center/data/cc-epic-frames.jsonl';
const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
let frames = null, watch = null;
for (let i = lines.length - 1; i >= 0 && (!frames || !watch); i--) {
  try {
    const arr = JSON.parse(lines[i]);
    if (!Array.isArray(arr)) continue;
    for (const batch of arr) {
      if (batch?.kind === 'frames' && !frames) frames = batch;
      if (batch?.kind === 'watch' && !watch) watch = batch;
    }
  } catch {}
}
console.log('frames batch:', frames?.items?.length ?? 0, 'items, gen:', frames?.gen ?? '-');

const deaths = [], sends = [], charPushes = [], typeHist = {};
for (const it of frames?.items ?? []) {
  const buf = Buffer.from(it.b, 'base64');
  if (buf[0] !== 0x0d) continue;
  try {
    const parts = [...decodeMulti(buf.subarray(1))];
    const t = String(parts[0]);
    const d = parts[1];
    if (it.dir === 'in') { typeHist[t] = (typeHist[t] || 0) + 1; }
    if (it.dir === 'in' && (t === 'death' || t === 'respawned' || t === 'travel')) deaths.push({ at: it.at, t, d });
    if (it.dir === 'out' && (t === 'auto_set' || t === 'channel_switch')) sends.push({ at: it.at, t, d });
    if (it.dir === 'in' && (t === 'character' || t === 'char') && d && (d.name === 'EpicWillow' || d.sessionId === frames?.meta?.sid)) {
      charPushes.push({ at: it.at, auto: d.auto?.enabled ?? null, dead: d.dead ?? null, hp: d.hp ?? null, map: d.mapId ?? d.map ?? null });
    }
  } catch {}
}
console.log('\n=== in-message type histogram (top 20) ===');
for (const [t, n] of Object.entries(typeHist).sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${t}: ${n}`);

const btn = watch?.meta?.btn ?? [];
const kills = watch?.meta?.kills ?? [];
const fmt = (at) => new Date(at).toISOString().slice(11, 19);
const autoAt = (at) => { let cur = null; for (const b of btn) { if (b.at <= at && b.t) cur = b.t; } return cur ?? '(none yet)'; };

console.log(`\n=== death-ish broadcasts captured: ${deaths.length} ===`);
for (const d of deaths) {
  const near = btn.filter((b) => Math.abs(b.at - d.at) < 30000 && b.t);
  console.log(`${fmt(d.at)} ${d.t} autoRelease=${d.d?.autoReleaseSeconds ?? '-'} | AUTO at that moment: ${autoAt(d.at)} | btn state events ±30s: ${near.map((b) => b.t + '@' + fmt(b.at)).join(', ') || 'NONE'}`);
}

console.log(`\n=== our auto_set/channel sends: ${sends.length} ===`);
for (const s of sends) console.log(`${fmt(s.at)} ${s.t} ${JSON.stringify(s.d)}`);

console.log(`\n=== EpicWillow character pushes: ${charPushes.length} ===`);
let pAuto = null, pDead = null;
for (const cp of charPushes) {
  if (cp.auto !== pAuto || cp.dead !== pDead) {
    console.log(`${fmt(cp.at)} auto=${cp.auto} dead=${cp.dead} hp=${cp.hp}`);
    pAuto = cp.auto; pDead = cp.dead;
  }
}
if (charPushes.length) {
  const last = charPushes[charPushes.length - 1];
  console.log(`(last push ${fmt(last.at)} auto=${last.auto} dead=${last.dead} hp=${last.hp})`);
}

console.log(`\n=== kill lines (chat kills in room): ${kills.length} ===`);
for (const k of kills) console.log(`${fmt(k.at)} ${k.txt}`);

console.log('\n=== AUTO button timeline (state entries only) ===');
let prev = null;
for (const b of btn) { if (b.t && b.t !== prev) { console.log(`${fmt(b.at)} ${b.t} (hp ${b.hp ?? '?'})`); prev = b.t; } }
