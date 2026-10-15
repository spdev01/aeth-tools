# Aetheria → Headless Debian — Migration & Operations Guide

Everything the fleet needs lives in the `aetheria/` folder plus two system dependencies (Node 20, Tor).
There is **no database and no external service** — the whole stack is: 1 command-center process + 131 bot
runners + 2 Tor daemons, all self-managed. This guide covers sizing, migration, boot recovery, and day-2 ops.

The repeatable migration path is three commands (Section 4). You can run it as many times as you like —
`deploy.sh` is idempotent and keeps server-side logs and node_modules.

---

## 1. Hardware check — what to measure, and the budget

### Measured on the current Windows host (2026-10-10, full 131-bot fleet live)

| Component | Processes | RAM | CPU (avg) |
|---|---|---|---|
| Bot runners | 131 | **7.6 GB** (~58 MB each) | **~1.6 cores** |
| Tor daemons | 2 | ~110 MB | ~0.6 cores |
| Command Center | 1 | ~95 MB | ~0.07 cores |
| **Stack total** | 134 | **≈ 7.8 GB** | **≈ 2.3 cores** |

Disk: app + state ≈ 250 MB, but bot run logs ≈ **4.8 GB and growing ~1.5–2 GB/day** (needs retention!).
CPU bursts during fleet restarts/collect waves; RAM is flat.

### Verdict thresholds

| | Minimum (works, tight) | Comfortable | Notes |
|---|---|---|---|
| RAM | 8 GB **free** (after everything else on the box) | **16 GB free** (→ 32 GB total if the machine does other jobs) | Fleet ≈ 8 GB. Check `free -h` **available** + swap: if other services already swap, the OOM killer will target your node runners. |
| CPU cores | 2 | **4+** | 16-core desktop here hides burst spikes. |
| Disk | 20 GB free | **40 GB+** | plus log retention (Section 6). |
| Arch | `x86_64` | | Node 20 + colyseus.js need nothing exotic. |
| OS | Debian 11, 12, 13 | | anything systemd-based works. |

### The probe to run on the Debian box

```bash
echo "== cpu ==";   lscpu | grep -E 'Model name|^CPU\(s\)|Socket|Architecture'
echo "== ram ==";   free -h
echo "== mem top =="; ps aux --sort=-%mem | head -12
echo "== disk ==";  df -h / /opt 2>/dev/null
echo "== os ==";    cat /etc/os-release | head -3; uname -m; systemd-detect-virt
echo "== net ==";   timeout 6 curl -sI https://www.aetheria-online.in.th >/dev/null && echo outbound-OK || echo outbound-FAIL
echo "== tools =="; (node -v || echo "node: missing"); (tor --version | head -1 || echo "tor: missing")
```

Send me that output and I'll confirm before you cut over. (`outbound-OK` matters — the fleet lives on
outbound HTTPS + Tor; no inbound ports are needed except the optional dashboard.)

---

## 2. What runs where (and how it self-recovers)

```
systemd (boot)
 ├─ aetheria-tor1.service   tor -f data/tor/torrc    (odd bots, SOCKS 19000+id, ctrl 9051)  Restart=always
 ├─ aetheria-tor2.service   tor -f data/tor2/torrc   (even bots, SOCKS 20000+id, ctrl 9052) Restart=always
 ├─ aetheria-cc.service     node server/index.js     (dashboard :4310, spawns everything below) Restart=always
 │    ├─ spawns 131 × node runner.js   (detached; survive CC restarts; CC re-adopts them)
 │    └─ in-CC tor watchdog            (probes circuits every 150s, restarts a jammed daemon)
 └─ aetheria-fleetup.timer  75s after boot, then every 5 min
      └─ fleet-up.sh → POST /api/bots/start-all
           starts every bot whose persisted intent is wantRun=true — i.e. anything you didn't
           deliberately Stop in the dashboard. Stopped bots stay stopped across reboots.
```

**Power-cycle recovery = boot → systemd starts tor + CC → fleetup starts the fleet (~75 s) → the CC's own
watchdogs (stall, orphan, tor) keep it healthy 24/7.** No manual intervention.

---

## 3. Server one-time prep

Nothing to do manually — `deploy.sh --bootstrap` (Section 4) installs Node 20 (NodeSource) + tor + rsync
and creates the `aetheria` service user. Optional hardening:

```bash
# dashboard stays localhost-only by default. For LAN access instead:
#   sudo systemctl edit aetheria-cc   → set Environment=AETHERIA_HOST=0.0.0.0
#   sudo ufw allow from 192.168.1.0/24 to any port 4310 proto tcp     (adjust subnet)
```

---

## 4. Migration (repeatable — this is also your update path)

### On Windows

```powershell
powershell -ExecutionPolicy Bypass -File E:\GitHub\lumivaraonline\aetheria\migrate\export.ps1
```

This **stops CC + all runners + tor** (run intent stays persisted), then packs `aetheria-transfer.tar.gz`
(~200–400 MB; excludes node_modules, logs, and the ~5 GB of run logs). Do not start the stack on Windows
again after the final export — one live instance per account, always.

### Ship it

```powershell
scp E:\GitHub\lumivaraonline\aetheria\migrate\out\aetheria-transfer.tar.gz aetheria@<SERVER-IP>:~/
```

### On the server

```bash
ssh aetheria@<SERVER-IP>
mkdir -p /tmp/aetheria-init && tar -xzf ~/aetheria-transfer.tar.gz -C /tmp/aetheria-init
sudo bash /tmp/aetheria-init/migrate/deploy.sh ~/aetheria-transfer.tar.gz --bootstrap
```

First run = bootstrap + install + start (fleet ramps up over ~5 min, 2.5 s per bot). Later runs = push the
current checkout state over the top (idempotent; keeps node_modules + server logs) and restart everything.

### Verify

```bash
sudo bash /opt/aetheria/migrate/health.sh     # bots running: N/131 · tor: OK/OK · states breakdown
curl -s http://127.0.0.1:4310/api/meta
```

---

## 5. Cutover-night checklist

1. `export.ps1` on Windows (stack stops; confirm "done: … (NN MB)").
2. `scp` the archive to the server.
3. `deploy.sh --bootstrap` on the server.
4. `health.sh` → expect `tor: OK OK`, bots ramping to `running`.
5. Dashboard: `ssh -L 4310:127.0.0.1:4310 aetheria@<SERVER-IP>` → open http://127.0.0.1:4310.
6. Watch the first collect wave + one death-recovery cycle (should see `via:"warp"` legs).
7. Leave the Windows stack stopped. Keep the archive as your rollback (re-deploy = reverse: run
   export from a Windows copy if ever needed — the archive alone can rebuild the server stack).

---

## 6. Day-2 operations

```bash
systemctl status aetheria-cc aetheria-tor1 aetheria-tor2 aetheria-fleetup.timer
journalctl -u aetheria-cc -f            # CC log
journalctl -u aetheria-tor1 -f          # tor 1
sudo systemctl restart aetheria-cc      # safe: runners are detached and re-adopted
bash /opt/aetheria/migrate/health.sh    # one-shot snapshot
```

- **Start/stop the fleet**: dashboard buttons, or `curl -X POST localhost:4310/api/bots/stop-all` and
  `curl -X POST localhost:4310/api/bots/start-all -H 'Content-Type: application/json' -d '{"rampMs":2500}'`.
  Anything you Stop intentionally (wantRun=false) will NOT come back after a reboot; Play flips it back.
- **Updates**: repeat Section 4 (export → scp → deploy). Deploy keeps server logs and node_modules.
- **Log retention** (do this — 1.5–2 GB/day otherwise):

```bash
# keep bot run logs to the last 3 days; add via: sudo crontab -e
15 5 * * * find /opt/aetheria/command-center/data/bots -name 'run-*.jsonl' -mtime +2 -delete
```

- **Disk/watchdog sanity**: `df -h /opt`; `systemctl list-timers aetheria-fleetup.timer`.

---

## 7. Troubleshooting

| Symptom | Look at | Likely fix |
|---|---|---|
| `health.sh`: CC not reachable | `journalctl -u aetheria-cc -n 80` | Start order is handled by systemd; check `Environment=AETHERIA_TOR_BIN` points at real tor (`which tor`). |
| tor FAIL / no circuits | `journalctl -u aetheria-tor1 -n 50` | First boot: give it 30–60 s to bootstrap. Check torrc has `SocksPort` lines (regenerated by CC from `bot-ports.extra`). |
| Bots restart-looping | `journalctl -u aetheria-cc -f` + a bot's `worker.log` | Usually transient game/proxy issues; the CC backoff handles it. |
| Bots all `stopped` after reboot | `health.sh`, then dashboard | `wantRun` was cleared (someone pressed Stop-all before export). Press Play / start-all once. |
| Dashboard unreachable from PC | `ss -ltn | grep 4310` | Default bind is 127.0.0.1 — use the SSH tunnel (Section 5) or set `AETHERIA_HOST=0.0.0.0` + firewall. |
| Sessions dead / mass relogin | bot `worker.log` | Tokens ride in `data/`; some relogins after an IP change is normal, bots handle it. |
| Tor exit IPs changed | dashboard `exitIp` column | Expected on a new host. |

---

## 8. Security notes

- `command-center/data/store.json` holds **account credentials + session tokens**; `auth_config.json` too.
  `deploy.sh` sets them to `600 aetheria:aetheria`. Keep them off any share, and don't commit the archive.
- SSH-only access; no inbound ports required for the fleet itself (game + Tor are outbound).
- Optional dashboard-over-LAN: restrict with `ufw` to your subnet (Section 3).

---

## 9. Files in this kit

| File | Runs on | Purpose |
|---|---|---|
| `migrate/export.ps1` | Windows | Stop stack cleanly + build `aetheria-transfer.tar.gz` |
| `migrate/deploy.sh` | Debian (sudo) | Bootstrap, install/update, torrc path fix, systemd, start |
| `migrate/fleet-up.sh` | Debian | `start-all` pass (boot recovery + 5-min self-heal) |
| `migrate/health.sh` | Debian | One-shot status snapshot |
| `migrate/systemd/*.service`, `.timer` | Debian | tor1, tor2, cc, fleetup (auto recovery) |

Runtime code is already portable: `AETHERIA_TOR_BIN` / `AETHERIA_HOST` envs, `ss` fallback for the tor
watchdog, and the new `POST /api/bots/start-all` (intent-respecting) endpoint.
