// cc.mjs — ROVA command-center fleet helper (standalone from the aetheria CC).
// usage:
//   node cc.mjs state                 fleet overview (states, levels, last events)
//   node cc.mjs tor-start             ensure both tor daemons are up (writes torrc skeleton if needed)
//   node cc.mjs tor-check [botId]     prove bot N's circuit end-to-end (exit IP + IsTor verdict)
//   node cc.mjs create N [mode]       create N bots (smoke mode by default) + allocate their Tor ports
//   node cc.mjs start [rampMs]        start all bots with a stagger (default 3000 ms)
//   node cc.mjs stopall               stop the whole fleet
//   node cc.mjs watch                 live fleet line every 15 s
import { torExitProbe } from './server/socks.mjs';
import { portFor, socksUserFor, socksPassFor, daemonFor } from './server/tor-const.mjs';

const BASE = process.env.ROVA_CC_URL || 'http://127.0.0.1:4320';
const api = async (p, m = 'GET', b) => {
  const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return r.json().catch(() => ({}));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cmd = process.argv[2];
const arg1 = process.argv[3];

const rule = '─'.repeat(72);

if (cmd === 'state') {
  const s = await api('/api/state');
  const by = {};
  for (const b of s.bots) { const st = b.runtime?.state || '?'; by[st] = (by[st] || 0) + 1; }
  console.log(`accounts=${(s.accounts || []).length} bots=${(s.bots || []).length} | ${Object.entries(by).map(([k, v]) => `${k}:${v}`).join(' ')}`);
  const t = s.tor?.daemons || {};
  console.log(`tor: D1 ${t[1]?.listening ? 'OK' : 'DOWN'} · D2 ${t[2]?.listening ? 'OK' : 'DOWN'} · bot ports ${s.tor?.info?.ports ?? 0}`);
  for (const b of s.bots) {
    const rt = b.runtime || {}; const st = b.status || {};
    if (rt.state === 'stopped' && !st.exitIp) continue;
    console.log(`  #${b.id} ${b.name} [${rt.state}] mode:${b.mode} port:${st.port ?? '-'} exit:${st.exitIp ?? '-'} isTor:${st.isTor ?? '-'}${rt.restarts ? ' r:' + rt.restarts : ''}${rt.lastExit ? ' exitCode:' + rt.lastExit.code : ''} | ${rt.lastEvt ? rt.lastEvt.evt : ''}`);
  }
} else if (cmd === 'tor-start') {
  const r = await api('/api/tor/start', 'POST');
  console.log(rule);
  console.log(`daemon 1: ${r.d1?.ok ? 'OK' : 'FAIL'} — ${r.d1?.msg} (${r.d1?.port})`);
  console.log(`daemon 2: ${r.d2?.ok ? 'OK' : 'FAIL'} — ${r.d2?.msg} (${r.d2?.port})`);
  console.log(rule);
  if (!r.d1?.ok || !r.d2?.ok) console.log('hint: ROVA_TOR_BIN must point at a tor binary (default: Tor Browser install)');
} else if (cmd === 'tor-check') {
  const id = parseInt(arg1 || '1', 10);
  console.log(`probing bot ${id} circuit — daemon ${daemonFor(id)}, socks 127.0.0.1:${portFor(id)} (auth ${socksUserFor(id)})`);
  try {
    const r = await torExitProbe({ port: portFor(id), user: socksUserFor(id), pass: socksPassFor(id) });
    console.log(`✅ circuit OK — exit IP ${r.ip} · IsTor=${r.isTor} · via ${r.via}`);
  } catch (e) {
    console.log(`❌ circuit probe failed: ${e.message}`);
    console.log('   is the daemon up? run: node cc.mjs tor-start');
    process.exitCode = 1;
  }
} else if (cmd === 'create') {
  const n = parseInt(arg1 || '1', 10);
  const mode = process.argv[4] || 'smoke';
  const r = await api('/api/bots/create', 'POST', { count: n, mode });
  console.log('created:', (r.bots || []).map((b) => `#${b.id} ${b.name}`).join(', '));
} else if (cmd === 'start') {
  const rampMs = parseInt(arg1 || '3000', 10);
  const r = await api('/api/bots/start-all', 'POST', { rampMs });
  console.log('starting:', (r.started || []).length, 'bots (ramp ' + rampMs + 'ms)');
  if ((r.failed || []).length) console.log('failed:', JSON.stringify(r.failed));
} else if (cmd === 'stopall') {
  console.log(await api('/api/bots/stop-all', 'POST'));
} else if (cmd === 'watch') {
  for (;;) {
    const s = await api('/api/state').catch(() => null);
    if (!s) { console.log(new Date().toISOString().slice(11, 19), 'command center unreachable'); }
    else {
      const by = {};
      for (const b of s.bots) { const st = b.runtime?.state || '?'; by[st] = (by[st] || 0) + 1; }
      const ips = new Set(s.bots.map((b) => b.status?.exitIp).filter(Boolean));
      console.log(new Date().toISOString().slice(11, 19), Object.entries(by).map(([k, v]) => `${k}:${v}`).join(' ') || 'no bots', `| distinct exit IPs: ${ips.size}`);
    }
    await sleep(15000);
  }
} else {
  console.log('usage: state | tor-start | tor-check [botId] | create N [mode] | start [rampMs] | stopall | watch');
}
