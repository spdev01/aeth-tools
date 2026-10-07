// Bot manager: spawns/kills one runner process per bot, drives play/pause/stop via control files,
// polls per-bot status.json for the UI, and tails per-bot JSONL logs into the live event stream.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { store } from './store.js';
import { cardItemIds } from './wiki.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const STORESNAP_FILE = path.join(here, '..', 'data', 'collector-storage.json');
const KILLLOG_FILE = path.join(here, '..', 'data', 'kill-log.json');
const TESTBOT = path.resolve(here, '..', '..', 'testbot');
const RUNNER = path.join(TESTBOT, 'src', 'runner.js');
const BOTS_DIR = path.join(store.dir, 'bots');
const UPTO = process.env.CC_UPTO || '34';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readControl = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'control.json'), 'utf8')); } catch { return null; } };

// tiny digest of the last meaningful log event — powers the per-bot activity badge in the UI
const EVT_BRIEF = (evt, d) => {
  try {
    switch (evt) {
      case 'route': return { to: d.to };
      case 'travel_msg': return { to: d.mapId };
      case 'traveled': return { to: d.now };
      case 'shop': return { name: d.name };
      case 'buy_potions': return { have: d.have };
      case 'auto_sold': return { n: d.count };
      case 'npc_dialog': return { name: d.name };
      case 'reconnect_attempt_fail': return { attempt: d.attempt };
      case 'reconnect_done': case 'death_recovered': return { map: d.map };
      case 'kill': return { mob: d.m };
      case 'farm_status': return { base: d.baseLevel, dead: !!d.dead, auto: d.autoEnabled };
      case 'STEP_START': case 'STEP_DONE': return { step: d.step };
      case 'levelup': return { level: d.level };
      default: return {};
    }
  } catch { return {}; }
};

// local-day key for the kill log (the dashboard machine is the fleet's own clock)
const dayKey = (iso) => { const d = new Date(iso); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

export class BotManager {
  constructor({ onUpdate = () => {}, onEvent = () => {} } = {}) {
    this.onUpdate = onUpdate;
    this.onEvent = onEvent;
    this.runtime = new Map(); // botId -> { proc, dir, state, status, tail* , pendingStart }
    this.tradeQueue = []; // botIds waiting for a collector trade slot
    this.activeTrade = null; // botId currently trading
    // restore persisted queue state — a server restart must not lose waiting turns or double-grant the active bot
    try {
      const qs = store.getSettings?.()?.collectQueue;
      if (qs && typeof qs === 'object') {
        this.tradeQueue = (qs.queue ?? []).map((x) => parseInt(x, 10)).filter((id) => { const b = store.findBot(id); return !!b && b.mode !== 'collector'; });
        for (const h of (qs.holds ?? [])) { const b = store.findBot(parseInt(h, 10)); if (b && b.mode !== 'collector') this.rt(b.id).collectHold = true; }
        const act = parseInt(qs.active, 10);
        if (Number.isFinite(act)) {
          const b = store.findBot(act);
          if (b && b.mode !== 'collector') {
            this.activeTrade = act;
            const rt = this.rt(act);
            rt.grantAt = qs.grantAt ?? Date.now();
            rt.grantPending = true; // the runner still holds its control.json grant — don't grant anyone else
          }
        }
      }
    } catch {}
    // collector's last-seen storage snapshot — persisted so the dashboard can show where items sit even
    // after the collector restarts (donors never open storage; the collector is the only storer)
    this.storeSnap = null; // { at, zeny, slots, items: { itemId: qty } }
    try { const raw = JSON.parse(fs.readFileSync(STORESNAP_FILE, 'utf8')); if (raw && typeof raw === 'object' && raw.items) this.storeSnap = raw; } catch {}
    this.fleet = { regular: new Map(), collectorBag: new Map() };
    // persistent kill log — rows: "<day>|<botId>|<monster>" -> count; tails: per-bot "how far its newest
    // JSONL was processed" { file, off, lastTs } so a server restart resumes without re-counting (ts-dedup
    // is the second guard). Cleared only via the dashboard's 🗑 button.
    this.killLog = { v: 1, rows: {}, tails: {} };
    try { const raw = JSON.parse(fs.readFileSync(KILLLOG_FILE, 'utf8')); if (raw && typeof raw === 'object' && raw.rows) this.killLog = raw; } catch {}
    this._killDirty = false;
    this._poller = setInterval(() => this.poll(), 2000);
  }

  // persist the trade queue so restarts are seamless (runners keep their control.json grants either way)
  _saveQueue() {
    try {
      const s = store.getSettings?.();
      if (!s) return;
      s.collectQueue = { queue: [...this.tradeQueue], active: this.activeTrade, holds: this.heldList(), grantAt: this.activeTrade != null ? (this.runtime.get(this.activeTrade)?.grantAt ?? Date.now()) : null, at: Date.now() };
      store.save?.();
    } catch {}
  }

  // near-real-time fleet item totals: farming bots contribute their BAGS only (they never touch storage by
  // policy); the collector contributes bag + its last-seen storage snapshot (persisted, with its timestamp).
  _ledgerTick() {
    const regular = new Map();
    const collectorBag = new Map();
    let snapSrc = null, snapAt = 0;
    for (const [botId, rt] of this.runtime) {
      const s = rt.status; if (!s) continue;
      const isCol = store.findBot(botId)?.mode === 'collector';
      const tgt = isCol ? collectorBag : regular;
      for (const it of (s.inventory ?? [])) if (it.itemId != null) tgt.set(it.itemId, (tgt.get(it.itemId) ?? 0) + (it.qty ?? 1));
      // a collector storage snapshot only counts when it carries a read-timestamp (fresh window read)
      if (isCol && Array.isArray(s.storage?.items) && (s.storageAt ?? 0) > snapAt) { snapSrc = s.storage; snapAt = s.storageAt; }
    }
    this.fleet = { regular, collectorBag };
    if (snapSrc && snapAt > (this.storeSnap?.at ?? 0)) {
      const items = {};
      for (const it of snapSrc.items) if (it.itemId != null) items[it.itemId] = (items[it.itemId] ?? 0) + (it.qty ?? 1);
      this.storeSnap = { at: snapAt, zeny: snapSrc.zeny ?? null, slots: snapSrc.slots ?? null, items };
      try { fs.writeFileSync(STORESNAP_FILE, JSON.stringify(this.storeSnap)); } catch {}
    }
  }
  fleetView() {
    return {
      updatedAt: Date.now(),
      regular: Object.fromEntries(this.fleet?.regular ?? []),
      collectorBag: Object.fromEntries(this.fleet?.collectorBag ?? []),
      collectorStorage: this.storeSnap ?? null,
    };
  }
  // command-center ⟳ — ask the collector to re-open its storage and report a fresh snapshot
  requestStorageRefresh(botId) {
    const rt = this.rt(botId);
    let cur = {}; try { cur = JSON.parse(fs.readFileSync(path.join(rt.dir, 'control.json'), 'utf8')); } catch {}
    cur.refreshStorage = Date.now();
    fs.writeFileSync(path.join(rt.dir, 'control.json'), JSON.stringify(cur));
    this.onUpdate();
    return { ok: true, requestedAt: cur.refreshStorage };
  }

  // 🔓 force-online — kick the character's previous (stale) session server-side, exactly like the game's
  // character-select "kick" button (POST /characters/:id/kick). Use when a bot is stuck at
  // "already online"; the stale seat frees instantly and the next login/restart succeeds.
  async kickSession(botId) {
    const bot = store.findBot(botId);
    if (!bot) return { ok: false, error: 'bot not found' };
    const c = store.findCharacter(bot.characterId);
    const a = c ? store.findAccount(c.accountId) : null;
    if (!c || !a) return { ok: false, error: 'character/account missing' };
    const dir = this.dirOf(botId);
    // the CC store id is internal — the GAME-side character id lives on the store character record
    // (set for CC-created characters) or in the runner's run-state.json (imported accounts)
    let gameCharId = c.characterId ?? null;
    if (!gameCharId) {
      try { const rs = JSON.parse(fs.readFileSync(path.join(dir, 'run-state.json'), 'utf8')); if (rs?.characterId) gameCharId = rs.characterId; } catch {}
    }
    if (!gameCharId) return { ok: false, error: 'game characterId unknown — start the bot once so it can sync, then kick' };
    let token = null;
    try { token = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')).token; } catch {}
    const call = async (tok) => {
      const res = await fetch(`https://www.aetheria-online.in.th/characters/${gameCharId}/kick`, {
        method: 'POST', headers: { Authorization: `Bearer ${tok}` },
      });
      let j = null; try { j = await res.json(); } catch {}
      return { status: res.status, ok: res.ok, err: (j && (j.error ?? j.err)) || null };
    };
    try {
      let r = token ? await call(token) : { status: 401, ok: false, err: 'no session token' };
      if (r.status === 401 && a.userId && a.password) {
        // stale/absent token → fresh login with the stored account, persist it, retry once
        const lr = await fetch('https://www.aetheria-online.in.th/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: a.userId, password: a.password }),
        });
        const lj = await lr.json().catch(() => ({}));
        if (lr.ok && lj.token) {
          token = lj.token;
          try { fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ token, createdAt: new Date().toISOString() })); } catch {}
          r = await call(token);
        } else {
          return { ok: false, status: lr.status, error: (lj && (lj.error ?? lj.err)) || 'login failed' };
        }
      }
      return { ok: r.ok, status: r.status, error: r.err ?? undefined };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  // ---- kill log (persistent; wiped only via the dashboard) ----
  _saveKills() {
    try { fs.writeFileSync(KILLLOG_FILE, JSON.stringify(this.killLog)); this._killSavedAt = Date.now(); this._killDirty = false; } catch {}
  }
  killView() { return { rows: this.killLog.rows, at: this._killSavedAt ?? null }; }
  clearKills() {
    this.killLog.rows = {}; // tails stay — they are how we avoid re-counting already-processed files
    this._saveKills();
    return { ok: true, clearedAt: Date.now() };
  }

  // ---- store helpers ----
  ensureBot(characterId) {
    let bot = store.data.bots.find((b) => b.characterId === characterId);
    if (!bot) {
      bot = { id: store.nextId('bot'), characterId, mode: 'leveling', state: 'stopped', createdAt: Date.now(), updatedAt: Date.now() };
      store.data.bots.push(bot);
      store.save();
    }
    return bot;
  }

  dirOf(botId) { return path.join(BOTS_DIR, String(botId)); }

  rt(botId) {
    if (!this.runtime.has(botId)) {
      const dir = this.dirOf(botId);
      fs.mkdirSync(dir, { recursive: true });
      this.runtime.set(botId, { dir, state: 'stopped', status: null, tailFile: null, tailOffset: 0, tailCarry: '' });
    }
    return this.runtime.get(botId);
  }

  control(botId, cmd, extra = {}) {
    const rt = this.rt(botId);
    let cur = {}; try { cur = JSON.parse(fs.readFileSync(path.join(rt.dir, 'control.json'), 'utf8')); } catch {}
    fs.writeFileSync(path.join(rt.dir, 'control.json'), JSON.stringify({ ...cur, cmd, ...extra }));
  }

  // Push runtime config (auto-combat, weave, channel, collect, farm) to a bot via control.json.
  applySettings(botId, cfg) {
    const rt = this.rt(botId);
    let cur = {}; try { cur = JSON.parse(fs.readFileSync(path.join(rt.dir, 'control.json'), 'utf8')); } catch {}
    const rev = (cur.rev ?? 0) + 1;
    // "keep all cards" toggle: when on, every card item id rides with the whitelist into control.json — the
    // runner's keep machinery then protects/banks/trades cards exactly like whitelist items. keepRaw preserves
    // the user's explicit list so toggling off restores it (the expanded list must never leak back into raw).
    const cards = cfg.cards !== undefined ? !!cfg.cards : !!cur.cards;
    const rawKeep = cfg.keep !== undefined ? cfg.keep : (cur.keepRaw !== undefined ? cur.keepRaw : (cur.keep ?? []));
    const keep = cards ? [...new Set([...rawKeep, ...cardItemIds()])] : rawKeep;
    fs.writeFileSync(path.join(rt.dir, 'control.json'), JSON.stringify({ ...cur, ...cfg, cards, keep, keepRaw: rawKeep, cmd: cur.cmd === 'stop' ? 'run' : (cur.cmd ?? 'run'), rev }));
    const bot = store.findBot(botId);
    if (bot) { bot.cfg = { ...(bot.cfg ?? {}), ...cfg }; store.save(); }
    rt.cfg = { ...(rt.cfg ?? {}), ...cfg };
    this.onUpdate();
    return { ok: true, rev };
  }
  grantCollect(botId, grant) {
    const rt = this.rt(botId);
    let cur = {}; try { cur = JSON.parse(fs.readFileSync(path.join(rt.dir, 'control.json'), 'utf8')); } catch {}
    fs.writeFileSync(path.join(rt.dir, 'control.json'), JSON.stringify({ ...cur, grant, rev: (cur.rev ?? 0) + 1, cmd: cur.cmd === 'stop' ? 'run' : (cur.cmd ?? 'run') }));
    rt.grantAt = Date.now();
    this.onUpdate();
  }
  clearGrant(botId) {
    const rt = this.rt(botId);
    let cur = {}; try { cur = JSON.parse(fs.readFileSync(path.join(rt.dir, 'control.json'), 'utf8')); } catch {}
    if (!cur.grant) return;
    const { grant, ...rest } = cur;
    fs.writeFileSync(path.join(rt.dir, 'control.json'), JSON.stringify({ ...rest, rev: (cur.rev ?? 0) + 1 }));
    this.onUpdate();
  }
  enqueueCollect(botId) {
    const bot = store.findBot(botId);
    if (!bot || bot.mode === 'collector') return { ok: false, error: 'not a collectible bot' };
    const rt = this.rt(botId);
    rt.collectHold = false; // explicitly queuing releases a skip-hold
    if (!this.tradeQueue.includes(botId) && this.activeTrade !== botId) this.tradeQueue.push(botId);
    this._saveQueue();
    this.onUpdate();
    return { ok: true, queue: [...this.tradeQueue], active: this.activeTrade };
  }

  // ✕ — remove a waiting bot from this round; the hold keeps it out of auto-queueing until its want-cycle resets or it is queued again
  dequeueCollect(botId, { hold = true } = {}) {
    if (this.activeTrade === botId) return { ok: false, error: 'bot is trading right now — it finishes on its own (auto-skip after 10 min)' };
    const i = this.tradeQueue.indexOf(botId);
    if (i === -1) return { ok: false, error: 'not in the queue' };
    this.tradeQueue.splice(i, 1);
    if (hold) this.rt(botId).collectHold = true;
    this._saveQueue();
    this.onUpdate();
    return { ok: true, queue: [...this.tradeQueue], active: this.activeTrade, held: this.heldList() };
  }

  // ⏹ — empty the waiting queue (the active bot keeps trading); every removed bot is held out of auto-queueing
  clearWaiting() {
    const n = this.tradeQueue.length;
    for (const id of this.tradeQueue) this.rt(id).collectHold = true;
    this.tradeQueue = [];
    this._saveQueue();
    this.onUpdate();
    return { ok: true, removed: n, active: this.activeTrade, held: this.heldList() };
  }

  // ↺ — release held bots (one if id given): they auto-queue again if they still want to hand over
  releaseCollect(id = null) {
    const ids = id != null ? [parseInt(id, 10)] : [...this.runtime.keys()];
    const released = [];
    for (const bId of ids) {
      const rt = this.runtime.get(bId);
      if (!rt || !rt.collectHold) continue;
      rt.collectHold = false;
      released.push(bId);
      const st = rt.status;
      if (st?.wantCollect && this.activeTrade !== bId && !this.tradeQueue.includes(bId) && !rt.grantPending) this.tradeQueue.push(bId);
    }
    if (released.length) { this._saveQueue(); this.onUpdate(); }
    return { ok: true, released, queue: [...this.tradeQueue], active: this.activeTrade, held: this.heldList() };
  }

  heldList() { const out = []; for (const [bId, rt] of this.runtime) if (rt.collectHold) out.push(bId); return out; }

  // ---- lifecycle ----
  async start(botId, { delayMs = 0 } = {}) {
    const bot = store.findBot(botId);
    const rt = this.rt(botId);
    if (rt.proc && rt.proc.exitCode === null && rt.proc.signalCode === null) return; // already up (signal-killed procs keep exitCode null!)
    if (delayMs > 0) { rt.state = 'queued';
      this.control(botId, 'run'); // clear any stale 'stop' left over from a previous stop-all
      await sleep(delayMs);
      // abort only if we were stopped WHILE queued (fresh stop written during the wait)
      if (readControl(rt.dir)?.cmd === 'stop') { rt.state = 'stopped'; this.onUpdate(); return; }
    }
    if (rt.proc && rt.proc.exitCode === null && rt.proc.signalCode === null) return;
    const character = store.findCharacter(bot.characterId);
    const account = store.findAccount(character.accountId);
    this.control(botId, 'run');
    const logStream = fs.createWriteStream(path.join(rt.dir, 'worker.log'), { flags: 'a' });
    rt.state = 'starting';
    rt.lastEvt = null; // fresh spawn → don't show the previous session's activity badge
    rt.stopping = false;
    rt.startedAt = Date.now();
    rt.proc = spawn(process.execPath, [RUNNER, '--upto', UPTO, '--mode', bot.mode ?? 'leveling'], {
      cwd: TESTBOT,
      env: {
        ...process.env,
        AETHERIA_DATA: rt.dir,
        AETHERIA_USER: account.userId,
        AETHERIA_PASS: account.password,
        AETHERIA_QUIET: '1',
        AETHERIA_MODE: bot.mode ?? 'leveling',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    rt.proc.stdout.pipe(logStream);
    rt.proc.stderr.pipe(logStream);
    rt.proc.on('exit', (code) => {
      const uptime = Date.now() - (rt.startedAt ?? 0);
      if (uptime > 10 * 60 * 1000) rt.restarts = 0; // a healthy run resets crash backoff
      rt.lastExit = { code, at: Date.now() };
      if (rt.stopping || code === 0) {
        rt.state = 'stopped';
        rt.stopping = false;
      } else {
        rt.restarts = (rt.restarts ?? 0) + 1;
        if (rt.autoRestart !== false && rt.restarts <= 30) {
          rt.state = 'restarting';
          const delay = Math.min(5 * 60 * 1000, 15000 * rt.restarts);
          setTimeout(() => { if (!rt.stopping && rt.state === 'restarting') this.start(botId).catch(() => {}); }, delay);
        } else {
          rt.state = 'error';
        }
      }
      bot.state = rt.state; bot.updatedAt = Date.now(); store.save();
      rt.proc = null; // Windows signal kills keep exitCode null — a dead handle must not look alive to poll()/start()
      this.onUpdate();
    });
    bot.state = 'starting'; bot.updatedAt = Date.now(); store.save();
    this.onUpdate();
  }

  pause(botId) {
    const rt = this.rt(botId);
    if (!rt.proc || rt.proc.exitCode !== null || rt.proc.signalCode !== null) return;
    rt.state = 'pausing';
    this.control(botId, 'pause');
    this.onUpdate();
  }

  resume(botId) { this.control(botId, 'run'); this.start(botId); this.onUpdate(); }

  stop(botId) {
    const rt = this.rt(botId);
    this.control(botId, 'stop'); // also cancels a queued start
    rt.stopping = true;
    rt.state = 'stopping';
    if (!rt.proc || rt.proc.exitCode !== null || rt.proc.signalCode !== null) { rt.state = 'stopped'; rt.stopping = false; this.onUpdate(); return; }
    const proc = rt.proc;
    setTimeout(() => { try { if (proc.exitCode === null) proc.kill(); } catch {} }, 25000);
    this.onUpdate();
  }

  async stopAll() {
    for (const bot of store.data.bots) this.stop(bot.id);
  }

  // Reliable single restart for mode changes (UI stop→7s→play races the graceful-exit window and can be
  // silently swallowed). stop → wait for the process to actually exit → drop any stale handle → start.
  async restartBot(botId) {
    const bot = store.findBot(botId);
    if (!bot) return { ok: false, error: 'bot not found' };
    const rt = this.rt(botId);
    this.stop(botId);
    const t0 = Date.now();
    while (Date.now() - t0 < 45000) {
      if (!rt.proc || rt.proc.exitCode !== null || rt.proc.signalCode !== null || rt.state === 'stopped') break;
      await sleep(700);
    }
    if (rt.proc && rt.proc.exitCode === null && rt.proc.signalCode === null) { try { rt.proc.kill(); } catch {} await sleep(1200); }
    rt.proc = null; // a stale dead handle would silently block start()
    rt.stopping = false;
    await this.start(botId);
    return { ok: true, id: botId };
  }

  // Fleet restart: stop everything, wait for all exits, kill stragglers, drop stale handles, then start with ramp.
  // Use after pushing mode changes (mode is read at spawn) or to reload runner code fleet-wide.
  async restartAll({ rampMs = 3000 } = {}) {
    await this.stopAll();
    const t0 = Date.now();
    const alive = () => [...this.runtime.values()].some((rt) => rt.proc && rt.proc.exitCode === null && rt.proc.signalCode === null);
    while (alive() && Date.now() - t0 < 50000) await sleep(800);
    for (const rt of this.runtime.values()) {
      if (rt.proc && rt.proc.exitCode === null && rt.proc.signalCode === null) { try { rt.proc.kill(); } catch {} }
      rt.proc = null;
      rt.stopping = false;
    }
    await sleep(1500);
    const bots = store.data.bots.slice();
    for (let i = 0; i < bots.length; i++) this.start(bots[i].id, { delayMs: i * rampMs }).catch(() => {});
    return { ok: true, count: bots.length, rampMs };
  }

  // Restart a SUBSET of bots (mode/map changes for selected bots only — avoids a full-fleet bounce).
  async restartMany(botIds) {
    const ids = [...new Set(botIds.map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x) && !!store.findBot(x)))];
    for (const id of ids) this.stop(id);
    const t0 = Date.now();
    const anyAlive = () => ids.some((id) => { const rt = this.runtime.get(id); return rt && rt.proc && rt.proc.exitCode === null && rt.proc.signalCode === null; });
    while (anyAlive() && Date.now() - t0 < 50000) await sleep(800);
    for (const id of ids) {
      const rt = this.runtime.get(id); if (!rt) continue;
      if (rt.proc && rt.proc.exitCode === null && rt.proc.signalCode === null) { try { rt.proc.kill(); } catch {} }
      rt.proc = null; rt.stopping = false;
    }
    await sleep(1000);
    for (let i = 0; i < ids.length; i++) this.start(ids[i], { delayMs: i * 1500 }).catch(() => {});
    return { ok: true, count: ids.length, ids };
  }

  // 🔥 EMERGENCY — sever every bot's game connection INSTANTLY (hard kill, no graceful leave) and keep
  // them down (no auto-restart). Bring bots back with the normal Play / start-all buttons afterwards.
  disconnectAll() {
    let killed = 0;
    for (const [id, rt] of this.runtime) {
      rt.stopping = true; // the exit handler must NOT auto-restart from this
      try { this.control(id, 'stop'); } catch {} // cancels queued (delayed) starts; hint for anything mid-loop
      if (rt.proc && rt.proc.exitCode === null && rt.proc.signalCode === null) { try { if (rt.proc.kill()) killed++; } catch {} }
      rt.state = 'stopped';
      rt.grantPending = false;
    }
    for (const bot of store.data.bots) { bot.state = 'stopped'; bot.updatedAt = Date.now(); }
    try { store.save(); } catch {}
    this.onUpdate();
    return { ok: true, killed, total: store.data.bots.length };
  }

  async startMany(characterIds, { rampMs = 5000 } = {}) {
    const started = [];
    for (let i = 0; i < characterIds.length; i++) {
      const bot = this.ensureBot(characterIds[i]);
      started.push(bot.id);
      this.start(bot.id, { delayMs: i * rampMs }).catch(() => {});
    }
    return started;
  }

  // ---- polling: status files + JSONL tailing ----
  poll() {
    for (const [botId, rt] of this.runtime) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(rt.dir, 'status.json'), 'utf8'));
        rt.status = s;
        const fresh = Date.now() - (s.ts ?? 0) < 90000;
        if (fresh) {
          if (rt.state === 'starting' && s.map) rt.state = 'running';
          if (s.state === 'paused' && rt.state !== 'stopping') rt.state = 'paused';
          else if (s.state === 'running' && rt.state !== 'stopping' && rt.state !== 'pausing' && !rt.stopping && rt.proc && rt.proc.exitCode === null) rt.state = 'running';
        } else if (rt.proc && rt.proc.exitCode === null && rt.state === 'running') {
          rt.state = 'stalled';
        }
      } catch {}
      this.tailEvents(botId, rt);
      const alive = rt.proc && rt.proc.exitCode === null;
      // stall watchdog: a running bot whose status stopped updating gets recycled (exit → auto-restart)
      if (alive && rt.state === 'running' && rt.status && Date.now() - (rt.status.ts ?? 0) > 300000) {
        if (Date.now() - (rt.lastStallKill ?? 0) > 10 * 60 * 1000) {
          rt.lastStallKill = Date.now();
          console.error(`[watchdog] bot ${botId} stalled (no status for 5min) — recycling`);
          try { rt.proc.kill(); } catch {}
        }
      }
      // a bot stuck in 'starting' for too long also gets recycled
      if (alive && rt.state === 'starting' && Date.now() - (rt.startedAt ?? 0) > 7 * 60 * 1000) {
        if (Date.now() - (rt.lastStallKill ?? 0) > 10 * 60 * 1000) {
          rt.lastStallKill = Date.now();
          console.error(`[watchdog] bot ${botId} stuck starting for 7min — recycling`);
          try { rt.proc.kill(); } catch {}
        }
      }
      if (!alive && !rt.stopping && rt.state !== 'stopped' && rt.state !== 'error' && rt.state !== 'queued' && rt.state !== 'restarting') {
        rt.state = rt.lastExit?.code === 0 ? 'stopped' : (rt.lastExit ? 'error' : rt.state);
      }
    }
    try { this._ledgerTick(); } catch {}
    if (this._killDirty && Date.now() - (this._killSavedAt ?? 0) > 30000) this._saveKills();
    this.pollCollect();
    this.onUpdate();
  }

  // ---- collect queue (trade to collector, one bot at a time) ----
  pollCollect() {
    const settings = store.getSettings?.() ?? {};
    const col = settings.collector;
    // ---- auto-collect scheduler: every X hours, queue only bots that actually have something to hand over ----
    const ac = settings.autoCollect;
    if (ac?.enabled && this.activeTrade == null && !this.tradeQueue.length) {
      if (!ac.lastAt) { ac.lastAt = Date.now(); store.save?.(); }
      const period = Math.max(15, ac.everyMin ?? 360) * 60000;
      if (Date.now() - ac.lastAt > period) {
        const ids = this.eligibleCollectBots(ac);
        ac.lastAt = Date.now();
        try { store.save?.(); } catch {}
        if (ids.length) {
          for (const id of ids) { if (!this.tradeQueue.includes(id)) this.tradeQueue.push(id); }
          console.log(`[auto-collect] queued ${ids.length} bot(s): ${ids.join(',')}`);
          this._saveQueue();
          this.onUpdate?.();
        }
      }
    }
    let qDirty = false, hDirty = false;
    for (const [botId, rt] of this.runtime) {
      const bot = store.findBot(botId);
      if (!bot || bot.mode === 'collector') continue;
      const st = rt.status;
      // a held bot (✕ removed) rejoins the pool once its want-cycle resets (wantCollect flips false, e.g. after a bounce)
      if (rt.collectHold && st && st.wantCollect === false) { rt.collectHold = false; hDirty = true; }
      if (st?.wantCollect && !rt.collectHold && !this.tradeQueue.includes(botId) && this.activeTrade !== botId && !rt.grantPending) { this.tradeQueue.push(botId); qDirty = true; }
    }
    if (qDirty || hDirty) this._saveQueue();
    if (this.activeTrade != null) {
      const rt = this.runtime.get(this.activeTrade);
      const doneAt = rt?.status?.collectDone?.at ?? 0;
      const stuck = Date.now() - (rt?.grantAt ?? 0) > 10 * 60 * 1000;
      if ((doneAt && doneAt >= (rt?.grantAt ?? 0)) || stuck) {
        try { this.clearGrant(this.activeTrade); } catch {}
        if (rt) rt.grantPending = false;
        this.activeTrade = null;
        this._saveQueue();
      }
    }
    // grants only while the collector bot is actually up — with it stopped/paused/crashed, a granted donor
    // would trek to the spot and loiter until its 25-min cap doing nothing (e.g. the user stopped the
    // collector to log in and retrieve items manually). The queue holds instead: donors keep farming and it
    // drains as soon as the collector is running again.
    if (this.activeTrade == null && this.tradeQueue.length && col?.charName && this.collectorLive()) {
      const botId = this.tradeQueue.shift();
      const rt = this.runtime.get(botId);
      if (rt) {
        rt.grantPending = true;
        this.grantCollect(botId, { collector: col.charName, channel: col.channel ?? 1, spot: col.spot ?? { x: 880, y: 1520 } });
        this.activeTrade = botId;
        this._saveQueue();
      }
    }
  }

  collectView() {
    const settings = store.getSettings?.() ?? {};
    return { queue: [...this.tradeQueue], active: this.activeTrade, held: this.heldList(), collector: settings.collector ?? null, collectorLive: this.collectorLive(), tracked: settings.tracked ?? [], autoCollect: settings.autoCollect ?? null };
  }
  // is the collector bot up (running/starting)? — grants are held while it is not, so donors never trek out for nothing
  collectorLive() {
    const colBot = store.data.bots.find((b) => b.mode === 'collector');
    const rt = colBot ? this.runtime.get(colBot.id) : null;
    return !!rt && (rt.state === 'running' || rt.state === 'starting');
  }

  // bots that have whitelist items in the bag or zeny waiting beyond the 50k reserve
  eligibleCollectBots(ac = {}) {
    const out = [];
    for (const [botId, rt] of this.runtime) {
      const bot = store.findBot(botId);
      if (!bot || bot.mode === 'collector') continue;
      if (rt.state !== 'running') continue;
      if (rt.collectHold) continue; // ✕ skip honored by the auto-scheduler too
      const st = rt.status;
      const fresh = st && Date.now() - (st.ts ?? 0) < 120000;
      if (!fresh || !st.selfId) continue;
      if (this.activeTrade === botId || this.tradeQueue.includes(botId)) continue;
      const keep = new Set(bot.cfg?.keep ?? []);
      // donors have no storage by policy — eligibility looks at the bag only
      const stacks = (st.inventory ?? []).filter((it) => keep.has(it.itemId)).length;
      const zeny = st.zeny ?? 0;
      if (stacks >= (ac.minStacks ?? 1) || zeny > 50000 + (ac.minZeny ?? 15000)) out.push(botId);
    }
    return out;
  }

  tailEvents(botId, rt) {
    let files = [];
    try { files = fs.readdirSync(rt.dir).filter((f) => f.startsWith('run-') && f.endsWith('.jsonl')).sort(); } catch { return; }
    const newest = files[files.length - 1];
    if (!newest) return;
    const p = path.join(rt.dir, newest);
    let size = 0;
    try { size = fs.statSync(p).size; } catch { return; }
    if (rt.tailFile !== newest) {
      rt.tailFile = newest; rt.tailCarry = '';
      // resume where this bot's log was left off (persisted kill-log tails) — 0 when the file is new
      const remember = this.killLog.tails?.[botId];
      rt.tailOffset = (remember && remember.file === newest && remember.off > 0 && remember.off <= size) ? remember.off : 0;
    }
    if (size < rt.tailOffset) { rt.tailOffset = 0; rt.tailCarry = ''; }
    if (size === rt.tailOffset) return;
    const len = size - rt.tailOffset;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(p, 'r');
    try { fs.readSync(fd, buf, 0, len, rt.tailOffset); } finally { fs.closeSync(fd); }
    rt.tailOffset = size;
    const text = rt.tailCarry + buf.toString('utf8');
    const lines = text.split('\n');
    rt.tailCarry = lines.pop() ?? '';
    const tl = this.killLog.tails[botId] ?? (this.killLog.tails[botId] = { file: newest, off: 0, last: '' });
    let read = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      read = true;
      try {
        const evt = JSON.parse(line);
        // kill log: count per (local day, bot, monster) — monotonic timestamps fence off re-reads
        if (evt?.t && evt.t > (tl.last || '')) {
          tl.last = evt.t;
          if (evt.evt === 'kill') {
            const key = dayKey(evt.t) + '|' + botId + '|' + (evt.data?.m ?? '?');
            this.killLog.rows[key] = (this.killLog.rows[key] ?? 0) + 1;
          }
        }
        // remember the last meaningful event for the card activity badge (skip heartbeats)
        if (evt && evt.evt && evt.evt !== 'HEARTBEAT') rt.lastEvt = { evt: evt.evt, b: EVT_BRIEF(evt.evt, evt.data ?? {}), at: Date.now() };
        this.onEvent(botId, evt);
      } catch {}
    }
    if (read) { tl.file = newest; tl.off = rt.tailOffset; this._killDirty = true; }
  }

  // ---- views for API/UI ----
  view() {
    return store.data.bots.map((bot) => {
      const rt = this.runtime.get(bot.id);
      const c = store.findCharacter(bot.characterId);
      const a = c ? store.findAccount(c.accountId) : null;
      return {
        id: bot.id,
        characterId: bot.characterId,
        name: c?.name ?? `char#${bot.characterId}`,
        account: a?.userId ?? null,
        mode: bot.mode,
        group: bot.group ?? null,
        state: this.stateOf(bot.id),
        status: rt?.status ?? null,
        lastExit: rt?.lastExit ?? null,
        restarts: rt?.restarts ?? 0,
        activity: rt?.lastEvt ?? null,
        cfg: bot.cfg ?? null,
        plan: bot.plan ?? null,
      };
    });
  }

  stateOf(botId) {
    const rt = this.runtime.get(botId);
    if (!rt) return store.findBot(botId)?.state ?? 'stopped';
    return rt.state;
  }
}
