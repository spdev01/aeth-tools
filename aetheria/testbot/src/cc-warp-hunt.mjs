// cc-warp-hunt.mjs — catch a fleet bot while it's in the capital, borrow it, probe Alice's (n6) warp
// dialog end-to-end (walk → talk → warp option → destination list → select target → record transport),
// then restart the bot. Retries with other candidates if someone left the capital mid-attempt.
// usage: node src/cc-warp-hunt.mjs [targetMapId] [maxAttempts]
import fs from 'node:fs';
import { AetheriaClient } from './client.js';

const target = process.argv[2] || 'venom_swamp';
const maxAttempts = Number(process.argv[3] || 12);
const CC = 'http://127.0.0.1:4310';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jpost = async (p, body = '{}') => { try { const r = await fetch(CC + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }); return await r.json().catch(() => ({})); } catch { return {}; } };
const jget = async (p) => { try { const r = await fetch(CC + p); return await r.json(); } catch { return null; } };

const atlas = JSON.parse(fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/world_atlas.json', 'utf8'));
const zone = atlas.zones.find((z) => z.mapId === target);
const names = [zone?.mapName, zone?.name, target].filter(Boolean);

const tried = new Set();
const prevMaps = new Map();
async function findCandidate() {
  const s = await jget('/api/state');
  if (!s?.bots) return null;
  const capBots = (s.bots || []).filter((b) => b.id !== 51 && b.status?.map === 'capital' && !tried.has(b.id));
  // prefer bots that JUST arrived in the capital (wasn't capital on the previous poll) — most remaining time
  const fresh = capBots.find((b) => prevMaps.has(b.id) && prevMaps.get(b.id) !== 'capital');
  for (const b of (s.bots || [])) prevMaps.set(b.id, b.status?.map);
  return fresh ?? capBots[0] ?? null;
}

async function attempt(bot) {
  const id = bot.id;
  tried.add(id);
  console.log(`\n===== ATTEMPT bot ${id} =====`);
  await jpost(`/api/bots/${id}/stop`);
  // wait for the runner PROCESS to actually exit (mid-errand runners only stop at their next checkpoint)
  let stopped = false;
  for (let i = 0; i < 45; i++) {
    const s = await jget('/api/state');
    const st = s?.bots?.find((x) => x.id === id)?.state;
    if (st === 'stopped') { stopped = true; break; }
    await sleep(2000);
  }
  console.log('runner stopped:', stopped);
  if (!stopped) { await jpost(`/api/bots/${id}/restart`); return { ok: false, reason: 'runner did not stop', botId: id }; }
  const base = `E:/GitHub/lumivaraonline/aetheria/command-center/data/bots/${id}`;
  const ses = JSON.parse(fs.readFileSync(base + '/session.json', 'utf8'));
  const rs = JSON.parse(fs.readFileSync(base + '/run-state.json', 'utf8'));
  const trail = [];
  let dlgSeq = 0, lastDialog = null;
  const c = new AetheriaClient({ token: ses.token });
  c.on('message', (type, data) => {
    const at = Date.now();
    trail.push({ at, type, data });
    if (type === 'npc_dialog') { dlgSeq++; lastDialog = data; }
    if (type === 'npc_dialog' || type === 'travel') console.log(`[${new Date(at).toISOString().slice(11, 19)}] MSG ${type} :: ${JSON.stringify(data).slice(0, 340)}`);
  });
  c.on('error', (e) => console.log('ERR', JSON.stringify(e).slice(0, 250)));
  const wait = async (pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(150); } return false; };
  const result = { ok: false, reason: '', botId: id };
  try {
    // seat might still be held briefly by the dead session — poll the char's online flag, kick if needed
    const API = 'https://www.aetheria-online.in.th';
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
    console.log('seat online flag:', on);
    console.log(`connecting ${rs.charName} charId=${rs.characterId}`);
    let connected = false;
    for (let att = 0; att < 3 && !connected; att++) {
      try { await c.connect(rs.characterId); connected = true; }
      catch (e) {
        const msg = String((e && e.message) || e);
        if (/ออนไลน์อยู่แล้ว|already online/.test(msg) && att < 2) { console.log('already-online on connect — kick+retry', att + 1); await doKick(); await sleep(2500); continue; }
        throw e;
      }
    }
    console.log('map =', c.mapId);
    if (c.mapId !== 'capital') { result.reason = 'left capital before connect'; return result; }
    for (let i = 0; i < 30; i++) {
      const lv = c.live;
      if (lv && Math.hypot(lv.x - 1808, lv.y - 1616) < 55) break;
      c.moveToPx(1808, 1616);
      await sleep(850);
    }
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
    c.npcOption(warpIdx);
    if (!await wait(() => dlgSeq > s0, 8000)) { result.reason = 'no destination dialog'; return result; }
    console.log('DIALOG 2:', JSON.stringify(lastDialog));
    const opts2 = lastDialog?.options ?? [];
    const tIdx = opts2.findIndex((o) => names.some((n) => String(o).includes(n)));
    console.log('target option ->', tIdx, JSON.stringify(opts2[tIdx] ?? null), '| looking for:', JSON.stringify(names));
    if (tIdx < 0) { result.reason = 'target not listed'; result.dialog2 = opts2; return result; }
    s0 = dlgSeq;
    const tPick = Date.now();
    c.npcOption(tIdx);
    await wait(() => dlgSeq > s0, 5000);
    console.log('DIALOG 3:', JSON.stringify(lastDialog));
    const opts3 = lastDialog?.options ?? [];
    if (dlgSeq > s0 && opts3.length && opts3.length <= 3) {
      const confIdx = opts3.findIndex((o) => /ยืนยัน|ตกลง|ใช่|confirm|ไป|ok/i.test(String(o)));
      if (confIdx >= 0) {
        const s1 = dlgSeq;
        c.npcOption(confIdx);
        console.log('confirmed via', confIdx, JSON.stringify(opts3[confIdx]));
        await wait(() => dlgSeq > s1, 5000);
        console.log('after confirm:', JSON.stringify(lastDialog));
      }
    }
    let travelMsg = null;
    const t0b = Date.now();
    while (Date.now() - t0b < 25000) {
      travelMsg = [...trail].reverse().find((x) => x.type === 'travel') ?? null;
      if (travelMsg || c.mapId === target) break;
      await sleep(400);
    }
    const pickMs = Date.now() - tPick;
    console.log(`transport: travel=${travelMsg ? JSON.stringify(travelMsg.data) : 'none'} mapId=${c.mapId} pickMs=${pickMs}`);
    if (travelMsg && c.mapId !== target) {
      try { await c.rejoinRoom(travelMsg.data); console.log('rejoined. mapId =', c.mapId); } catch (e) { console.log('rejoin fail:', String((e && e.message) || e)); }
    }
    await sleep(1500);
    try {
      const cl = await c.listCharacters();
      const list = Array.isArray(cl) ? cl : (cl?.characters ?? []);
      const me = list.find((x) => String(x.characterId) === String(rs.characterId));
      console.log('REST mapName =', me?.mapName, '| online =', me?.online);
    } catch {}
    result.ok = c.mapId === target;
    if (!result.ok) result.reason = 'transport did not land on target';
    result.pickMs = pickMs;
    fs.writeFileSync(`out/warp-hunt-${id}-${Date.now()}.json`, JSON.stringify({ id, target, trail }, null, 1));
    return result;
  } catch (e) {
    result.reason = 'exception: ' + String((e && e.message) || e).slice(0, 160);
    return result;
  } finally {
    try { await c.leaveGraceful(300); } catch {}
    c.close();
    await jpost(`/api/bots/${id}/restart`);
    console.log(`bot ${id} restart requested`);
  }
}

let attemptNo = 0;
while (attemptNo < maxAttempts) {
  const cand = await findCandidate();
  if (!cand) {
    console.log(`no capital candidate yet (attempt ${attemptNo + 1}/${maxAttempts}) — waiting 12s...`);
    await sleep(12000);
    attemptNo++;
    continue;
  }
  attemptNo++;
  const r = await attempt(cand);
  console.log('RESULT:', JSON.stringify(r));
  if (r.ok) { console.log('WARP PROVEN ✅ — trail saved.'); process.exit(0); }
  if (r.dialog2) { console.log('(!) Destination dialog captured even though target missing — check DIALOG 2 above.'); process.exit(2); }
  await sleep(3000);
}
console.log('no luck within attempts budget — candidates were: ' + [...tried].join(','));
process.exit(1);
