// M1 SPIKE — headless connect proof:
// login (guest) -> characters (list/create) -> world/enter -> join room -> dump messages
import WebSocket from 'ws';
globalThis.WebSocket = WebSocket;
import { Client } from 'colyseus.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://www.aetheria-online.in.th';
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logFile = path.join(outDir, `spike-${stamp}.jsonl`);
const log = (obj) => { const line = JSON.stringify(obj); fs.appendFileSync(logFile, line + '\n'); console.log(line.slice(0, 350)); };
console.log('log ->', logFile);

async function jfetch(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, json, text: json ? null : text.slice(0, 700) };
}

const main = async () => {
  const H = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

  // 0) reuse saved session if fresh (<11h), else guest login
  let token = null;
  let res;
  const sessFile = path.join(outDir, 'session.json');
  try {
    const s = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
    if (s.token && (Date.now() - new Date(s.createdAt).getTime()) < 11 * 3600 * 1000) { token = s.token; log({ step: 'auth.reuse', ok: true }); }
  } catch (e) {}
  if (!token) {
    res = await jfetch(`${BASE}/auth/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    log({ step: 'auth.guest', status: res.status, json: res.json, text: res.text });
    token = res.json && (res.json.token || res.json.jwt || res.json.accessToken || res.json.access_token);
    if (!token) { log({ step: 'auth.guest', error: 'no token field found', raw: res.json }); process.exit(1); }
    fs.writeFileSync(sessFile, JSON.stringify({ token, createdAt: new Date().toISOString() }));
  }

  // 2) list characters
  res = await jfetch(`${BASE}/characters`, { headers: H(token) });
  log({ step: 'characters.list', status: res.status, json: res.json });
  const list = res.json && (res.json.characters || res.json);
  let characterId = Array.isArray(list) && list[0] ? (list[0].id || list[0].characterId) : null;

  // 3) create if none (try common payload shapes)
  if (!characterId) {
    const charName = 'ScoutA' + String(Math.floor(Math.random() * 100000));
    const tries = [{ name: charName }, { name: charName, className: 'novice' }, { name: charName, class: 'novice' }, { name: charName, job: 'novice' }];
    for (const body of tries) {
      res = await jfetch(`${BASE}/characters`, { method: 'POST', headers: H(token), body: JSON.stringify(body) });
      log({ step: 'characters.create', body, status: res.status, json: res.json, text: res.text });
      if (res.status >= 200 && res.status < 300) {
        characterId = res.json && (res.json.id || res.json.characterId || (res.json.character && res.json.character.id));
        const c2 = res.json && (res.json.characters || []);
        if (!characterId && Array.isArray(c2) && c2[0]) characterId = c2[0].id || c2[0].characterId;
        if (characterId) break;
      }
    }
  }
  if (!characterId) { log({ step: 'characters.ready', error: 'could not obtain characterId' }); process.exit(1); }
  log({ step: 'characters.ready', characterId });

  // 4) world enter
  res = await jfetch(`${BASE}/world/enter`, { method: 'POST', headers: H(token), body: JSON.stringify({ characterId }) });
  const masked = res.json ? { ...res.json } : null;
  if (masked && masked.ticket) masked.ticket = '<ticket-' + String(masked.ticket).length + 'chars>';
  log({ step: 'world.enter', status: res.status, keys: res.json ? Object.keys(res.json) : null, json: masked, text: res.text });
  const enter = res.json || {};
  if (!enter.roomId) { log({ step: 'world.enter', error: 'no roomId', raw: masked }); process.exit(1); }

  // 5) join room — server returns FLAT reservation {name, sessionId, roomId, processId};
  // shim it into the nested shape colyseus 0.15.28 expects.
  const client = new Client(enter.endpoint || 'wss://g2.aetheria-online.in.th');
  const _csr = client.consumeSeatReservation.bind(client);
  client.consumeSeatReservation = (res, rootSchema) => _csr(
    res.room ? res : {
      room: { name: res.name, roomId: res.roomId, processId: res.processId, publicAddress: res.publicAddress },
      sessionId: res.sessionId,
      reconnectionToken: res.reconnectionToken,
    },
    rootSchema
  );
  const room = await client.joinById(enter.roomId, { ticket: enter.ticket, batch: true });
  log({ step: 'room.joined', sessionId: room.sessionId, name: room.name });

  const BIG = /^(skill_catalog|character|inventory|storage|shop|warp_menu|npc_dialog)$/;
  room.onMessage('*', (type, msg) => {
    let data = msg;
    let str;
    try { str = typeof msg === 'object' ? JSON.stringify(msg) : String(msg); } catch (e) { str = '<unserializable>'; }
    if (!BIG.test(type) && str.length > 900) str = str.slice(0, 900) + '...<trunc>';
    log({ step: 'recv', type, data: str });
  });
  room.onLeave((code) => log({ step: 'room.leave', code }));

  // move test: walk a little (tile 52,31 center) after a short warmup
  setTimeout(() => { try { room.send('move_to', { x: 52 * 32 + 16, y: 32 * 32 + 16 }); log({ step: 'sent', type: 'move_to' }); } catch (e) {} }, 4000);
  // inventory probe: force list
  setTimeout(() => { try { room.send('inv_sort', {}); log({ step: 'sent', type: 'inv_sort' }); } catch (e) {} }, 6000);

  setTimeout(async () => {
    log({ step: 'done', logFile });
    try { await room.leave(); } catch (e) {}
    process.exit(0);
  }, 25000);
};
main().catch((e) => { log({ step: 'fatal', error: String((e && e.stack) || e) }); process.exit(1); });
