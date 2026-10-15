// cc-copyread.mjs — read Deed's LIVE character frame (plagiarism `copiedSkill`) by borrowing the seat briefly.
// Flow: stop runner → kick if needed → connect as the character → wait for the `character` frame →
// print copiedSkill / skills → leave → restart the runner.
// usage: node src/cc-copyread.mjs [botId=213]
import fs from 'node:fs';
import { AetheriaClient } from './client.js';

const id = parseInt(process.argv[2] || '213', 10);
const CC = 'http://127.0.0.1:4310';
const API = 'https://www.aetheria-online.in.th';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jpost = async (p, body = '{}') => { try { const r = await fetch(CC + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }); return await r.json().catch(() => ({})); } catch { return {}; } };
const jget = async (p) => { try { const r = await fetch(CC + p); return await r.json(); } catch { return null; } };

console.log(`borrowing bot ${id} to read the character frame`);
await jpost(`/api/bots/${id}/stop`);
let stopped = false;
for (let i = 0; i < 60; i++) { const s = await jget('/api/state'); if (s?.bots?.find((x) => x.id === id)?.state === 'stopped') { stopped = true; break; } await sleep(1500); }
console.log('runner stopped:', stopped);
if (!stopped) { await jpost(`/api/bots/${id}/restart`); process.exit(1); }

const base = `E:/GitHub/lumivaraonline/aetheria/command-center/data/bots/${id}`;
const ses = JSON.parse(fs.readFileSync(base + '/session.json', 'utf8'));
const rs = JSON.parse(fs.readFileSync(base + '/run-state.json', 'utf8'));
const charId = rs.characterId;
const c = new AetheriaClient({ token: ses.token });

let charFrame = null;
c.on('message', (type, data) => {
  if (type === 'character' && data && typeof data === 'object') charFrame = data;
});
c.on('error', (e) => console.log('err', String(e?.message || e)));

const onlineNow = async () => {
  try {
    const r = await fetch(API + '/characters', { headers: { Authorization: `Bearer ${ses.token}` } });
    const j = await r.json().catch(() => null);
    const list = Array.isArray(j) ? j : (j?.characters ?? []);
    return list.find((x) => String(x.characterId) === String(charId))?.online ?? null;
  } catch { return null; }
};
const doKick = async () => { try { await fetch(`${API}/characters/${charId}/kick`, { method: 'POST', headers: { Authorization: `Bearer ${ses.token}` } }); } catch {} };

let on = await onlineNow();
for (let i = 0; i < 8 && on === true; i++) { await sleep(1500); on = await onlineNow(); }
if (on === true) {
  console.log('seat still held — kicking');
  await doKick();
  for (let i = 0; i < 6 && (await onlineNow()) === true; i++) await sleep(1500);
}
let connected = false;
for (let att = 0; att < 3 && !connected; att++) {
  try { await c.connect(charId); connected = true; }
  catch (e) {
    const msg = String((e && e.message) || e);
    if (/ออนไลน์อยู่แล้ว|already online/.test(msg) && att < 2) { await doKick(); await sleep(2500); continue; }
    throw e;
  }
}
console.log('connected; collecting character frame…');
for (let i = 0; i < 25 && !charFrame; i++) await sleep(1000);

const sk = charFrame?.skills ?? null;
const out = {
  at: new Date().toISOString(),
  copiedSkill: charFrame?.copiedSkill ?? null,
  grantedSkills: charFrame?.grantedSkills ?? null,
  classId: charFrame?.classId ?? null,
  baseLevel: charFrame?.baseLevel ?? null,
  skills: sk,
  hasGloriaKey: !!(sk && sk['gloria'] != null),
  hasFortuneKissKey: !!(sk && sk['fortune-kiss'] != null),
};
console.log(JSON.stringify(out, null, 2));

try { await c.leaveGraceful(); } catch (e) { console.log('leave err', String(e?.message || e)); }
await jpost(`/api/bots/${id}/restart`);
console.log('runner restarted');
process.exit(0);
