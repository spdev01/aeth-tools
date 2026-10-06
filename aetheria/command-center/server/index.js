// Command Center server: REST API + WS live hub + static dashboard.
//   node server/index.js          (PORT env to change, default 4310)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { store } from './store.js';
import { BotManager } from './bots.js';
import * as accounts from './accounts.js';
import { previewNames } from './namegen.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');
const PORT = parseInt(process.env.PORT || '4310', 10);
let VERSION = '0.0.0';
try { VERSION = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version || VERSION; } catch { /* ignore */ }

// ---------- live hub ----------
const wss = new WebSocketServer({ noServer: true });
import { initWiki, wikiSlices } from './wiki.js';
initWiki().catch(() => {});
const clients = new Set();
const broadcast = (msg) => { const s = JSON.stringify(msg); for (const ws of clients) { try { if (ws.readyState === 1) ws.send(s); } catch {} } };

const eventsRing = []; // recent events across all bots (for late subscribers / log panes)
const manager = new BotManager({
  onUpdate: () => broadcast({ type: 'bots', bots: manager.view(), jobs: jobsView() }),
  onEvent: (botId, e) => {
    const item = { botId, ...e };
    eventsRing.push(item);
    if (eventsRing.length > 3000) eventsRing.shift();
    // notable-only live push for non-focused panes; full stream available via /api/bots/:id/events
    broadcast({ type: 'log', botId, e: item });
  },
});

const jobsView = () => ({
  active: accounts.jobs.active ? { id: accounts.jobs.active.id, kind: accounts.jobs.active.kind, total: accounts.jobs.active.total, done: accounts.jobs.active.done, failed: accounts.jobs.active.failed, status: accounts.jobs.active.status, log: accounts.jobs.active.log.slice(-6) } : null,
  history: accounts.jobs.history.slice(0, 5).map((j) => ({ id: j.id, kind: j.kind, total: j.total, done: j.done, failed: j.failed, status: j.status, error: j.error })),
});
const jobTick = setInterval(() => broadcast({ type: 'jobs', jobs: jobsView() }), 1000);

// ---------- helpers ----------
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); });

const stateView = () => ({
  accounts: store.data.accounts.map((a) => ({ ...a, password: undefined, chars: store.charsOfAccount(a.id).map((c) => ({ id: c.id, characterId: c.characterId, name: c.name, classId: c.classId, baseLevel: c.baseLevel, jobLevel: c.jobLevel, mapName: c.mapName, included: c.included })) })),
  characters: store.data.characters.map((c) => ({ ...c })),
  bots: manager.view(),
  settings: store.getSettings(),
  collect: manager.collectView(),
  fleet: manager.fleetView(),
  jobs: jobsView(),
});

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/api/state') return json(res, 200, stateView());
    if (p === '/api/meta') return json(res, 200, { name: 'aetheria-command-center', version: VERSION });
    if (p === '/api/namegen/preview') return json(res, 200, { names: previewNames(6) });

    if (p === '/api/accounts/register' && req.method === 'POST') {
      const body = await readBody(req);
      const job = accounts.startRegisterJob({ count: Math.max(1, Math.min(50, body.count | 0)), createChars: body.createChars !== false, autoInclude: body.autoInclude !== false });
      return json(res, 200, { jobId: job.id });
    }
    if (p === '/api/accounts/import' && req.method === 'POST') {
      const body = await readBody(req);
      const r = accounts.importAccounts({ lines: body.lines, autoInclude: body.autoInclude !== false });
      return json(res, 200, { imported: r.imported, results: r.results.filter((x) => !x.ok), jobId: r.job?.id });
    }
    if (/^\/api\/accounts\/\d+\/characters$/.test(p) && req.method === 'POST') {
      const id = parseInt(p.split('/')[3], 10);
      const account = store.findAccount(id);
      if (!account) return json(res, 404, { error: 'account not found' });
      const { name } = await accounts.createCharacterFor(account);
      const c = accounts.addCharacter(account, { name, included: !!account.includeDefault });
      broadcast({ type: 'state_dirty' });
      return json(res, 200, c);
    }
    if (/^\/api\/accounts\/\d+\/password$/.test(p) && req.method === 'GET') {
      // localhost-only convenience: reveal a stored account password on explicit request
      const id = parseInt(p.split('/')[3], 10);
      const account = store.findAccount(id);
      if (!account) return json(res, 404, { error: 'account not found' });
      return json(res, 200, { id: account.id, userId: account.userId, password: account.password ?? null });
    }
    if (p === '/api/wiki') return json(res, 200, wikiSlices());
    if (p === '/api/kills' && req.method === 'GET') return json(res, 200, manager.killView());
    if (p === '/api/kills/clear' && req.method === 'POST') return json(res, 200, manager.clearKills());
    if (/^\/api\/bots\/\d+\/config$/.test(p) && req.method === 'POST') {
      const id = parseInt(p.split('/')[3], 10);
      const bot = store.findBot(id);
      if (!bot) return json(res, 404, { error: 'bot not found' });
      const body = await readBody(req);
      const cfg = {};
      for (const k of ['auto', 'weave', 'autoChannel', 'collect', 'errand', 'farm', 'cleanup', 'cards']) if (body[k] !== undefined) cfg[k] = body[k];
      // per-bot whitelist (array of item ids); bots that never had one default to the global list
      if (Array.isArray(body.keep)) cfg.keep = body.keep.map((x) => parseInt(x, 10)).filter(Number.isFinite).slice(0, 200);
      else if (!(bot.cfg?.keep ?? []).length) cfg.keep = store.getSettings().tracked ?? [];
      if (cfg.cards) await initWiki().catch(() => {}); // card ids must be loaded before the whitelist expansion
      return json(res, 200, manager.applySettings(id, cfg));
    }
    if (p === '/api/bots/config-all' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = {};
      for (const k of ['auto', 'weave', 'autoChannel', 'collect', 'errand', 'farm', 'cards']) if (body[k] !== undefined) cfg[k] = body[k];
      if (Array.isArray(body.keep)) cfg.keep = body.keep.map((x) => parseInt(x, 10)).filter(Number.isFinite).slice(0, 200);
      const mode = ['leveling', 'farming'].includes(body.mode) ? body.mode : null;
      if (cfg.cards) await initWiki().catch(() => {});
      let n = 0;
      for (const bot of store.data.bots) {
        if (bot.mode === 'collector') continue;
        if (mode) bot.mode = mode;
        const bc = { ...cfg };
        // farming errands sell everything not in farm.keep — default it to the bot's own whitelist when absent
        if (bc.farm) { bc.farm = { ...bc.farm }; if (!bc.farm.keep) bc.farm.keep = bot.cfg?.keep ?? store.getSettings().tracked ?? []; }
        manager.applySettings(bot.id, bc);
        n++;
      }
      if (mode) store.save();
      return json(res, 200, { ok: true, applied: n, mode: mode ?? undefined });
    }
    if (/^\/api\/bots\/\d+\/collect$/.test(p) && req.method === 'POST') {
      const id = parseInt(p.split('/')[3], 10);
      return json(res, 200, manager.enqueueCollect(id));
    }
    if (/^\/api\/bots\/\d+\/refresh-storage$/.test(p) && req.method === 'POST') {
      const id = parseInt(p.split('/')[3], 10);
      const bot = store.findBot(id);
      if (!bot) return json(res, 404, { error: 'bot not found' });
      return json(res, 200, manager.requestStorageRefresh(id));
    }
    if (p === '/api/collect/dequeue' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, manager.dequeueCollect(parseInt(body.id, 10), { hold: body.hold !== false }));
    }
    if (p === '/api/collect/clear-waiting' && req.method === 'POST') {
      return json(res, 200, manager.clearWaiting());
    }
    if (p === '/api/collect/release' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, manager.releaseCollect(body.id != null ? parseInt(body.id, 10) : null));
    }
    if (/^\/api\/bots\/\d+\/mode$/.test(p) && req.method === 'POST') {
      const id = parseInt(p.split('/')[3], 10);
      const bot = store.findBot(id);
      if (!bot) return json(res, 404, { error: 'bot not found' });
      const body = await readBody(req);
      if (['leveling', 'farming', 'collector'].includes(body.mode)) { bot.mode = body.mode; store.save(); broadcast({ type: 'state_dirty' }); }
      return json(res, 200, { ok: true, mode: bot.mode, hint: 'restart the bot to apply the new mode' });
    }
    if (/^\/api\/bots\/\d+\/restart$/.test(p) && req.method === 'POST') {
      const id = parseInt(p.split('/')[3], 10);
      return json(res, 200, await manager.restartBot(id));
    }
    if (p === '/api/bots/restart-all' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, await manager.restartAll({ rampMs: Math.max(1000, parseInt(body.rampMs, 10) || 3000) }));
    }
    if (p === '/api/settings/collector' && req.method === 'POST') {
      const body = await readBody(req);
      const s = store.getSettings();
      if (body.charName !== undefined || body.channel !== undefined || body.spotX !== undefined || body.spotY !== undefined) {
        s.collector = {
          charName: String(body.charName ?? s.collector?.charName ?? '').trim(),
          channel: Math.max(1, parseInt(body.channel, 10) || s.collector?.channel || 1),
          spot: { x: parseInt(body.spotX, 10) || s.collector?.spot?.x || 880, y: parseInt(body.spotY, 10) || s.collector?.spot?.y || 1520 },
        };
      }
      if (body.autoCollect) {
        const ac = s.autoCollect ?? { enabled: false, everyMin: 360, minZeny: 15000, minStacks: 1, lastAt: 0 };
        if (body.autoCollect.enabled !== undefined) ac.enabled = !!body.autoCollect.enabled;
        if (body.autoCollect.everyMin !== undefined) ac.everyMin = Math.max(15, parseInt(body.autoCollect.everyMin, 10) || 360);
        if (ac.enabled && !ac.lastAt) ac.lastAt = Date.now();
        s.autoCollect = ac;
      }
      store.save();
      // push live directives to the collector bot if it exists
      const cb = store.data.bots.find((b) => store.findCharacter(b.characterId)?.name === s.collector?.charName);
      if (cb && s.collector) manager.applySettings(cb.id, { collect: { enabled: true, channel: s.collector.channel, spot: s.collector.spot } });
      return json(res, 200, { ok: true, collector: s.collector, autoCollect: s.autoCollect });
    }
    if (p === '/api/settings/tracked' && req.method === 'POST') {
      const body = await readBody(req);
      const s = store.getSettings();
      s.tracked = (Array.isArray(body.ids) ? body.ids : []).map((x) => parseInt(x, 10)).filter(Number.isFinite).slice(0, 200);
      store.save();
      // propagate the whitelist to every bot (errand deposit + collect transfers read it)
      for (const bot of store.data.bots) { if (bot.mode === 'collector') continue; manager.applySettings(bot.id, { keep: s.tracked }); }
      broadcast({ type: 'state_dirty' });
      return json(res, 200, { ok: true, tracked: s.tracked });
    }
    if (/^\/api\/characters\/\d+$/.test(p) && req.method === 'PATCH') {
      const id = parseInt(p.split('/')[3], 10);
      const c = store.findCharacter(id);
      if (!c) return json(res, 404, { error: 'character not found' });
      const body = await readBody(req);
      if (body.included != null) c.included = body.included ? 1 : 0;
      store.save();
      return json(res, 200, c);
    }
    if (/^\/api\/characters\/\d+\/refresh$/.test(p) && req.method === 'POST') {
      const id = parseInt(p.split('/')[3], 10);
      const c = store.findCharacter(id);
      if (!c) return json(res, 404, { error: 'character not found' });
      await accounts.refreshCharacter(c);
      return json(res, 200, c);
    }

    if (p === '/api/bots/start' && req.method === 'POST') {
      const body = await readBody(req);
      const ids = Array.isArray(body.characterIds) ? body.characterIds.map((x) => parseInt(x, 10)) : [];
      const charset = ids.length ? ids : store.data.characters.filter((c) => c.included).map((c) => c.id);
      const started = await manager.startMany(charset, { rampMs: Math.max(0, Math.min(60000, body.rampMs ?? 5000)) });
      return json(res, 200, { started });
    }
    if (p === '/api/bots/stop-all' && req.method === 'POST') { await manager.stopAll(); return json(res, 200, { ok: true }); }
    if (p === '/api/jobs/create-characters' && req.method === 'POST') {
      const j = accounts.startCharJob({});
      return json(res, 200, { jobId: j.id, total: j.total });
    }
    if (/^\/api\/bots\/\d+\/(play|pause|stop|resume)$/.test(p) && req.method === 'POST') {
      const [, , , idStr, action] = p.split('/');
      const botId = parseInt(idStr, 10);
      const bot = store.findBot(botId);
      if (!bot) return json(res, 404, { error: 'bot not found' });
      if (action === 'pause') manager.pause(botId);
      else if (action === 'stop') manager.stop(botId);
      else manager.resume(botId);
      return json(res, 200, { ok: true, state: manager.stateOf(botId) });
    }
    if (/^\/api\/bots\/\d+\/events$/.test(p)) {
      const botId = parseInt(p.split('/')[3], 10);
      const limit = Math.min(2000, parseInt(url.searchParams.get('limit') || '300', 10));
      return json(res, 200, { events: eventsRing.filter((e) => e.botId === botId).slice(-limit) });
    }

    // ---- static ----
    let file = p === '/' ? '/index.html' : p;
    const full = path.join(PUBLIC, path.normalize(file).replace(/^([/\\])+/, ''));
    if (!full.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
    fs.readFile(full, (err, buf) => {
      if (err) return json(res, 404, { error: 'not found' });
      const mime = full.endsWith('.html') ? 'text/html' : full.endsWith('.js') ? 'text/javascript' : full.endsWith('.css') ? 'text/css' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8' });
      res.end(buf);
    });
  } catch (e) {
    json(res, 500, { error: String(e?.message || e) });
  }
});

// ---------- WS upgrade ----------
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/live') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    try {
      ws.send(JSON.stringify({ type: 'hello', bots: manager.view(), jobs: jobsView(), events: eventsRing.slice(-400) }));
    } catch {}
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Aetheria Command Center v${VERSION} → http://127.0.0.1:${PORT}`);
  console.log(`data dir: ${store.dir}`);
  console.log(`bots dir: ${path.join(store.dir, 'bots')}`);
});

process.on('uncaughtException', (e) => console.error('[uncaught]', e));
process.on('SIGINT', () => { clearInterval(jobTick); process.exit(0); });
