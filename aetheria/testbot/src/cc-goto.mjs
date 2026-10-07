// cc-goto.mjs — borrow a bot (stop → connect → walk to a map via real exits) → leave → optionally restart it.
// usage: node src/cc-goto.mjs <botId> <targetMapId> [--restart]
// With --restart: the bot's runner boots with the char standing on <targetMapId> — perfect for testing
// return-path features (e.g. ensureMap's capital→farm Alice warp) without waiting for a natural errand.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AetheriaClient } from './client.js';

const id = parseInt(process.argv[2] || '49', 10);
const target = process.argv[3] || 'capital';
const doRestart = process.argv.includes('--restart');
const CC = 'http://127.0.0.1:4310';
const API = 'https://www.aetheria-online.in.th';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAPS = path.join(root, 'maps');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jpost = async (p, body = '{}') => { try { const r = await fetch(CC + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }); return await r.json().catch(() => ({})); } catch { return {}; } };
const jget = async (p) => { try { const r = await fetch(CC + p); return await r.json(); } catch { return null; } };

const exitCache = {};
async function loadExits(mapId) {
  if (exitCache[mapId]) return exitCache[mapId];
  const file = path.join(MAPS, `${mapId}.json`);
  let j;
  if (fs.existsSync(file)) j = JSON.parse(fs.readFileSync(file, 'utf8'));
  else {
    const r = await fetch(`${API}/maps/${mapId}.json`);
    if (!r.ok) throw new Error(`map ${mapId}: HTTP ${r.status}`);
    j = await r.json(); fs.writeFileSync(file, JSON.stringify(j));
  }
  const exits = [];
  for (const layer of j.layers ?? []) {
    if (layer.type !== 'objectgroup') continue;
    for (const o of layer.objects ?? []) {
      const toMap = (o.properties ?? []).find((p) => p.name === 'toMap')?.value;
      if (toMap) exits.push({ toMap, cx: o.x + (o.width ?? 0) / 2, cy: o.y + (o.height ?? 0) / 2, name: o.name });
    }
  }
  exitCache[mapId] = exits;
  return exits;
}
async function routePath(from, to) {
  if (from === to) return [];
  const q = [[from, []]]; const seen = new Set([from]);
  while (q.length) {
    const [cur, p] = q.shift();
    let exits = [];
    try { exits = await loadExits(cur); } catch { continue; }
    for (const ex of exits) {
      if (ex.toMap === to) return [...p, ex.toMap];
      if (!seen.has(ex.toMap)) { seen.add(ex.toMap); q.push([ex.toMap, [...p, ex.toMap]]); }
    }
  }
  throw new Error(`no route ${from} -> ${to}`);
}

let lastTravel = null;
async function travelHopTo(c, nextMap) {
  const exits = await loadExits(c.mapId);
  const exit = exits.find((e) => e.toMap === nextMap);
  if (!exit) throw new Error(`no exit ${c.mapId} -> ${nextMap}`);
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    if (c.mapId === nextMap) return;
    c.moveToPx(exit.cx, exit.cy);
    const t1 = Date.now();
    while (Date.now() - t1 < 6500) {
      if (c.mapId === nextMap) return;
      if (lastTravel && lastTravel.at > t0) break;
      await sleep(250);
    }
    if (c.mapId === nextMap) return;
    if (lastTravel && lastTravel.at > t0) {
      try { await c.rejoinRoom(lastTravel.d); } catch (e) { console.log('  rejoin err', String((e && e.message) || e).slice(0, 120)); }
      await sleep(1200);
    }
  }
  throw new Error(`travel timeout ${nextMap}`);
}

console.log(`borrowing bot ${id} -> walk to ${target}`);
await jpost(`/api/bots/${id}/stop`);
let stopped = false;
for (let i = 0; i < 60; i++) { const s = await jget('/api/state'); if (s?.bots?.find((x) => x.id === id)?.state === 'stopped') { stopped = true; break; } await sleep(1500); }
console.log('runner stopped:', stopped);
if (!stopped) { if (doRestart) await jpost(`/api/bots/${id}/restart`); process.exit(1); }

const base = `E:/GitHub/lumivaraonline/aetheria/command-center/data/bots/${id}`;
const ses = JSON.parse(fs.readFileSync(base + '/session.json', 'utf8'));
const rs = JSON.parse(fs.readFileSync(base + '/run-state.json', 'utf8'));
const c = new AetheriaClient({ token: ses.token });
c.on('message', (type, data) => { if (type === 'travel') { lastTravel = { at: Date.now(), d: data }; console.log('  travel ->', data?.mapId); } });
c.on('error', (e) => console.log('ERR', JSON.stringify(e).slice(0, 200)));
const onlineNow = async () => {
  try {
    const r = await fetch(API + '/characters', { headers: { Authorization: `Bearer ${ses.token}` } });
    const j = await r.json().catch(() => null);
    const list = Array.isArray(j) ? j : (j?.characters ?? []);
    return list.find((x) => String(x.characterId) === String(rs.characterId))?.online ?? null;
  } catch { return null; }
};
const doKick = async () => { try { await fetch(`${API}/characters/${rs.characterId}/kick`, { method: 'POST', headers: { Authorization: `Bearer ${ses.token}` } }); } catch {} };

try {
  let on = await onlineNow();
  for (let i = 0; i < 8 && on === true; i++) { await sleep(1500); on = await onlineNow(); }
  if (on === true) { console.log('seat held — kicking'); await doKick(); for (let i = 0; i < 6 && (on = await onlineNow()) === true; i++) await sleep(1500); }
  let connected = false;
  for (let att = 0; att < 3 && !connected; att++) {
    try { await c.connect(rs.characterId); connected = true; }
    catch (e) {
      const msg = String((e && e.message) || e);
      if (/ออนไลน์อยู่แล้ว|already online/.test(msg) && att < 2) { await doKick(); await sleep(2500); continue; }
      throw e;
    }
  }
  console.log('connected at', c.mapId);
  if (c.mapId !== target) {
    const route = await routePath(c.mapId, target);
    console.log('route:', route.join(' -> '));
    for (const hop of route) { const t0 = Date.now(); await travelHopTo(c, hop); console.log(`  hop -> ${hop} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); }
  }
  console.log('ARRIVED at', c.mapId);
  try { await c.listCharacters(); } catch {}
} catch (e) {
  console.log('FAILED:', String((e && e.message) || e).slice(0, 200));
} finally {
  try { await c.leaveGraceful(400); } catch {}
  c.close();
  await sleep(1000);
  if (doRestart) { await jpost(`/api/bots/${id}/restart`); console.log(`bot ${id} restarted (runner boots in ${target})`); }
}
process.exit(0);
