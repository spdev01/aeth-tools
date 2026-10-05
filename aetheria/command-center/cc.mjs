// cc.mjs — command-center fleet helper
// usage: node cc.mjs state | register N | start [rampMs] | stopall | watch
const BASE = 'http://127.0.0.1:4310';
const api = async (p, m = 'GET', b) => {
  const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return r.json().catch(() => ({}));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cmd = process.argv[2];
const arg1 = process.argv[3];

if (cmd === 'state') {
  const s = await api('/api/state');
  const by = {};
  for (const b of s.bots) by[b.state] = (by[b.state] || 0) + 1;
  console.log(`accounts=${s.accounts.length} chars=${s.characters.length} bots=${s.bots.length} | ${Object.entries(by).map(([k, v]) => `${k}:${v}`).join(' ')}`);
  for (const b of s.bots) {
    const st = b.status ?? {};
    if (b.state !== 'stopped') console.log(`  #${b.id} ${b.name} [${b.state}] base:${st.base ?? '?'} job:${st.job ?? '?'} ${st.map ?? '-'} step:${st.step ?? '-'}${st.dead ? ' DEAD' : ''}${b.lastExit ? ' exit:' + b.lastExit.code : ''}${b.restarts ? ' r:' + b.restarts : ''}`);
  }
} else if (cmd === 'register') {
  const n = parseInt(arg1 || '1', 10);
  const r = await api('/api/accounts/register', 'POST', { count: n, createChars: true, autoInclude: true });
  console.log('job started', JSON.stringify(r));
  for (let i = 0; i < 240; i++) {
    await sleep(3000);
    const s = await api('/api/state');
    const j = s.jobs.active;
    if (!j) { console.log('job done | accounts:', s.accounts.length, 'chars:', s.characters.length); break; }
    if (i % 4 === 3) console.log(`  ${j.kind} ${j.done}/${j.total} failed:${j.failed} :: ${(j.log.slice(-1)[0] || {}).msg ?? ''}`);
  }
} else if (cmd === 'start') {
  const rampMs = parseInt(arg1 || '3000', 10);
  const r = await api('/api/bots/start', 'POST', { rampMs });
  console.log('starting:', r.started?.length, 'bots (ramp', rampMs + 'ms)');
} else if (cmd === 'stopall') {
  console.log(await api('/api/bots/stop-all', 'POST'));
} else if (cmd === 'watch') {
  for (;;) {
    const s = await api('/api/state');
    const by = {};
    for (const b of s.bots) by[b.state] = (by[b.state] || 0) + 1;
    const lv = s.bots.filter((b) => b.status?.base).map((b) => b.status.base);
    const knightsDone = s.bots.filter((b) => b.status?.classId === 'knight' && b.status?.step && (b.status.step.includes('31-frost') || b.status.step.includes('30-peco'))).length;
    console.log(new Date().toISOString().slice(11, 19), Object.entries(by).map(([k, v]) => `${k}:${v}`).join(' '), `| base ${lv.length ? Math.min(...lv) + '-' + Math.max(...lv) : '-'} | knight+ @peco/frost: ${knightsDone}`);
    await sleep(30000);
  }
} else {
  console.log('usage: state | register N | start [rampMs] | stopall | watch');
}
