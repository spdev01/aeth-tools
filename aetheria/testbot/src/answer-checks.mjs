// Answer checks: (1) pickup proof, (2) guest account credentials
import fs from 'node:fs';
const out = 'e:/GitHub/lumivaraonline/aetheria/testbot/out';

// ---- 1) guest account info from spike logs + session
for (const d of [out, 'e:/GitHub/lumivaraonline/aetheria/out']) {
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d)) {
    if (!f.startsWith('spike-') || !f.endsWith('.jsonl')) continue;
    const first = fs.readFileSync(`${d}/${f}`, 'utf8').split('\n')[0];
    try {
      const e = JSON.parse(first);
      if (e.step === 'auth.guest' && e.json && e.json.guest) {
        console.log(`GUEST LOGIN (${f}):`);
        console.log('  userId :', e.json.guest.userId);
        console.log('  secret :', e.json.guest.secret);
      }
    } catch {}
  }
}
const sess = JSON.parse(fs.readFileSync(`${out}/session.json`, 'utf8'));
const payload = JSON.parse(Buffer.from(sess.token.split('.')[1], 'base64url').toString());
console.log('session.json token payload:', JSON.stringify(payload));

// ---- 2) pickup analysis on the newest run log
const runs = fs.readdirSync(out).filter((f) => f.startsWith('run-') && f.endsWith('.jsonl')).sort();
const latest = runs[runs.length - 1];
const evs = fs.readFileSync(`${out}/${latest}`, 'utf8').trim().split('\n')
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
console.log('\nRUN:', latest, `(${evs.length} events)`);
const gains = evs.filter((e) => e.evt === 'drop' || e.evt === 'message:item_gain');
console.log('item_gain (pickup) events:', gains.length);
const byName = {};
for (const g of gains) { const n = g.data.name || `#${g.data.itemId}`; byName[n] = (byName[n] || 0) + (g.data.qty || 1); }
console.log('picked up totals:', JSON.stringify(byName));
const hbs = evs.filter((e) => e.evt === 'HEARTBEAT');
const h0 = hbs[0]?.data, hN = hbs[hbs.length - 1]?.data;
if (h0 && hN) {
  console.log(`bag: ${h0.bag.used} items / ${h0.bag.weight} wt   ->   ${hN.bag.used} items / ${hN.bag.weight} wt   (delta +${hN.bag.weight - h0.bag.weight} wt)`);
  console.log(`kills total: ${hN.killsTotal}, hits taken: ${hN.hitsInTotal}`);
}
console.log('kill -> drop interleave (last 16):');
for (const s of evs.filter((e) => e.evt === 'kill' || e.evt === 'drop').slice(-16)) {
  console.log(' ', s.t.slice(11, 19), s.evt.padEnd(6), JSON.stringify(s.data));
}

// ---- 3) auth endpoints known to the game client
const c = fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/index-main.js', 'utf8');
const eps = [...new Set([...c.matchAll(/\/auth\/([a-zA-Z0-9\-_]+)/g)].map((m) => m[1]))];
console.log('\nauth endpoints referenced in game bundle:', eps.join(', '));

// ---- 4) item_gain semantics in the game client (pickup vs ground-drop)
const gi = c.indexOf('`item_gain`');
console.log('\nitem_gain handler context:');
if (gi >= 0) console.log(c.substring(gi - 150, gi + 500).replace(/\s+/g, ' '));
for (const m of ['`item_drop`', '`pickup`', 'dropId']) {
  const i = c.indexOf(m);
  console.log(`\n${m} @ ${i}:`);
  if (i >= 0) console.log(c.substring(Math.max(0, i - 200), i + 350).replace(/\s+/g, ' '));
}
