// tmp-watchdog.mjs — INSTANT event watchdog (fs.watch, no polling delay) for bots' run logs.
// Prints captcha/jail/whisper events the moment they hit disk and exits early on their occurrence,
// so the terminal-completion notification wakes the agent (= immediate user alert). Safe to delete.
// usage: node src/tmp-watchdog.mjs 108,109 [seconds=3600]
import fs from 'fs';
import path from 'path';

const BOTS = 'E:/GitHub/lumivaraonline/aetheria/command-center/data/bots';
const ids = (process.argv[2] || '').split(',').map((s) => s.trim()).filter(Boolean);
const total = parseInt(process.argv[3] || '3600', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().slice(11, 19);

// NOTE: jail_hold_tick is the every-60s stand-still heartbeat — deliberately NOT here (it caused a false
// wake-up 2026-10-12). Only real transitions count: detected / hold start / released.
const INTERESTING = /message:human_check|captcha_|jail_detected|jail_hold_start|jail_released|whisper_recv|gm_reply_|message:alert|^DEATH$/;
const state = new Map(); // id -> { file, off, carry }
const printed = new Set();
let exitAt = null;
let exitReason = '';

const newestRun = (id) => {
  const dir = path.join(BOTS, id);
  try {
    return fs.readdirSync(dir).filter((f) => /^run-.*\.jsonl$/.test(f))
      .map((f) => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0]?.f ?? null;
  } catch { return null; }
};

function trigger(kind, why) {
  const grace = kind === 'whisper' ? 90000 : kind === 'captcha' ? 45000 : 30000;
  const at = Date.now() + grace;
  if (exitAt === null || at > exitAt) { exitAt = at; exitReason = why; }
}

function scan(id) {
  const file = newestRun(id);
  if (!file) return;
  let sz = 0;
  try { sz = fs.statSync(file).size; } catch { return; }
  let st = state.get(id);
  if (!st) { st = { file: null, off: 0, carry: '' }; state.set(id, st); }
  if (st.file !== file) {
    st.off = st.file === null ? sz : Math.max(0, sz - 4000); // first sight = end; rotation = small overlap
    st.file = file;
    st.carry = '';
  }
  if (sz < st.off) { st.off = 0; st.carry = ''; } // truncated
  if (sz <= st.off) return;
  let buf = '';
  try {
    const fd = fs.openSync(file, 'r');
    const len = Math.min(sz - st.off, 1024 * 1024);
    const b = Buffer.alloc(len);
    fs.readSync(fd, b, 0, len, st.off);
    fs.closeSync(fd);
    buf = b.toString('utf8');
  } catch { return; }
  st.off += Math.min(Buffer.byteLength(buf, 'utf8'), sz - st.off);
  const text = st.carry + buf;
  const parts = text.split(/\r?\n/);
  st.carry = parts.pop() ?? '';
  if (st.carry.length > 65536) st.carry = '';
  for (const line of parts) {
    if (!line || line.includes('"evt":"HEARTBEAT"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const evt = String(o.evt || '');
    if (!INTERESTING.test(evt)) continue;
    const key = `${id}:${o.t}:${evt}:${o.data?.id ?? ''}`;
    if (printed.has(key)) continue;
    printed.add(key);
    let d = '';
    try { d = JSON.stringify(o.data); } catch {}
    if (d.length > 300) d = d.slice(0, 300);
    console.log(`[${now()}] bot ${id}  ${o.t}  ${evt}  ${d}`);
    if (/^captcha_err$|^captcha_answer_fail$/.test(evt)) trigger('error', `${evt} on bot ${id}`);
    else if (/^captcha_/.test(evt) || evt === 'message:human_check') trigger('captcha', `${evt} on bot ${id}`);
    else if (/^jail_(detected|hold_start|released)$/.test(evt) || evt === 'message:alert') trigger('jail', `${evt} on bot ${id}`);
    else if (evt === 'whisper_recv') trigger('whisper', `GM whisper on bot ${id}`);
    else if (/^gm_reply_fail|^gm_reply_capped/.test(evt)) trigger('error', `${evt} on bot ${id}`);
  }
}

const watchers = [];
for (const id of ids) {
  try {
    const w = fs.watch(path.join(BOTS, id), { persistent: true }, () => scan(id));
    w.on('error', () => {}); // dir deleted/renamed mid-run must not crash the process
    watchers.push(w);
  } catch (e) {
    console.log(`[${now()}] fs.watch failed for bot ${id}: ${(e && e.message) || e} (fallback sweep only)`);
  }
}
for (const id of ids) scan(id); // prime at end-of-file
console.log(`[${now()}] watchdog up — bots ${ids.join(',')} · fs.watch active · ${total}s · instant alerts: captcha/error/jail/GM-whisper`);

const start = Date.now();
while (Date.now() - start < total * 1000) {
  if (exitAt !== null && Date.now() >= exitAt) {
    console.log(`[${now()}] >>> WATCHDOG_EXIT: ${exitReason}`);
    process.exit(0);
  }
  for (const id of ids) scan(id); // 5s fallback sweep (in case fs.watch misses a write)
  await sleep(5000);
}
console.log(`[${now()}] watchdog finished — no triggering events in ${total}s`);
