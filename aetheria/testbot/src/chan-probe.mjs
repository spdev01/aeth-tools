// Channel-switch probe: logs in as a spare account, tries channel_switch, logs every related message.
// Usage: $env:P_USER='...'; $env:P_PASS='...'; node src/chan-probe.mjs
import { AetheriaClient } from './client.js';

const user = process.env.P_USER, pass = process.env.P_PASS;
if (!user || !pass) { console.log('need P_USER/P_PASS'); process.exit(1); }

const login = await (await fetch('https://www.aetheria-online.in.th/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId: user, password: pass }),
})).json();
if (!login.token) { console.log('login failed:', JSON.stringify(login)); process.exit(1); }

const c = new AetheriaClient({ token: login.token });
const cl = await c.listCharacters();
const ch = cl.characters?.[0];
if (!ch) { console.log('no characters'); process.exit(1); }
console.log('char:', ch.name, '| last map:', ch.mapName);

await c.connect(ch.characterId);
await c.waitJoin(12000);
c.arrived();
await new Promise((r) => setTimeout(r, 2500));
console.log('joined, map =', c.mapId);

c.on('message', (type, data) => {
  const t = String(type);
  if (['channels', 'alert', 'notice', 'server_notice', 'travel', 'force_logout', 'center_notice', 'character'].includes(t)) {
    console.log('MSG', t, JSON.stringify(data).slice(0, 500));
  }
});
c.on('close', (code, reason) => console.log('CLOSE', code, reason));
c.on('error', (e) => console.log('ERR', JSON.stringify(e).slice(0, 300)));

const snap = async (label) => {
  c.channelList();
  await new Promise((r) => setTimeout(r, 3500));
  const m = c.msgs.get('channels');
  console.log(label, '-> current =', m?.data?.current, '| cooldown =', m?.data?.cooldownUntil, '| count =', m?.data?.channels?.length);
};

await snap('initial');
const target = 2;
console.log('--- channel_switch to', target, '---');
c.channelSwitch(target);
await new Promise((r) => setTimeout(r, 5000));
await snap('after switch#1 (5s)');
console.log('--- channel_switch to 3 ---');
c.channelSwitch(3);
await new Promise((r) => setTimeout(r, 8000));
await snap('after switch#2 (8s)');

try { await c.leaveGraceful(600); } catch {}
try { c.close(); } catch {}
process.exit(0);
