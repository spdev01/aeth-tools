// Bot manager: spawns/kills one runner process per bot, drives play/pause/stop via control files,
// polls per-bot status.json for the UI, and tails per-bot JSONL logs into the live event stream.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { store } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
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

export class BotManager {
  constructor({ onUpdate = () => {}, onEvent = () => {} } = {}) {
    this.onUpdate = onUpdate;
    this.onEvent = onEvent;
    this.runtime = new Map(); // botId -> { proc, dir, state, status, tail* , pendingStart }
    this._poller = setInterval(() => this.poll(), 2000);
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

  control(botId, cmd) {
    const rt = this.rt(botId);
    fs.writeFileSync(path.join(rt.dir, 'control.json'), JSON.stringify({ cmd }));
  }

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
    rt.proc = spawn(process.execPath, [RUNNER, '--upto', UPTO], {
      cwd: TESTBOT,
      env: {
        ...process.env,
        AETHERIA_DATA: rt.dir,
        AETHERIA_USER: account.userId,
        AETHERIA_PASS: account.password,
        AETHERIA_QUIET: '1',
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
    this.onUpdate();
  }

  tailEvents(botId, rt) {
    let files = [];
    try { files = fs.readdirSync(rt.dir).filter((f) => f.startsWith('run-') && f.endsWith('.jsonl')).sort(); } catch { return; }
    const newest = files[files.length - 1];
    if (!newest) return;
    const p = path.join(rt.dir, newest);
    let size = 0;
    try { size = fs.statSync(p).size; } catch { return; }
    if (rt.tailFile !== newest) { rt.tailFile = newest; rt.tailOffset = 0; rt.tailCarry = ''; }
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
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        // remember the last meaningful event for the card activity badge (skip heartbeats)
        if (evt && evt.evt && evt.evt !== 'HEARTBEAT') rt.lastEvt = { evt: evt.evt, b: EVT_BRIEF(evt.evt, evt.data ?? {}), at: Date.now() };
        this.onEvent(botId, evt);
      } catch {}
    }
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
        state: this.stateOf(bot.id),
        status: rt?.status ?? null,
        lastExit: rt?.lastExit ?? null,
        restarts: rt?.restarts ?? 0,
        activity: rt?.lastEvt ?? null,
      };
    });
  }

  stateOf(botId) {
    const rt = this.runtime.get(botId);
    if (!rt) return store.findBot(botId)?.state ?? 'stopped';
    return rt.state;
  }
}
