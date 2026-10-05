// Persistent fleet monitor — appends a one-line summary every 10 min to data/monitor.log
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(dir, 'data', 'monitor.log');
const CC = 'http://127.0.0.1:4310';

for (;;) {
  try {
    const s = await (await fetch(CC + '/api/state')).json();
    const bots = s.bots || [];
    const states = bots.reduce((a, b) => { a[b.state] = (a[b.state] || 0) + 1; return a; }, {});
    const bases = bots.map(b => b.status?.base).filter(v => typeof v === 'number');
    const jobs = bots.map(b => b.status?.job).filter(v => typeof v === 'number');
    const knights = bots.filter(b => b.status?.classId === 'knight').length;
    const atFrost = bots.filter(b => b.status?.step === '31-frost-farm').length;
    const restarts = bots.filter(b => b.restarts > 0).length;
    const dead = bots.filter(b => b.status?.dead).length;
    const r = (a) => (a.length ? `${Math.min(...a)}..${Math.max(...a)}` : '-');
    const line = `${new Date().toISOString()} states=${JSON.stringify(states)} base=${r(bases)} job=${r(jobs)} knights=${knights} frost=${atFrost} restarts=${restarts} dead=${dead}`;
    fs.appendFileSync(LOG, line + '\n');
  } catch (e) {
    fs.appendFileSync(LOG, `${new Date().toISOString()} monitor error: ${String((e && e.message) || e)}\n`);
  }
  await new Promise((r) => setTimeout(r, 600000));
}
