// index.js — ROVA Command Center: local HTTP server (127.0.0.1:4320) + REST API + live WebSocket feed.
// Standalone by design (own port, own data dir, own Tor daemons). Aetheria CC lives separately on 4310.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { store } from './store.js';
import { BotManager } from './bots.js';
import { info as torInfo, ensureTorrc, startAllDaemons, daemonStatus, listPorts } from './tor.js';
import { portFor } from './tor-const.mjs';
import { importAccounts, removeAccount, registerAccounts, createPlaceholderAccounts } from './accounts.js';
import { collectQueue, collectorsView, setCollectorCaps, shopQueue, fleetView, plans } from './queues.js';
import { previewNames, characterName } from './namegen.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, '..', 'public');
const PORT = Number(process.env.ROVA_CC_PORT || 4320);
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version; } catch { return '0.0.0'; } })();

ensureTorrc(); // config skeleton exists before anything else

// live daemon-status snapshot for the state view (refreshed every 10s + on demand)
let daemonSnap = { 1: { port: 21000, control: 9061, listening: null }, 2: { port: 22000, control: 9062, listening: null } };
async function refreshDaemons() {
  try { daemonSnap = await daemonStatus(); } catch { /* keep last snapshot */ }
}
refreshDaemons();
setInterval(refreshDaemons, 10000).unref?.();

function stateView() {
  return {
    meta: { name: 'rova-command-center', version: VERSION, at: Date.now() },
    accounts: store.data.accounts.map((a) => ({ ...a, password: undefined, hasPassword: !!a.password })),
    characters: store.data.characters.map((c) => ({ ...c })),
    bots: store.data.bots.map((b) => ({ ...b, runtime: manager.runtimeView(b.id) })),
    tor: { health: manager.torHealth, daemons: daemonSnap, info: { ...torInfo(), ports: listPorts().length } },
    collect: collectQueue.view(),
    collectors: collectorsView(),
    shop: shopQueue.view(),
    fleet: fleetView(),
    plans: plans.list(),
    settings: store.getSettings(),
    jobs: { active: null, history: [] },
  };
}

const clients = new Set();
let broadcastAt = 0;
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const c of clients) { try { c.send(msg); } catch {} }
}
function broadcastStateDebounced() {
  if (Date.now() - broadcastAt < 300) return;
  broadcastAt = Date.now();
  broadcast({ type: 'state', state: stateView() });
}

const manager = new BotManager({
  onUpdate: () => broadcastStateDebounced(),
  onEvent: (e) => broadcast({ type: 'event', botId: e.botId, evt: e.evt }),
});

const readBody = (req) => new Promise((resolve) => {
  let chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); } });
});
const json = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(b) }); res.end(b); };
// json + immediate state broadcast — queue/plan/account mutations must show up in the UI at once
const jb = (res, code, obj) => { broadcastStateDebounced(); return json(res, code, obj); };

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = u.pathname;
  try {
    // ---------------- API ----------------
    if (p === '/api/state') return json(res, 200, stateView());
    if (p === '/api/meta') return json(res, 200, { name: 'rova-command-center', version: VERSION, tor: torInfo() });
    if (p === '/api/namegen/preview') return json(res, 200, { names: previewNames(6) });

    if (p === '/api/accounts/import' && req.method === 'POST') {
      const b = await readBody(req);
      return jb(res, 200, { ok: true, added: importAccounts(b.lines || '', { label: b.label || 'imported' }) });
    }
    if (p === '/api/accounts/register' && req.method === 'POST') {
      const b = await readBody(req);
      const r = await registerAccounts(b.count || 1);
      return jb(res, 200, r);
    }
    if (p === '/api/accounts/placeholder' && req.method === 'POST') {
      const b = await readBody(req);
      const added = createPlaceholderAccounts(Math.max(1, Math.min(50, parseInt(b.count, 10) || 1)));
      return jb(res, 200, { ok: true, added });
    }
    if (p === '/api/accounts/delete' && req.method === 'POST') {
      const b = await readBody(req);
      return jb(res, 200, removeAccount(parseInt(b.id, 10)));
    }
    let m = p.match(/^\/api\/accounts\/(\d+)\/password$/);
    if (m && req.method === 'GET') {
      const acc = store.findAccount(+m[1]);
      if (!acc) return json(res, 404, { ok: false, error: 'not found' });
      return json(res, 200, { ok: true, userId: acc.userId, password: acc.password });
    }

    if (p === '/api/bots/create' && req.method === 'POST') {
      const b = await readBody(req);
      const made = manager.create({ count: Math.max(1, Math.min(50, parseInt(b.count, 10) || 1)), mode: b.mode || 'smoke', names: b.names || null });
      return json(res, 200, { ok: true, bots: made });
    }
    if (p === '/api/bots/start-all' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, 200, await manager.startAll({ rampMs: parseInt(b.rampMs, 10) || 3000 }));
    }
    if (p === '/api/bots/stop-all' && req.method === 'POST') return json(res, 200, await manager.stopAll());

    m = p.match(/^\/api\/bots\/(\d+)\/(start|pause|resume|stop|delete)$/);
    if (m && req.method === 'POST') {
      const id = +m[1]; const op = m[2];
      let out;
      if (op === 'start') out = await manager.start(id);
      else if (op === 'pause') out = manager.pause(id);
      else if (op === 'resume') out = await manager.resume(id);
      else if (op === 'stop') out = manager.stop(id);
      else if (op === 'delete') out = manager.remove(id);
      return json(res, 200, out);
    }
    m = p.match(/^\/api\/bots\/(\d+)\/events$/);
    if (m && req.method === 'GET') {
      const limit = parseInt(u.searchParams.get('limit') || '200', 10);
      return json(res, 200, { ok: true, events: manager.recentEvents(+m[1], limit) });
    }

    if (p === '/api/tor/start' && req.method === 'POST') {
      const r = await startAllDaemons();
      await refreshDaemons();
      broadcastStateDebounced();
      return json(res, 200, r);
    }
    if (p === '/api/tor/status') {
      await refreshDaemons();
      return json(res, 200, { health: manager.torHealth, daemons: daemonSnap, info: torInfo() });
    }

    // ---- selection / group / bulk controls (dashboard action bar) ----
    if (p === '/api/bots/config-many' && req.method === 'POST') {
      const b = await readBody(req);
      const ids = b.all ? store.data.bots.map((x) => x.id) : (Array.isArray(b.ids) ? b.ids.map(Number) : []);
      let applied = 0;
      for (const id of ids) { if (manager.applyConfig(id, b.cfg ?? {}).ok) applied++; }
      return json(res, 200, { ok: true, applied });
    }
    if (p === '/api/bots/group' && req.method === 'POST') {
      const b = await readBody(req);
      const ids = Array.isArray(b.ids) ? b.ids.map(Number) : [];
      const group = b.group == null || String(b.group).trim() === '' ? null : String(b.group).trim().slice(0, 40);
      let updated = 0;
      for (const id of ids) { const bot = store.findBot(id); if (!bot) continue; bot.group = group; bot.updatedAt = Date.now(); updated++; }
      store.save();
      broadcastStateDebounced();
      return json(res, 200, { ok: true, updated, group });
    }
    if (p === '/api/bots/start-many' && req.method === 'POST') {
      const b = await readBody(req);
      const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Number.isFinite) : [];
      const rampMs = Math.max(0, Math.min(60000, parseInt(b.rampMs, 10) || 2000));
      const results = [];
      for (let i = 0; i < ids.length; i++) { const r = await manager.start(ids[i]); results.push({ id: ids[i], ...r }); if (i < ids.length - 1) await new Promise((rr) => setTimeout(rr, rampMs)); }
      return json(res, 200, { ok: true, results });
    }
    if (p === '/api/bots/stop-many' && req.method === 'POST') {
      const b = await readBody(req);
      const ids = Array.isArray(b.ids) ? b.ids.map(Number) : [];
      for (const id of ids) manager.stop(id);
      return json(res, 200, { ok: true, stopped: ids.length });
    }
    if (p === '/api/bots/disconnect-all' && req.method === 'POST') return json(res, 200, await manager.disconnectAll());
    m = p.match(/^\/api\/bots\/(\d+)\/disconnect$/);
    if (m && req.method === 'POST') return json(res, 200, manager.disconnect(+m[1]));

    // ---- collect queue ----
    if (p === '/api/collect/queue-all' && req.method === 'POST') { const b = await readBody(req); return jb(res, 200, collectQueue.queueAll(Array.isArray(b.ids) ? b.ids.map(Number) : [])); }
    if (p === '/api/collect/dequeue' && req.method === 'POST') { const b = await readBody(req); return jb(res, 200, collectQueue.dequeue(Array.isArray(b.ids) ? b.ids.map(Number) : [])); }
    if (p === '/api/collect/clear-waiting' && req.method === 'POST') return jb(res, 200, collectQueue.clearWaiting());
    if (p === '/api/collect/release' && req.method === 'POST') { const b = await readBody(req); return jb(res, 200, collectQueue.release(Array.isArray(b.ids) ? b.ids.map(Number) : null)); }
    if (p === '/api/collect/hold' && req.method === 'POST') { const b = await readBody(req); return jb(res, 200, collectQueue.hold(Array.isArray(b.ids) ? b.ids.map(Number) : [], b.on !== false)); }
    if (p === '/api/collect/grant' && req.method === 'POST') return jb(res, 200, collectQueue.grantNext());
    if (p === '/api/collect/settings' && req.method === 'POST') { const b = await readBody(req); return jb(res, 200, collectQueue.setAuto(b)); }

    // ---- collector pool ----
    if (p === '/api/collectors/ensure' && req.method === 'POST') {
      const made = manager.create({ count: 1, mode: 'collector' });
      return jb(res, 200, { ok: true, bot: made[0] });
    }
    if (p === '/api/settings/collectors' && req.method === 'POST') { const b = await readBody(req); return jb(res, 200, setCollectorCaps(parseInt(b.botId, 10), b)); }

    // ---- shopping (gear-up) queue ----
    if (p === '/api/shop/queue' && req.method === 'POST') { const b = await readBody(req); return jb(res, 200, shopQueue.queue(Array.isArray(b.ids) ? b.ids.map(Number) : [], b.note || '')); }
    if (p === '/api/shop/dequeue' && req.method === 'POST') { const b = await readBody(req); return jb(res, 200, shopQueue.dequeue(Array.isArray(b.ids) ? b.ids.map(Number) : [])); }
    if (p === '/api/shop/clear' && req.method === 'POST') return jb(res, 200, shopQueue.clear());

    // ---- plans ----
    if (p === '/api/plans' && req.method === 'GET') return json(res, 200, { plans: plans.list() });
    if (p === '/api/plans/save' && req.method === 'POST') { const b = await readBody(req); return jb(res, 200, plans.save(b.name, b.cfg ?? {})); }
    if (p === '/api/plans/apply' && req.method === 'POST') {
      const b = await readBody(req);
      const ids = b.all ? store.data.bots.map((x) => x.id) : (Array.isArray(b.ids) ? b.ids.map(Number) : []);
      return jb(res, 200, plans.apply(b.name, ids));
    }
    if (p === '/api/plans/delete' && req.method === 'POST') { const b = await readBody(req); return jb(res, 200, plans.remove(b.name)); }

    if (p === '/api/fleet' && req.method === 'GET') return json(res, 200, fleetView());

    // ---------------- static ----------------
    let file = p === '/' ? '/index.html' : p;
    const full = path.join(PUBLIC_DIR, path.normalize(file).replace(/^([/\\])+/, ''));
    if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(full).pipe(res);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
  } catch (e) {
    json(res, 500, { ok: false, error: String(e?.message || e) });
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
  try { ws.send(JSON.stringify({ type: 'state', state: stateView() })); } catch {}
  // backfill recent activity so the log pane isn't empty on a fresh page load
  try {
    for (const bot of store.data.bots.slice(0, 20)) {
      for (const evt of manager.recentEvents(bot.id, 8)) {
        try { ws.send(JSON.stringify({ type: 'event', botId: bot.id, evt })); } catch {}
      }
    }
  } catch {}
});
setInterval(() => broadcast({ type: 'state', state: stateView() }), 3000).unref?.();

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`[rova-cc] ROVA Command Center v${VERSION} — http://127.0.0.1:${PORT}`);
  console.log(`[rova-cc] data: ${store.dir}`);
  console.log(`[rova-cc] tor bin: ${torInfo().bin}`);
  const d = await daemonStatus();
  console.log(`[rova-cc] tor daemons: d1(21000+id,ctl 9061) ${d[1].listening ? 'listening' : 'DOWN'} · d2(22000+id,ctl 9062) ${d[2].listening ? 'listening' : 'DOWN'}`);
  console.log(`[rova-cc] bots: ${store.data.bots.length} · tor bot ports configured: ${listPorts().length}`);
  console.log('[rova-cc] Tor rule: no bot starts without its daemon up; workers prove their circuit (exit IP + IsTor) before anything else.');
});
