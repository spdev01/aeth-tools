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
      return json(res, 200, { ok: true, added: importAccounts(b.lines || '', { label: b.label || 'imported' }) });
    }
    if (p === '/api/accounts/register' && req.method === 'POST') {
      const b = await readBody(req);
      const r = await registerAccounts(b.count || 1);
      return json(res, 200, r);
    }
    if (p === '/api/accounts/placeholder' && req.method === 'POST') {
      const b = await readBody(req);
      const added = createPlaceholderAccounts(Math.max(1, Math.min(50, parseInt(b.count, 10) || 1)));
      return json(res, 200, { ok: true, added });
    }
    if (p === '/api/accounts/delete' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, 200, removeAccount(parseInt(b.id, 10)));
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
