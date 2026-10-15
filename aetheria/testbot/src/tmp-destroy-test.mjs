// tmp-destroy-test.mjs — live verification of inv_destroy {slot, qty}: discard one junk item, confirm it's gone.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AetheriaClient } from './client.js';

const BASE = 'https://www.aetheria-online.in.th';
const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (...a) => console.log('[RESULT]', ...a);
const jpost = async (p, body = {}, token = null) => {
  const res = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const jget = async (p, token) => {
  const res = await fetch(BASE + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

let client = null;
try {
  const s = JSON.parse(fs.readFileSync(path.join(here, '..', 'out', 'pull2-account.json'), 'utf8'));
  const lo = await jpost('/auth/login', { userId: s.userId, password: s.password });
  if (lo.status !== 200 || !lo.json.token) throw new Error('login failed');
  const acct = { token: lo.json.token };
  const list = await jget('/characters', acct.token);
  const chars = Array.isArray(list.json) ? list.json : (list.json?.characters ?? []);
  const chr = { name: chars[0]?.name, characterId: chars[0]?.characterId };

  client = new AetheriaClient({ token: acct.token });
  await client.connect(chr.characterId);
  await sleep(4000);
  if (client.mapId === 'jail') { R('FATAL', 'jailed'); throw new Error('jail'); }

  const inv = () => client.msgs.get('inventory')?.data?.items ?? [];
  const carrot = inv().find((x) => /carrot/i.test(x.name ?? ''));
  if (!carrot) { R('destroy_test', 'SKIP — no carrot in bag'); throw new Error('no item'); }
  R('before', `carrot slot=${carrot.slot} qty=${carrot.qty}`);
  client.send('inv_destroy', { slot: carrot.slot, qty: 1 });
  await sleep(2500);
  const after = inv().find((x) => /carrot/i.test(x.name ?? ''));
  R('destroy_test', `carrot qty ${carrot.qty} -> ${after ? after.qty : 0} => ${(!after || after.qty < carrot.qty) ? '✅ inv_destroy ACCEPTED (item discarded)' : '❌ ignored'}`);
} catch (e) {
  R('FATAL', String((e && e.message) || e).slice(0, 200));
} finally {
  try { await client?.leaveGraceful(400); } catch {}
  try { client?.close(); } catch {}
}
process.exit(0);
