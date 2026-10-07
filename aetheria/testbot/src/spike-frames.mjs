// spike-frames.mjs — capture RAW protocol frames from a real bot session
// usage: node src/spike-frames.mjs <botId> [seconds]
// stop the bot first (single seat), run, then restart the bot.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AetheriaClient } from './client.js';

const id = process.argv[2];
const secs = Number(process.argv[3] || 75);
const base = `E:/GitHub/lumivaraonline/aetheria/command-center/data/bots/${id}`;
const ses = JSON.parse(fs.readFileSync(base + '/session.json', 'utf8'));
const rs = JSON.parse(fs.readFileSync(base + '/run-state.json', 'utf8'));

const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.resolve(here, '..', 'out', `frames-bot${id}.jsonl`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
process.env.TB_CAPTURE_FRAMES = outFile;

const c = new AetheriaClient({ token: ses.token });
c.on('join', () => console.log('JOINED:', JSON.stringify({ ...c.joinInfo, reflectionBytes: c.reflection && c.reflection.length })));
c.on('error', (e) => console.log('ERR:', JSON.stringify(e).slice(0, 300)));
c.on('message', (t, d) => { if (t === 'death' || t === 'respawned' || t === 'travel') console.log('MSG', t, JSON.stringify(d).slice(0, 180)); });

console.log(`connecting bot ${id} ${rs.charName} charId=${rs.characterId} -> capture ${outFile}`);
try {
  await c.connect(rs.characterId);
} catch (e) {
  console.log('CONNECT FAILED:', String((e && e.message) || e).slice(0, 300));
  process.exit(2);
}
console.log('connected. map =', c.mapId);

const t0 = Date.now();
while (Date.now() - t0 < secs * 1000) {
  await new Promise((r) => setTimeout(r, 5000));
  const n = fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean).length;
  process.stdout.write(`frames:${n} `);
}
console.log('');

const lines = fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean);
const hist = {};
let biggest = 0;
for (const l of lines) {
  const { b } = JSON.parse(l);
  const buf = Buffer.from(b, 'base64');
  if (buf.length > biggest) biggest = buf.length;
  const k = '0x' + buf[0].toString(16);
  hist[k] = (hist[k] || 0) + 1;
}
console.log('histogram:', JSON.stringify(hist), 'maxFrameBytes:', biggest, 'total:', lines.length);
try { await c.leaveGraceful(400); } catch {}
c.close();
process.exit(0);
