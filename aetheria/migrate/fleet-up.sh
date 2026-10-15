#!/usr/bin/env bash
# fleet-up.sh — boot / power-cycle recovery pass: wait for the command center, then ask it to start every
# bot whose persisted intent is "running" (wantRun=true). Intentionally-stopped bots stay down.
# Safe to run repeatedly — the server's aetheria-fleetup.timer calls it right after boot, then every 5 min.
set -u
URL='http://127.0.0.1:4310'
for i in $(seq 1 60); do
  if curl -fsS -m 3 "$URL/api/meta" >/dev/null 2>&1; then break; fi
  sleep 2
done
if ! curl -fsS -m 3 "$URL/api/meta" >/dev/null 2>&1; then
  echo "fleet-up: command center not reachable yet — skipped (timer retries)"
  exit 0
fi
out="$(curl -fsS -m 30 -X POST "$URL/api/bots/start-all" -H 'Content-Type: application/json' -d '{"rampMs":2500}' 2>&1)" || {
  echo "fleet-up: start-all failed: $out"
  exit 1
}
count="$(echo "$out" | sed -n 's/.*"count":\([0-9]*\).*/\1/p')"
echo "fleet-up: start-all queued ${count:-?} bot(s)"
