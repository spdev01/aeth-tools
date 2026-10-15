// tmp-watchdog2.mjs — ANOMALY-ONLY captcha watchdog (v2, 2026-10-14; supersedes tmp-watchdog.mjs).
// Routine captcha traffic (seen/resolve/answer/outcome/dismiss) no longer wakes anyone — it is logged [ok].
// The watchdog EXITS EARLY (→ terminal-completion notification → agent wakes → alerts the user) ONLY on:
//   shape    — captcha payload deviates from the two known schemas (items≠{0,4}, image format≠webp,
//              items+image mixed, prompt no longer starts with กดรูป, empty items AND no image)
//   silent   — captcha received but NO solver/answer activity within 25s (image) / 75s (old) —
//              catches handler-breaking payload surprises silently ignored in dispatch
//   solver   — captcha_image_solve ok:false (decode/match failed)
//   nomatch  — captcha_no_match / captcha_give_up (couldn't produce an answer)
//   error    — captcha_err / captcha_answer_fail / captcha_answer_skip
//   wrong    — captcha_retry_received (server re-sent ⇒ our answer was WRONG)
//   lowconf  — image answer with score<0.30 or margin<0.06 (possible art/type drift; borderline 0.30-0.42/0.06-0.12 prints [warn] only)
//   jaillike — jail_detected / jail_hold_start / jail_released / any message:alert
//   gm       — whisper_recv (GM talking) / gm_reply_fail / gm_reply_capped
// usage: node src/tmp-watchdog2.mjs [ids=allBots] [seconds=86400]
import fs from 'fs';
import path from 'path';

const BOTS = 'E:/GitHub/lumivaraonline/aetheria/command-center/data/bots';
const idsArg = (process.argv[2] || '').trim();
const total = parseInt(process.argv[3] || '86400', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().slice(11, 19);

const WATCH = /message:human_check|captcha_|jail_detected|jail_hold_start|jail_released|whisper_recv|gm_reply_|message:alert/;

const state = new Map(); // botId -> { file, off, carry }
const printed = new Set();
const pending = new Map(); // captchaId -> { at, kind:'image'|'old', bot }
let exitAt = null;
let exitReason = '';
const anomalyCount = new Map(); // kind -> count

function anomaly(bot, kind, detail) {
  const grace = kind === 'gm' ? 90000 : kind === 'jaillike' ? 30000 : 45000;
  anomalyCount.set(kind, (anomalyCount.get(kind) || 0) + 1);
  console.log(`[${now()}] *** ANOMALY[${kind}] bot ${bot}: ${detail}  (exit in ${Math.round(grace / 1000)}s)`);
  const at = Date.now() + grace;
  if (exitAt === null || at > exitAt) { exitAt = at; exitReason = `${kind} — bot ${bot}: ${detail}`; }
}

const newestRun = (id) => {
  const dir = path.join(BOTS, String(id));
  try {
    return fs.readdirSync(dir).filter((f) => /^run-.*\.jsonl$/.test(f))
      .map((f) => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0]?.f ?? null;
  } catch { return null; }
};

function scan(id) {
  const file = newestRun(id);
  if (!file) return;
  let sz = 0;
  try { sz = fs.statSync(file).size; } catch { return; }
  let st = state.get(id);
  if (!st) { st = { file: null, off: 0, carry: '' }; state.set(id, st); }
  if (st.file !== file) { st.off = st.file === null ? sz : Math.max(0, sz - 4000); st.file = file; st.carry = ''; }
  if (sz < st.off) { st.off = 0; st.carry = ''; }
  if (sz <= st.off) return;
  let buf = '';
  try {
    const fd = fs.openSync(file, 'r');
    const len = Math.min(sz - st.off, 1024 * 1024);
    const bb = Buffer.alloc(len);
    fs.readSync(fd, bb, 0, len, st.off);
    fs.closeSync(fd);
    buf = bb.toString('utf8');
  } catch { return; }
  st.off += Math.min(Buffer.byteLength(buf, 'utf8'), sz - st.off);
  const text = st.carry + buf;
  const parts = text.split(/\r?\n/);
  st.carry = parts.pop() ?? '';
  if (st.carry.length > 65536) st.carry = '';

  for (const line of parts) {
    if (!line || line.includes('"evt":"HEARTBEAT"') || line.includes('"jail_hold_tick"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const evt = String(o.evt || '');
    if (!WATCH.test(evt)) continue;
    const d = o.data;
    const cid = d && typeof d === 'object' ? d.id ?? '' : '';
    const key = `${id}:${o.t}:${evt}:${cid}`;
    if (printed.has(key)) continue;
    printed.add(key);
    const log = (mark, txt) => console.log(`[${now()}] ${mark} bot ${id} ${o.t} ${evt} ${txt}`);

    // ---- incoming captcha (raw payload available here → full shape check) ----
    if (evt === 'message:human_check') {
      if (d === null || typeof d !== 'object') { log('[ok]', '(dismissal)'); continue; }
      const items = Array.isArray(d.items) ? d.items : null;
      const hasImg = typeof d.image === 'string';
      const prompt = String(d.prompt || '');
      let bad = null;
      if (items === null) bad = 'items not an array';
      else if (items.length === 0 && !hasImg) bad = 'items=[] AND no image field';
      else if (hasImg && !/^data:image\/webp;base64,/.test(d.image)) bad = 'image format changed: ' + d.image.slice(0, 40);
      else if (items.length > 0 && hasImg) bad = 'MIXED payload: items + image';
      else if (items.length !== 0 && items.length !== 4) bad = `items.length=${items.length} (known: 0 or 4)`;
      else if (!prompt.startsWith('กดรูป')) bad = 'prompt changed: ' + prompt.slice(0, 60);
      if (bad) anomaly(id, 'shape', `${bad} (id=${cid}, prompt="${prompt.slice(0, 50)}")`);
      else log('[ok]', `captcha ${cid} kind=${items.length ? 'old' : 'image'} tries=${d.triesLeft ?? '?'} expIn=${d.expiresAt ? Math.round((d.expiresAt - Date.now()) / 1000) + 's' : '?'}`);
      if (cid) pending.set(String(cid), { at: Date.now(), kind: items && items.length ? 'old' : 'image', bot: id });
      continue;
    }

    // ---- solver / answer / outcome ----
    if (evt === 'captcha_image_solve') {
      if (cid) pending.delete(String(cid));
      if (d && d.ok === false) anomaly(id, 'solver', `image solve failed: ${d.reason ?? '?'} (id=${cid})`);
      else log('[ok]', `image solved id=${cid} x=${d?.x} y=${d?.y} score=${d?.score} margin=${d?.margin} ${d?.ms}ms`);
      continue;
    }
    if (evt === 'captcha_seen') { log('[ok]', `id=${cid} items=${Array.isArray(d?.items) ? d.items.length : '?'} retry=${d?.retry}`); if (cid && !pending.has(String(cid))) pending.set(String(cid), { at: Date.now(), kind: Array.isArray(d?.items) && d.items.length ? 'old' : 'image', bot: id }); continue; }
    if (evt === 'captcha_resolve') { log('[ok]', `best=${JSON.stringify(d?.best)?.slice(0, 120)}`); continue; }
    if (evt === 'captcha_answer') {
      if (cid) pending.delete(String(cid));
      if (d?.kind === 'image') {
        const sc = d.score ?? 0, mg = d.margin ?? 0;
        if (sc < 0.30 || mg < 0.06) anomaly(id, 'lowconf', `image answer id=${cid} x=${d.x} y=${d.y} score=${sc} margin=${mg} — possible art/type drift or wrong match`);
        else if (sc < 0.42 || mg < 0.12) log('[warn]', `image answer id=${cid} score=${sc} margin=${mg} (borderline)`);
        else log('[ok]', `image answer id=${cid} x=${d.x} y=${d.y} score=${sc} margin=${mg} attempt=${d.attempt}`);
      } else log('[ok]', `answer id=${cid} pick=${d?.pick} via=${d?.via} score=${d?.score} attempt=${d?.attempt}`);
      continue;
    }
    if (evt === 'captcha_outcome') { log('[ok]', `id=${cid} outcome=${d?.outcome}`); continue; }
    if (evt === 'captcha_retry_received') { anomaly(id, 'wrong', `server re-sent captcha id=${cid} (triesLeft=${d?.triesLeft}) — our previous answer was WRONG (pick=${d?.wrongPick ?? '?'})`); continue; }
    if (evt === 'captcha_no_match') { if (cid) pending.delete(String(cid)); anomaly(id, 'nomatch', `id=${cid} reason=${d?.reason ?? '?'}`); continue; }
    if (evt === 'captcha_give_up') { if (cid) pending.delete(String(cid)); anomaly(id, 'nomatch', `gave up id=${cid} allTried=${JSON.stringify(d?.allTried)?.slice(0, 80)}`); continue; }
    if (evt === 'captcha_answer_skip') { if (cid) pending.delete(String(cid)); anomaly(id, 'error', `answer SKIPPED id=${cid} why=${d?.why}`); continue; }
    if (/^captcha_err$|^captcha_answer_fail$/.test(evt)) { anomaly(id, 'error', `${evt}: ${JSON.stringify(d)?.slice(0, 180)}`); continue; }
    if (/^captcha_/.test(evt)) { log('[ok]', JSON.stringify(d)?.slice(0, 140)); continue; }

    // ---- jail / alerts / GM ----
    if (/^jail_(detected|hold_start|released)$/.test(evt) || evt === 'message:alert') { anomaly(id, 'jaillike', `${evt} ${JSON.stringify(d)?.slice(0, 160)}`); continue; }
    if (evt === 'whisper_recv') { anomaly(id, 'gm', `GM whisper: ${JSON.stringify(d)?.slice(0, 200)}`); continue; }
    if (/^gm_reply_fail|^gm_reply_capped/.test(evt)) { anomaly(id, 'gm', `${evt}: ${JSON.stringify(d)?.slice(0, 160)}`); continue; }
    if (/^gm_reply_/.test(evt)) { log('[ok]', JSON.stringify(d)?.slice(0, 140)); continue; }
    log('[ok]', JSON.stringify(d)?.slice(0, 140));
  }
}

// ---- scope: all bot dirs (or explicit ids) ----
const watched = new Set();
function watchBot(id) {
  if (watched.has(id)) return;
  watched.add(id);
  try { const w = fs.watch(path.join(BOTS, String(id)), { persistent: true }, () => scan(id)); w.on('error', () => {}); } catch { /* dir may vanish (purge) — sweep still works */ }
  scan(id);
}
if (idsArg) { for (const id of idsArg.split(',').map((s) => s.trim()).filter(Boolean)) watchBot(id); }
else { try { for (const e of fs.readdirSync(BOTS, { withFileTypes: true })) if (e.isDirectory()) watchBot(e.name); } catch {} }
console.log(`[${now()}] watchdog v2 (ANOMALY-ONLY) up — ${watched.size} bots · ${total}s · wakes on: shape-change / silent-captcha / solver-fail / wrong-answer / lowconf / jail / GM · routine captcha = [ok] log only`);

const start = Date.now();
let lastDirScan = Date.now();
while (Date.now() - start < total * 1000) {
  if (exitAt !== null && Date.now() >= exitAt) {
    const counts = [...anomalyCount.entries()].map(([k, v]) => `${k}×${v}`).join(' ');
    console.log(`[${now()}] >>> WATCHDOG_EXIT: ${exitReason}  [anomalies: ${counts}]`);
    process.exit(0);
  }
  for (const id of watched) scan(id);
  // pending "silent handler" checks
  for (const [cid, p] of pending) {
    const lim = p.kind === 'image' ? 25000 : 75000;
    if (Date.now() - p.at > lim) {
      anomaly(p.bot, 'silent', `captcha id=${cid} (${p.kind}) — no solver/answer activity in ${Math.round(lim / 1000)}s (handler may be broken by a payload change)`);
      pending.delete(cid);
    }
  }
  // pick up newly started/purged bots once a minute
  if (Date.now() - lastDirScan > 60000) {
    lastDirScan = Date.now();
    if (!idsArg) { try { for (const e of fs.readdirSync(BOTS, { withFileTypes: true })) if (e.isDirectory()) watchBot(e.name); } catch {} }
  }
  await sleep(5000);
}
console.log(`[${now()}] watchdog v2 finished — no anomalies in ${total}s`);
