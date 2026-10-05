// Fleet health check — usage: node cccheck.mjs
const CC = 'http://127.0.0.1:4310';
const s = await (await fetch(CC + '/api/state')).json();
const bots = s.bots || [];
const hist = (f) => bots.reduce((a, b) => { const k = String(f(b) ?? '?'); a[k] = (a[k] || 0) + 1; return a; }, {});

console.log(`SUMMARY   accounts=${s.accounts.length} chars=${s.characters.length} bots=${bots.length}`);
console.log('STATES   ', JSON.stringify(hist(b => b.state)));
console.log('CLASSES  ', JSON.stringify(hist(b => b.status?.classId)));
console.log('STEPS    ', JSON.stringify(hist(b => b.status?.step)));
const bases = bots.map(b => b.status?.base).filter(v => typeof v === 'number');
const jobs = bots.map(b => b.status?.job).filter(v => typeof v === 'number');
if (bases.length) console.log(`LEVELS    base ${Math.min(...bases)}..${Math.max(...bases)} | job ${Math.min(...jobs)}..${Math.max(...jobs)}`);
const knights = bots.filter(b => b.status?.classId === 'knight').length;
const atFrost = bots.filter(b => b.status?.step === '31-frost-farm').length;
console.log(`MILESTONE knights=${knights} | at-frost(peco-done)=${atFrost}  (target: 50 knight+peco)`);
const restarted = bots.filter(b => b.restarts > 0).map(b => `#${b.id} x${b.restarts}(exit ${b.lastExit?.code ?? '?'})`);
console.log('RESTARTS ', restarted.length ? restarted.join(', ') : 'none');
const dead = bots.filter(b => b.status?.dead).map(b => `#${b.id}`);
console.log('DEAD     ', dead.length ? dead.join(', ') : 'none');
const odd = bots.filter(b => !['running', 'starting', 'paused'].includes(b.state)).map(b => `#${b.id}:${b.state}`);
console.log('ODD      ', odd.length ? odd.join(', ') : 'none');
