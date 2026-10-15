#!/usr/bin/env bash
# health.sh — one-shot status snapshot for the Aetheria stack (uses node, which is always present).
set -u
node -e '
fetch("http://127.0.0.1:4310/api/state").then(r => r.json()).then(s => {
  const total = s.bots.length;
  const run = s.bots.filter(b => b.state === "running").length;
  const q = (s.collect && s.collect.queue ? s.collect.queue.length : 0);
  const a = (s.collect && s.collect.actives ? s.collect.actives.length : 0);
  const d = (s.tor && s.tor.daemons) || {};
  console.log("bots running: " + run + "/" + total + "   collect queue: " + q + " (actives " + a + ")");
  console.log("tor: daemon1=" + (d["1"] && d["1"].ok ? "OK" : "FAIL") + "  daemon2=" + (d["2"] && d["2"].ok ? "OK" : "FAIL"));
  const by = {};
  for (const b of s.bots) by[b.state] = (by[b.state] || 0) + 1;
  console.log("states: " + Object.entries(by).map(([k, v]) => k + "=" + v).join("  "));
}).catch(e => { console.error("CC not reachable: " + e.message); process.exit(1); });
'
