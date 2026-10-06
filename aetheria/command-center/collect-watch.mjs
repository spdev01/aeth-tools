// Collect-queue watcher: monitors the queue until it fully drains, verifies every transfer,
// auto re-queues bots whose turn was skipped (ghost sessions), then exits with a summary.
// Logs to data/collect-watch.log.
import fs from 'node:fs';

const CC = 'http://127.0.0.1:4310';
const BOTS_DIR = 'e:/GitHub/lumivaraonline/aetheria/command-center/data/bots';
const LOG = 'e:/GitHub/lumivaraonline/aetheria/command-center/data/collect-watch.log';
const POLL_MS = 30000;
const MAX_MS = 4 * 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = () => new Date().toISOString();
const tshort = () => iso().substring(11, 19);

function out(s) {
  const line = `[${tshort()}] ${s}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
}
const api = async (p) => (await fetch(CC + p)).json();

function readTail(botId, maxLines = 300) {
  try {
    const dir = `${BOTS_DIR}/${botId}`;
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('run-') && f.endsWith('.jsonl')).sort();
    const f = files[files.length - 1];
    if (!f) return [];
    const lines = fs.readFileSync(`${dir}/${f}`, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-maxLines);
  } catch { return []; }
}
function lastEvent(botId, evt, sinceIso) {
  const lines = readTail(botId, 400);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e.evt === evt && (!sinceIso || e.t >= sinceIso)) return e;
    } catch {}
  }
  return null;
}
function recentEvent(botId, evt, withinMs) {
  const cutoff = new Date(Date.now() - withinMs).toISOString();
  const lines = readTail(botId, 300);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e.evt === evt && e.t >= cutoff) return e;
    } catch {}
  }
  return null;
}

const startTs = Date.now();
let st0;
try { st0 = await api('/api/state'); } catch (e) { out('FATAL: command center unreachable: ' + e.message); process.exit(1); }
const col0 = st0.bots.find((b) => b.id === 51);
const startZeny = col0?.status?.zeny ?? 0;
out(`=== collect watch start === queue=${(st0.collect.queue ?? []).length} active=${st0.collect.active} collectorZeny=${startZeny.toLocaleString()} bag=${col0?.status?.bag?.used ?? '?'}`);

let prevActive = st0.collect.active ?? null;
let prevQueueLen = (st0.collect.queue ?? []).length;
let lastChange = Date.now();
let lastWarn = 0;
let lastProgressAt = 0;
let doneLogged = false;
const turnStart = {};
if (prevActive != null) turnStart[prevActive] = iso();
const collections = [];
const skipped = [];
const requeued = new Set();

const nameOf = (st, id) => st.bots.find((b) => b.id === id)?.name ?? ('#' + id);

for (;;) {
  if (Date.now() - startTs > MAX_MS) { out('watch timeout (4h) — exiting'); process.exit(2); }
  await sleep(POLL_MS);
  let st;
  try { st = await api('/api/state'); } catch (e) { out('WARN api fail: ' + e.message); continue; }
  const active = st.collect.active ?? null;
  const q = st.collect.queue ?? [];
  const qLen = q.length;
  const cz = st.bots.find((b) => b.id === 51)?.status?.zeny ?? 0;

  if (active !== prevActive || qLen !== prevQueueLen) {
    // a turn just ended?
    if (prevActive != null && active !== prevActive) {
      const done = lastEvent(prevActive, 'collect_done', turnStart[prevActive]);
      if (done) {
        const d = done.data ?? {};
        collections.push({ bot: prevActive, name: nameOf(st, prevActive), zeny: d.zeny ?? 0, stacks: d.stacks ?? 0, withdrew: d.withdrew ?? 0, ms: d.ms ?? 0 });
        out(`DONE ${nameOf(st, prevActive)} (#${prevActive}) — zeny=${(d.zeny ?? 0).toLocaleString()} stacks=${d.stacks ?? 0} withdrew=${d.withdrew ?? 0} took=${Math.round((d.ms ?? 0) / 1000)}s | collectorZeny=${cz.toLocaleString()} | queue=${qLen}`);
      } else {
        const ghost = recentEvent(prevActive, 'connect_retry', 15 * 60 * 1000);
        const fail = lastEvent(prevActive, 'collect_fail', turnStart[prevActive]);
        skipped.push(prevActive);
        out(`SKIPPED ${nameOf(st, prevActive)} (#${prevActive}) — no collect_done${ghost ? ' (ghost session: character already online)' : ''}${fail ? ' (collect_fail: ' + JSON.stringify(fail.data).slice(0, 90) + ')' : ''} | queue=${qLen}`);
      }
    }
    if (active != null && active !== prevActive) {
      turnStart[active] = iso();
      const b = st.bots.find((x) => x.id === active);
      out(`START ${nameOf(st, active)} (#${active}) — map=${b?.status?.map ?? '?'} | queue=${qLen} | collectorZeny=${cz.toLocaleString()}`);
    }
    if (active == null && qLen === 0 && !doneLogged) out('QUEUE EMPTY — confirming');
    prevActive = active;
    prevQueueLen = qLen;
    lastChange = Date.now();
  } else if (active != null && Date.now() - lastChange > 12 * 60 * 1000 && Date.now() - lastWarn > 10 * 60 * 1000) {
    lastWarn = Date.now();
    const ghost = recentEvent(active, 'connect_retry', 10 * 60 * 1000);
    out(`STALL active=#${active} ${nameOf(st, active)} no progress for ${Math.round((Date.now() - lastChange) / 60000)}min ghost=${!!ghost} (poller auto-skips at 10min)`);
  }

  if (Date.now() - lastProgressAt > 10 * 60 * 1000) {
    lastProgressAt = Date.now();
    out(`progress — active=${active != null ? nameOf(st, active) : '—'} queue=${qLen} done=${collections.length} skipped=${skipped.length} collectorZeny=${cz.toLocaleString()}`);
  }

  if (active == null && qLen === 0) {
    if (!doneLogged) { doneLogged = true; out('queue drained — waiting 10s to confirm'); await sleep(10000); continue; }
    const retry = [];
    for (const id of new Set(skipped)) {
      if (requeued.has(id)) continue;
      const b = st.bots.find((x) => x.id === id);
      if (b && b.state === 'running' && b.status?.selfId) retry.push(id);
    }
    if (retry.length) {
      out('re-queueing skipped-but-healthy bots: ' + retry.map((id) => nameOf(st, id)).join(', '));
      for (const id of retry) { try { await fetch(`${CC}/api/bots/${id}/collect`, { method: 'POST' }); requeued.add(id); } catch {} }
      doneLogged = false;
      await sleep(15000);
      continue;
    }
    const totalZeny = collections.reduce((a, c) => a + c.zeny, 0);
    out('=== ALL DONE ===');
    out(`collections=${collections.length} totalZeny=${totalZeny.toLocaleString()} collectorZeny ${startZeny.toLocaleString()} -> ${cz.toLocaleString()} (delta=${(cz - startZeny).toLocaleString()})`);
    for (const c of collections) out(`  ${c.name}: ${c.zeny.toLocaleString()} zeny, ${c.stacks} stacks, withdrew ${c.withdrew}`);
    if (skipped.length) out(`still skipped: ${skipped.map((id) => nameOf(st, id)).join(', ')}`);
    out(`watch duration: ${Math.round((Date.now() - startTs) / 60000)} min`);
    process.exit(0);
  }
}
