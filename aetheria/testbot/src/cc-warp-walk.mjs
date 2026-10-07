// cc-warp-walk.mjs — deterministic Alice warp discovery:
//   borrow a settled farming bot (fast stop) → walk it to the capital → talk to Alice (n6) →
//   pick the warp option → pick the target map → record transport → verify → restart the bot.
// The bot ends up back in the farm map via warp (exactly the fleet use case).
// usage: node src/cc-warp-walk.mjs [targetMapId] [maxAttempts]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AetheriaClient } from './client.js';

const TARGET = process.argv[2] || 'venom_swamp';
const maxAttempts = Number(process.argv[3] || 4);
const CC = 'http://127.0.0.1:4310';
const API = 'https://www.aetheria-online.in.th';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAPS = path.join(root, 'maps');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jpost = async (p, body = '{}') => { try { const r = await fetch(CC + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }); return await r.json().catch(() => ({})); } catch { return {}; } };
const jget = async (p) => { try { const r = await fetch(CC + p); return await r.json(); } catch { return null; } };
const ts = (at = Date.now()) => new Date(at).toISOString().slice(11, 19);

const atlas = JSON.parse(fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/world_atlas.json', 'utf8'));
const zone = atlas.zones.find((z) => z.mapId === TARGET);
const names = [zone?.mapName, zone?.name, TARGET].filter(Boolean);

// ---- map exits/routing (same as runner) ----
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

// ---- per-attempt state ----
let lastTravel = null, dlgSeq = 0, lastDialog = null;
const tried = new Set();

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

async function findCandidate() {
  const s = await jget('/api/state');
  if (!s?.bots) return null;
  const pool = (s.bots || []).filter((b) => b.id !== 51 && b.state === 'running' && b.status?.map === 'venom_swamp' && !tried.has(b.id));
  return pool.find((b) => String(b.status?.step ?? '').includes('farm-mode')) ?? pool[0] ?? null;
}

async function attempt(bot) {
  const id = bot.id;
  tried.add(id);
  lastTravel = null; dlgSeq = 0; lastDialog = null;
  console.log(`\n===== ATTEMPT bot ${id} (step=${bot.status?.step}) =====`);
  await jpost(`/api/bots/${id}/stop`);
  let stopped = false;
  for (let i = 0; i < 60; i++) { const s = await jget('/api/state'); if (s?.bots?.find((x) => x.id === id)?.state === 'stopped') { stopped = true; break; } await sleep(1500); }
  console.log('runner stopped:', stopped, `(${((Date.now() - bot.__t0) / 1000).toFixed(0)}s since detect)`.replace('NaN', '?'));
  if (!stopped) { await jpost(`/api/bots/${id}/restart`); return { ok: false, reason: 'did not stop' }; }
  const base = `E:/GitHub/lumivaraonline/aetheria/command-center/data/bots/${id}`;
  const ses = JSON.parse(fs.readFileSync(base + '/session.json', 'utf8'));
  const rs = JSON.parse(fs.readFileSync(base + '/run-state.json', 'utf8'));
  const trail = [];
  const c = new AetheriaClient({ token: ses.token });
  const NOISE = new Set(['b', 'hit', 'exp_gain', 'item_fx', 'item_gain', 'character', 'inventory', 'chat', 'monster', 'kill', 'drop']);
  c.on('message', (type, data) => {
    const at = Date.now();
    trail.push({ at, type, data });
    if (type === 'travel') { lastTravel = { at, d: data }; console.log(`[${ts(at)}] MSG travel -> ${data?.mapId ?? JSON.stringify(data).slice(0, 120)}`); return; }
    if (type === 'npc_dialog') { dlgSeq++; lastDialog = data; console.log(`[${ts(at)}] MSG npc_dialog :: ${JSON.stringify(data).slice(0, 380)}`); return; }
    if (!NOISE.has(String(type))) console.log(`[${ts(at)}] MSG ${type} :: ${JSON.stringify(data).slice(0, 300)}`);
  });
  c.on('error', (e) => console.log('ERR', JSON.stringify(e).slice(0, 250)));
  const wait = async (pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(150); } return false; };
  const result = { ok: false, reason: '', botId: id };
  try {
    const onlineNow = async () => {
      try {
        const r = await fetch(API + '/characters', { headers: { Authorization: `Bearer ${ses.token}` } });
        const j = await r.json().catch(() => null);
        const list = Array.isArray(j) ? j : (j?.characters ?? []);
        return list.find((x) => String(x.characterId) === String(rs.characterId))?.online ?? null;
      } catch { return null; }
    };
    const doKick = async () => { try { await fetch(`${API}/characters/${rs.characterId}/kick`, { method: 'POST', headers: { Authorization: `Bearer ${ses.token}` } }); } catch {} };
    let on = await onlineNow();
    for (let i = 0; i < 8 && on === true; i++) { await sleep(1500); on = await onlineNow(); }
    if (on === true) { console.log('seat still held — kicking'); await doKick(); for (let i = 0; i < 6 && (on = await onlineNow()) === true; i++) await sleep(1500); }
    console.log('seat online flag:', on, '| connecting', rs.charName);
    let connected = false;
    for (let att = 0; att < 3 && !connected; att++) {
      try { await c.connect(rs.characterId); connected = true; }
      catch (e) {
        const msg = String((e && e.message) || e);
        if (/ออนไลน์อยู่แล้ว|already online/.test(msg) && att < 2) { console.log('already-online — kick+retry', att + 1); await doKick(); await sleep(2500); continue; }
        throw e;
      }
    }
    console.log('map =', c.mapId);

    // 1) walk to capital
    if (c.mapId !== 'capital') {
      const route = await routePath(c.mapId, 'capital');
      console.log('route:', route.join(' -> '));
      for (const hop of route) {
        const t0 = Date.now();
        await travelHopTo(c, hop);
        console.log(`hop -> ${hop} in ${((Date.now() - t0) / 1000).toFixed(1)}s | mapId=${c.mapId}`);
      }
    }
    if (c.mapId !== 'capital') { result.reason = 'walk to capital failed'; return result; }
    const walkMs = Date.now() - (bot.__t0 || Date.now());

    // 2) Alice
    for (let i = 0; i < 30; i++) { const lv = c.live; if (lv && Math.hypot(lv.x - 1808, lv.y - 1616) < 55) break; c.moveToPx(1808, 1616); await sleep(850); }
    console.log('at Alice:', JSON.stringify(c.live));
    let s0 = dlgSeq;
    c.npcTalk('n6');
    if (!await wait(() => dlgSeq > s0, 8000)) { result.reason = 'no dialog from n6'; return result; }
    console.log('DIALOG 1:', JSON.stringify(lastDialog));
    const opts1 = lastDialog?.options ?? [];
    const warpIdx = opts1.findIndex((o) => /วาร์ป|วาป|warp|เทเลพอร์ต|teleport|ย้าย/i.test(String(o)));
    console.log('warp option ->', warpIdx, JSON.stringify(opts1[warpIdx] ?? null));
    if (warpIdx < 0) { result.reason = 'no warp option'; return result; }

    s0 = dlgSeq;
    const tWarp0 = Date.now();
    c.npcOption(warpIdx);
    await wait(() => dlgSeq > s0 || trail.some((x) => x.type === 'warp_menu' && x.at >= tWarp0), 12000);
    const menu = [...trail].reverse().find((x) => x.type === 'warp_menu' && x.at >= tWarp0)?.data ?? null;
    const tPick = Date.now();
    if (menu) {
      // server sent the world-map menu: destinations + zeny costs (client renders the map UI)
      console.log('WARP MENU:', JSON.stringify(menu));
      const dests = menu.destinations ?? [];
      if (!dests.includes(TARGET)) { result.reason = 'target not in warp list'; result.destinations = dests; return result; }
      console.log('target listed:', TARGET, '| cost:', menu.costs?.[TARGET] ?? null);
      // bundle-confirmed official command: room.send('npc_warp', { mapId })  (client warpTo())
      const cmds = [
        ['npc_warp', { mapId: TARGET }],
        ['warp', { mapId: TARGET }],
        ['warp', { to: TARGET }],
        ['npc_option', { index: dests.indexOf(TARGET) }],
      ];
      let hit = null;
      for (const [m, d] of cmds) {
        const tCmd = Date.now();
        c.send(m, d);
        const ok = await wait(() => c.mapId === TARGET || (lastTravel && lastTravel.at >= tCmd), 8000);
        console.log(`  cmd ${m} ${JSON.stringify(d)} -> ${ok ? 'REACTED ✅' : 'silence'}`);
        if (ok) { hit = { m, d }; break; }
      }
      result.cmd = hit;
      if (!hit) { result.reason = 'no teleport command worked'; return result; }
      console.log('TELEPORT COMMAND:', JSON.stringify(hit));
    } else if (dlgSeq > s0) {
      const opts2 = lastDialog?.options ?? [];
      const tIdx = opts2.findIndex((o) => names.some((n) => String(o).includes(n)));
      console.log('dialog destinations ->', tIdx, JSON.stringify(opts2[tIdx] ?? null));
      if (tIdx < 0) { result.reason = 'target not listed'; result.dialog2 = opts2; return result; }
      c.npcOption(tIdx);
      await wait(() => dlgSeq > s0, 5000);
    } else {
      const after = trail.filter((x) => x.at >= tWarp0).map((x) => x.type);
      console.log('nothing after warp choice — types:', JSON.stringify(after));
      result.reason = 'no menu or dialog'; return result;
    }

    // 3) transport
    let travelMsg = null;
    const t0b = Date.now();
    while (Date.now() - t0b < 25000) {
      travelMsg = [...trail].reverse().find((x) => x.type === 'travel' && x.at >= tPick) ?? null;
      if (travelMsg || c.mapId === TARGET) break;
      await sleep(400);
    }
    const warpMs = Date.now() - tPick;
    console.log(`transport: travel=${travelMsg ? JSON.stringify(travelMsg.data) : 'none'} mapId=${c.mapId} warpMs=${warpMs}`);
    if (travelMsg && c.mapId !== TARGET) {
      try { await c.rejoinRoom(travelMsg.data); console.log('rejoined. mapId =', c.mapId); } catch (e) { console.log('rejoin fail:', String((e && e.message) || e).slice(0, 140)); }
    }
    await sleep(1500);
    try {
      const cl = await c.listCharacters();
      const list = Array.isArray(cl) ? cl : (cl?.characters ?? []);
      const me = list.find((x) => String(x.characterId) === String(rs.characterId));
      console.log('REST mapName =', me?.mapName, '| online =', me?.online);
    } catch {}
    result.ok = c.mapId === TARGET;
    result.warpMs = warpMs;
    result.walkMs = walkMs;
    if (!result.ok) result.reason = 'transport did not land on target';
    if (result.ok) fs.writeFileSync(`out/warp-walk-${id}-${Date.now()}.json`, JSON.stringify({ id, TARGET, walkMs, warpMs, trail }, null, 1));
    return result;
  } catch (e) {
    result.reason = 'exception: ' + String((e && e.message) || e).slice(0, 160);
    return result;
  } finally {
    try { fs.writeFileSync(`out/warp-walk-${id}-${Date.now()}.json`, JSON.stringify({ id, TARGET, result, trail }, null, 1)); } catch {}
    try { await c.leaveGraceful(300); } catch {}
    c.close();
    await jpost(`/api/bots/${id}/restart`);
    console.log(`bot ${id} restart requested`);
    await sleep(4000);
  }
}

let n = 0;
while (n < maxAttempts) {
  const cand = await findCandidate();
  if (!cand) { console.log('no venom farming candidate — waiting 10s...'); await sleep(10000); n++; continue; }
  cand.__t0 = Date.now();
  n++;
  const r = await attempt(cand);
  console.log('RESULT:', JSON.stringify(r));
  if (r.ok) { console.log(`WARP PROVEN ✅ (warp took ${(r.warpMs / 1000).toFixed(1)}s; walk took ${(r.walkMs / 1000).toFixed(1)}s)`); process.exit(0); }
  if (r.dialog2) { console.log('(!) Destination dialog captured — check DIALOG 2 above (target not listed).'); process.exit(2); }
}
console.log('attempts exhausted:', [...tried].join(', '));
process.exit(1);
