// worker.mjs — one process per ROVA bot.
//
// CURRENT SCOPE (barebone): open the bot's OWN Tor circuit, PROVE it end-to-end (exit IP + IsTor verdict),
// then idle while obeying the control channel (run / pause / stop). The ROVA game client plugs in at the
// marked TODO below (auth → /ws HELLO → commands per rova/protocol/ROVA-PROTOCOL-INVENTORY.md) — the Tor
// gate, control channel, status file and JSONL logging around it are final.
//
// TOR IS MANDATORY. This worker never opens a direct connection to anything. If its circuit cannot be
// proven, it reports the failure and keeps retrying — it does NOT fall back to direct.
//
// Layout:  <ROVA_DATA>/control.json  (written by the CC: {cmd:'run'|'pause'|'stop'})
//          <ROVA_DATA>/status.json   (written here: state/pid/exitIp/... — the CC dashboard reads it)
//          <ROVA_DATA>/run-<iso>.jsonl  (event log; the CC tails the newest one)
import fs from 'node:fs';
import path from 'node:path';
import { portFor, socksUserFor, socksPassFor, daemonFor } from './tor-const.mjs';
import { torExitProbe } from './socks.mjs';

const OUT = process.env.ROVA_DATA ? path.resolve(process.env.ROVA_DATA) : null;
if (!OUT) { console.error('[worker] ROVA_DATA is required'); process.exit(2); }
const BOT_ID = parseInt(path.basename(OUT), 10);
if (!Number.isFinite(BOT_ID) || BOT_ID < 1) { console.error('[worker] cannot derive bot id from ' + OUT); process.exit(2); }
const MODE = process.env.ROVA_MODE || 'smoke';
const PORT = portFor(BOT_ID);
const PROXY_LABEL = `socks5h://bot${BOT_ID}:***@127.0.0.1:${PORT} (daemon ${daemonFor(BOT_ID)})`;

fs.mkdirSync(OUT, { recursive: true });
const RUN_FILE = path.join(OUT, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const logStream = fs.createWriteStream(RUN_FILE, { flags: 'a' });
const log = (evt, data = {}) => {
  try { logStream.write(JSON.stringify({ t: new Date().toISOString(), evt, data }) + '\n'); } catch {}
};

const status = {
  pid: process.pid, ts: Date.now(), state: 'starting', mode: MODE, bot: BOT_ID,
  proxy: PROXY_LABEL, port: PORT, exitIp: null, isTor: null, note: 'booting',
};
let writeAt = 0;
function writeStatus(force = false) {
  const now = Date.now();
  if (!force && now - writeAt < 2500) return;
  writeAt = now;
  status.ts = now;
  try { fs.writeFileSync(path.join(OUT, 'status.json.tmp'), JSON.stringify(status, null, 1)); fs.renameSync(path.join(OUT, 'status.json.tmp'), path.join(OUT, 'status.json')); } catch {}
}

function readControl() {
  try { return JSON.parse(fs.readFileSync(path.join(OUT, 'control.json'), 'utf8')); } catch { return null; }
}
function writeControl(obj) {
  try { fs.writeFileSync(path.join(OUT, 'control.json'), JSON.stringify(obj, null, 1)); } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

log('boot', { bot: BOT_ID, mode: MODE, proxy: PROXY_LABEL, pid: process.pid });
writeStatus(true);

let stopping = false;
let paused = false;
let torOk = false;
let probeFails = 0;
let lastHeartbeat = 0;
const startedAt = Date.now();

// prove the circuit before anything else is allowed to happen
async function probeTor() {
  status.state = torOk ? status.state : 'tor-probing';
  status.note = 'proving Tor circuit (exit IP + IsTor)…';
  writeStatus(true);
  try {
    const r = await torExitProbe({ port: PORT, user: socksUserFor(BOT_ID), pass: socksPassFor(BOT_ID) });
    torOk = true; probeFails = 0;
    lastHeartbeat = Date.now(); // don't re-probe immediately via the heartbeat branch
    status.state = paused ? 'paused' : 'ready';
    status.exitIp = r.ip; status.isTor = r.isTor; status.note = 'circuit proven — ' + r.via;
    log('proxy_exit', { ip: r.ip, isTor: r.isTor, via: r.via, port: PORT });
    if (!paused) log('ready', { note: 'Tor circuit live; game client not implemented yet (leveling plan pending)' });
    writeStatus(true);
    return true;
  } catch (e) {
    torOk = false; probeFails++;
    status.state = 'tor-fail';
    status.note = 'circuit probe failed (' + probeFails + '): ' + (e && e.message || e);
    log('tor_probe_fail', { attempt: probeFails, error: String(e && e.message || e) });
    writeStatus(true);
    return false;
  }
}

// TODO(rova-client): once torOk, build the ROVA client here:
//   1) HTTP auth via Tor (per rova/protocol inventory §1: /api/auth/* guest or password flow; device token `dv`)
//   2) WS connect wss://<host>/ws?dv=…  →  HELLO {v:1, …}  →  handle WELCOME/PONG/KICK
//   3) MODE loop: smoke = idle proof; leveling/farming = the plan we build next (AUTO_SET, MOVE/ATTACK, …)
// Everything must ride this worker's SOCKS circuit (see server/socks.mjs).

(async () => {
  while (!stopping) {
    const ctl = readControl();
    const cmd = ctl && ctl.cmd;
    if (cmd === 'stop') { log('control', { cmd }); break; }
    if (cmd === 'pause' && !paused) { paused = true; status.state = 'paused'; status.note = 'paused by command center'; log('control', { cmd }); writeStatus(true); }
    if (cmd === 'run' && paused) { paused = false; status.state = torOk ? 'ready' : 'starting'; status.note = 'resumed'; log('control', { cmd }); writeStatus(true); }

    if (!paused && !torOk) {
      await probeTor();
      if (!torOk) await sleep(Math.min(60000, 5000 * probeFails));
    } else if (!paused && torOk) {
      // stable: keep the circuit warm + heartbeat (re-prove every ~10 min so exit IP changes are tracked)
      const now = Date.now();
      if (now - lastHeartbeat > 10 * 60 * 1000) {
        lastHeartbeat = now;
        await probeTor();
      }
    }
    writeStatus();
    await sleep(2000);
  }
  status.state = 'stopped';
  status.note = 'exited (' + Math.round((Date.now() - startedAt) / 1000) + 's)';
  log('stopped', {});
  writeStatus(true);
  try { logStream.end(); } catch {}
  process.exit(0);
})().catch((e) => {
  log('error', { fatal: String(e && e.stack || e) });
  status.state = 'error'; status.note = String(e && e.message || e);
  writeStatus(true);
  setTimeout(() => process.exit(1), 250);
});
