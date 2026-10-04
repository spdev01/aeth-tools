# aetheria-testbot — headless Aetheria client + test harness

Raw Node client (ws + msgpack) for `www.aetheria-online.in.th`. No browser needed.
See `../LEVELING-RUNBOOK.md` for the full protocol notes, command catalog, and scenario mapping.

## Setup
```
npm install
```

## Run
```
node src/m1-raw.js      # join + character/inventory snapshot + skill catalog dump
node src/m1-act.js      # stat point + inventory round-trip (proves commands)
node src/spike.js       # legacy SDK spike (colyseus.js), kept for reference
```

## Files
- `src/client.js` — the raw client (`AetheriaClient`): REST (auth reuse, chars, world/enter,
  matchmake) + ws session. Decodes `0x0d` msgpack messages, ACKs join, logs everything.
- `src/m1-raw.js` / `src/m1-act.js` — live tests.
- `src/raw-ws-probe.mjs` — dumps raw frames (hex + .bin) for protocol archaeology.
- `out/session.json` — reused guest token (12 h). Guest signup is rate-limited → REUSE.
- `out/skill-catalog.json` — 130 skills (ids/names/thai/maxLevel) captured from live join.
- `out/character-snapshot.json` — full `character` message sample.
- `profiles/novice-to-knight-99.json` — the full-loop scenario as a stage machine.

## Protocol TL;DR
```
POST /auth/guest                       -> {token}
GET  /characters                       -> {nameRules, characters[]}
POST /characters {name}                -> {characterId}
POST /world/enter {characterId}        -> {mapId, ticket, roomId, channel, endpoint}
POST <endpoint>/matchmake/joinById/<roomId> {ticket} -> {name,sessionId,roomId,processId}
ws   <endpoint ws>/<processId>/<roomId>?sessionId=<sid>
   <- 0x0a [token][serializerId="schema"][reflection]   (ACK [0x0a])
   <- 0x0d msgpack(type)+msgpack(data)                   (gameplay events)
   -> 0x0d msgpack(type)+msgpack(data)                   (commands)
```
`room.state` (0x0e/0x0f) is schema-encoded with a server build no published
`@colyseus/schema` can decode — use the msgpack messages instead (they carry
`character`, `inventory`, `skill_catalog`, `chat`, ...).
