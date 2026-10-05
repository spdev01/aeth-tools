// smoke test: register 2 accounts (with chars), start 2 bots, observe
const BASE = 'http://127.0.0.1:4310';
const api = async (p, m = 'GET', b) => {
  const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return r.json().catch(() => ({}));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const st0 = await api('/api/state');
console.log('initial: accounts=', st0.accounts.length, 'characters=', st0.characters.length, 'bots=', st0.bots.length);

if (st0.accounts.length === 0) {
  console.log('registering 2 accounts (with characters, auto-include)...');
  await api('/api/accounts/register', 'POST', { count: 2, createChars: true, autoInclude: true });
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const s = await api('/api/state');
    const j = s.jobs.active;
    if (!j) {
      const h = s.jobs.history[0];
      console.log('job:', h ? `${h.kind} ${h.status} ${h.done}/${h.total}` : 'none');
      console.log('accounts:', s.accounts.map((a) => `${a.label}(${a.userId})`).join(', '));
      console.log('characters:', s.characters.map((c) => `${c.name}${c.included ? '*' : ''}`).join(', '));
      break;
    }
    if (i % 5 === 4) console.log(`  ... ${j.kind} ${j.done}/${j.total} failed:${j.failed}`);
  }
}

const st1 = await api('/api/state');
console.log('starting bots (ramp 4s)...');
const r = await api('/api/bots/start', 'POST', { rampMs: 4000 });
console.log('started:', JSON.stringify(r));

for (let i = 0; i < 12; i++) {
  await sleep(5000);
  const s = await api('/api/state');
  console.log(`t+${(i + 1) * 5}s:`, s.bots.map((b) => `#${b.id} ${b.name} [${b.state}] ${b.status?.map ?? '-'} hp:${b.status?.hp ?? '?'} step:${b.status?.step ?? '-'}`).join(' | ') || '(none)');
}
