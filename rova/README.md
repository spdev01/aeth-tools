# rova/ — ROVA ONLINE tooling

Work in progress: headless protocol tooling for ROVA (same lineage as the aetheria testbot).

## Layout

- `protocol/` — the extracted protocol:
  - `ROVA-PROTOCOL-INVENTORY.md` — the complete command/capability inventory (149 client commands, 39 events, RO_NPC act catalog, payloads, handshake, build plan).
  - `opcodes.mjs` / `opcodes.json` — machine-readable opcode tables (`OP` client→server, `EV` server→client, `MOD` module gateways).
- `tools/` — extraction scanners (`proto-scan*.mjs`) run against the public client bundles.
- `recon/proto/` — raw extraction artifacts (enum sweeps, call-sites, verbs, handshake context).
- `../rova-wiki/` — standalone drop-EV wiki tool (monster EV from drop chance × NPC sell price,
  category toggles, item/map browsers). `cd rova-wiki && node tools/serve.mjs` → http://127.0.0.1:4321.
  Data pipeline rides the same Tor rules (`rova-wiki/tools/fetch-all.mjs` → `tor-net.mjs`).

## Status

- [x] Transport/handshake documented (WS + msgpack `[op,seq,data]`, HELLO/PING/WELCOME, device token `dv`)
- [x] Full client command set + server events + RO_NPC act sub-protocol
- [x] Headless client (HTTP auth → character → WS HELLO → world entry) — live-verified 2026-10-16 through Tor; see `protocol/AUTH-HANDSHAKE.md`
- [ ] Command layer (MOVE/ATTACK/INTERACT/AUTO_SET) + leveling loop — next
- [ ] Range/proximity probes (S1 suite) — on a test environment

## Tor-only invariant (enforced)

Every outbound connection that touches the game service rides a Tor SOCKS circuit — including account
registration and asset/protocol probing. There is no direct-connection code path anywhere in this tree:

- bot workers → per-bot isolated circuits (circuit proven: exit IP + IsTor, before any use)
- HTTP (auth, registration, characters, probes) → `command-center/server/rova-http.mjs` (TLS-over-SOCKS, no fallback)
- game websocket → `command-center/server/rova-client.mjs` (socks-proxy-agent)
- recon/tooling fetches → `tools/tor-net.mjs` (used by the scanners)

Audit it: `node tools/audit-tor-only.mjs` — exits 1 on any loopback-external direct call (fetch/WS/net/tls/axios...), covering this tree plus `../rova-wiki/`.

Testing policy: commands run in-range on the live beta = normal gameplay; all out-of-range / replay / forged-context probes are executed against an environment we operate (staging), per `../security/rova-security-test-plan.md`.
