# ROVA Command Center

Standalone command center for ROVA fleet testing — **same lineage as `aetheria/command-center` but a fully
separate application**: own port (4320), own data directory, own Tor daemons (21000+/22000+ port block).
The aetheria CC is untouched and can run side by side.

## Tor-first rule

**Nothing connects to anything without a proven Tor circuit.**

- Every bot gets its **own SocksPort** (`IsolateSOCKSAuth`, credentials `bot<id>` / `rova<id>`) on one of
  two local tor daemons — odd bot ids → daemon 1, even ids → daemon 2 (halves circuit-build stampedes).
- The **bot manager refuses to start a bot** while its daemon's house port is down.
- The **worker itself never has a direct-connection code path**: on boot it proves its circuit end-to-end
  (exit IP + `IsTor` verdict via check.torproject.org *through Tor*) and retries forever on failure.
- A **watchdog** probes both daemons every 2.5 min and restarts a jammed one after 3 failed probes.

| Component | Where |
|---|---|
| CC server / dashboard | `http://127.0.0.1:4320` |
| Tor daemon 1 (odd ids) | SocksPort `21000+id` · ControlPort 9061 · config `data/tor/torrc` |
| Tor daemon 2 (even ids) | SocksPort `22000+id` · ControlPort 9062 · config `data/tor2/torrc` |
| House circuits (canaries/tools) | SocksPort 21000 / 22000 (no auth) |
| Bot files | `data/bots/<id>/` — `control.json`, `status.json`, `run-*.jsonl`, `worker.log` |
| Accounts/characters/bots | `data/store.json` (atomic writes) |

## Quickstart

```bash
cd rova/command-center
npm install
node cc.mjs tor-start        # bring both tor daemons up (uses Tor Browser's tor.exe by default)
node cc.mjs tor-check 1      # prove bot 1's circuit: exit IP + IsTor verdict
npm start                    # dashboard at http://127.0.0.1:4320
#   → "+ Add bots" then tick the bots and hit "▶ Play selected"
node cc.mjs state            # fleet overview from the CLI
```

## Environment

| Var | Default | Meaning |
|---|---|---|
| `ROVA_CC_PORT` | `4320` | dashboard/API port |
| `ROVA_CC_DATA` | `./data` | data directory (store, bots, tor configs) |
| `ROVA_TOR_BIN` | Tor Browser's tor.exe | path to a tor binary (Debian: `/usr/bin/tor`) |

## Status (barebone)

- [x] Transport-independent CC skeleton: store, bot manager, dashboard, CLI, Tor pool + watchdog
- [x] Per-bot Tor circuits, Tor gates at manager **and** worker level, exit-IP proof in every worker log
- [ ] ROVA game client (auth → `/ws` HELLO → commands) — plug into `server/worker.mjs` at the marked TODO
      (protocol: `rova/protocol/ROVA-PROTOCOL-INVENTORY.md`)
- [ ] Account registration adapter — HTTP auth flow (`/api/auth/*`) to be confirmed on a real environment;
      until then use **import** (`userId:password` lines) or **placeholder** accounts
- [ ] Leveling plan / modes — next up after the client lands

## Notes

- Worker events land in `data/bots/<id>/run-*.jsonl`; the dashboard tails the newest file per bot.
- `worker.mjs` modes: `smoke` (Tor proof + idle) now; `leveling` etc. come with the plan.
- Tor restart = kill listener + respawn with its torrc; exits re-roll (accepted trade-off on a jam).
- Do **not** point any part of this at a live service without authorization — joint rules live in
  `security/rova-security-test-plan.md` (§0): in-range normal-play only; probes on environments you own.
