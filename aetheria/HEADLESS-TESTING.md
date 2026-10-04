# Aetheria — Headless Testing Guide (for mass, N-client audits)

Everything here is **headless**: no browser, no clicks — pure REST + WebSocket room messages.
Companion docs: `METHODOLOGY.md` (how the protocol was decoded), `EVIDENCE-frames.md` (raw captures), `STORAGE-INVENTORY.md`.

---

## 1. Architecture recap

| Layer | What | Where |
|---|---|---|
| REST | auth, characters, world-enter, static data | `https://www.aetheria-online.in.th` |
| WebSocket | **ALL gameplay** (move/combat/npc/shop/storage/chat) | `wss://g{2,4,5}.aetheria-online.in.th/<roomId>/<processId>?sessionId=…` (Colyseus) |
| Envelope | `[0x0d] + msgpack(type) + msgpack(data)`; 0x0a join, 0x0c ping, 0x0e/0x0f state | server accepts standard msgpack |
| Map travel | server sends `travel {mapId, displayName, endpoint?, roomId, ticket}` → client **leaves room and re-joins the new one with the ticket** | verified in client code + observed frames |

⚠️ **Guest sessions rotate every few minutes** (client auto-reloads, new sessionId, possibly new host/channel). Long-running bots MUST handle re-join. For stable N-bot runs prefer upgraded (registered) accounts.

## 2. Setup (Node)

```bash
npm i colyseus.js
# Node < 22: polyfill WebSocket ->  globalThis.WebSocket = (await import('ws')).WebSocket;
```

## 3. Connect flow (verified contract)

```js
import { Client } from 'colyseus.js';
const BASE = 'https://www.aetheria-online.in.th';
const H = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

// 1) login (guest; or /auth/upgrade*, /auth/google with your own flow)
const auth = await (await fetch(`${BASE}/auth/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
const token = auth.token ?? auth.jwt;                     // verify field once
// 2) character list / create
const chars = await (await fetch(`${BASE}/characters`, { headers: H(token) })).json();
const characterId = (chars.characters ?? chars)[0].id;
// 3) enter world -> { endpoint?, roomId, ticket }
const enter = await (await fetch(`${BASE}/world/enter`, { method: 'POST', headers: H(token), body: JSON.stringify({ characterId }) })).json();
// 4) join the room
const client = new Client(enter.endpoint || 'wss://g2.aetheria-online.in.th');
const room = await client.joinById(enter.roomId, { ticket: enter.ticket, batch: true });
room.onMessage('*', (type, msg) => console.log('RECV', type, msg));
const send = (type, data) => room.send(type, data);
```

Then all actions below are `send('message', payload)`.

## 4. Action recipes

### 4.1 Movement (verified live)
```js
send('move_to', { x: 1808, y: 1584 });   // absolute px; tile center = (tile+0.5)*32
send('move', { dx: 0, dy: -8 });         // walk-intent (any magnitude≈5 t/s, {0,0} stops)
```
- Server simulates the walk; `move_to` clamps & walks (no teleport). `arrived` is ignored by the server. Walls bound movement.

### 4.2 Channels (verified)
```js
send('channel_switch', { channel: 5 });  // whitelist + ~10s cooldown; rejects silently with a Thai system chat text
send('channel_list', {});               // recv 'channels'
```

### 4.3 Chat (verified)
```js
send('chat', { channel: 'world', text: 'hi' });            // channels: world/local/party/guild/whisper(+to)
```
- Rendered escaped; no HTML injection. System errors arrive as `chat` messages — **always log chat frames**, they are the de-facto error channel.

### 4.4 NPC talk / dialogs (verified live)
```js
send('npc_talk', { npcKey: 'n6' });      // recv 'npc_dialog' {npcKey,name,art,text,options:[...]}
send('npc_option', { index: 2 });        // 0-BASED array index of options[]
send('npc_close', {});
```
- **Proximity-gated**: must stand near the NPC (a few tiles). Too far = total silence.
- Response latency observed 0.25–2s (sometimes slower): never assume failure before ~3s; retry loops should re-talk.
- Capital NPC keys (from join state; partial live-verified): `n4`=Armorer Hilda (shop), `n6`=Alice Service (kafra), `n11`=Phoenix Egg Lucky, `n12`=Auger Socket. Full list n1..n12 = NPC list order in the initial room state.

### 4.5 Storage — open, store, retrieve (ALL verified live, fully headless)
```js
send('npc_talk', { npcKey: 'n6' });      // Alice (fountain); dialog options:
// [0] save point  [1] warp  [2] OPEN STORAGE (40z)  [3] heal  [4] reset stats  [5] reset skills  [6] close
send('npc_option', { index: 2 });        // -> recv 'storage' {slots:300, feeZeny, items[..], zeny}
send('storage_put',   { slot: BAG_SLOT,     qty: N });   // bag -> storage
send('storage_take',  { slot: STORAGE_SLOT, qty: N });   // storage -> bag
send('storage_move',  { from: STORAGE_SLOT, to: STORAGE_SLOT });
```
- Fee ~40z per open; `storage.zeny` = your balance in the same frame.
- Server pushes fresh `storage` + `inventory` after every mutation. Re-read slots every time.

### 4.6 Selling — "sell everything except my protect list" (verified live)
Full bag→Zeny pipeline:

```js
const SELL_PRICE_GUARD = (item) => item.sellPrice > 0;   // price-0 items are refused by the server
const PROTECT = new Set([90305, 90104]);                  // itemIds you DON'T want sold

send('inv_sort', {});                                     // trigger fresh 'inventory'
// on 'inventory' msg: items = msg.items.filter(i => !PROTECT.has(i.itemId) && SELL_PRICE_GUARD(i));
// open a vendor (Armorer Hilda, near fountain; her dialog confirmed shop-type):
send('npc_talk', { npcKey: 'n4' });                       // options: ["ซื้อชุดเกราะและเครื่องประดับ","ไว้ก่อน"]
send('npc_option', { index: 0 });                         // opens the shop context
// sell (single):
send('shop_sell', { slot: item.slot, qty: item.qty });
// or bulk (one message, multiple lines):
send('shop_sell_many', { lines: [ { slot: 0, qty: 1 }, ... ] });
```
Verified live: `shop_sell {slot:0,qty:1}` → Carrot 4→3; `shop_sell_many {lines:[{slot:0,qty:1}]}` → 3→2; Zeny 420→434 (+7 per Carrot = `sellPrice`). 
Notes:
- Slot numbers come from `inventory.items[].slot`; **re-read after every sell batch** (layout can shift).
- Selling without a vendor dialog open did NOT go through in our test → keep the "approach vendor → talk → option" step in bot flows.
- Buying (inverse): `shop_buy {itemId, qty}` / `shop_buy_many {lines}` (catalogued; same shop context).

### 4.7 Warping via Alice (mechanism fully mapped; live step intermittent)
```js
// 1. talk to Alice (within a few tiles of the fountain)
send('npc_talk', { npcKey: 'n6' });
// 2. pick "วาร์ป (เลือกจากแผนที่โลก)"
send('npc_option', { index: 1 });        // -> recv 'warp_menu'
// warp_menu = { destinations: [mapId, ...], costs: { mapId: zenyCost, ... } }   (client code + one live capture)
// 3. warp to a destination (client refuses if zeny < costs[mapId]):
send('npc_warp', { mapId: 'novice_garden' });   // use EXACT id from warp_menu.destinations
// 4. server replies:
// travel = { mapId, displayName, endpoint?, roomId, ticket }
// 5. bot = leave current room, then:
const next = await client.joinById(travel.roomId, { ticket: travel.ticket, batch: true });
//    (same Client/endpoint; this is exactly what the game client does — verified in its code)
```
Status & caveats:
- The menu→travel chain is confirmed: client code reads `warpMenu.destinations/costs`, sends `npc_warp {mapId}` and re-joins via the `travel` ticket; a live `travel {mapId,ticket}` frame was observed in recv logs.
- **`warp_menu` responded only intermittently** to automated option presses (arrived in 1 of ~6 attempts; server latency 0.2–15s observed on other ops too). Bots MUST retry: `npc_close` → re-talk → re-option, with backoff; consider pacing ≥2s between dialog steps.
- Warp costs zeny (`costs` map); insufficient balance = refusal (client disables the button). Keep a zeny buffer in bot accounts.
- Destination ids come from `/world/atlas` (e.g., `novice_garden`, `frost_pass`, `capital`).
- **Destinations unlock by EXPLORING** — `warp_menu.destinations` lists only maps the character has visited (walk there once); the minimap shows quick-warp chips for visited maps.

### 4.8 Inventory listing (verified)
```js
send('inv_sort', {});   // any inventory change also pushes 'inventory'
// inventory = { slots, weight, weightLimit, items:[{slot,itemId,name,type,weight,sellPrice,effects[],autoPotion,qty,maxStack,usable,destroyable}] }
```

### 4.9 Other catalogued actions (not yet live-verified at Lv1)
| Action | Send | Notes |
|---|---|---|
| Pickup | `pickup {dropId}` | dropIds from state/drop entities; needs drops on ground |
| Combat | `target {targetId}`, `cast {skillId,targetId,x,y}`, `skill_up`, `auto_set` | class/skill gated; ids from state |
| Respawn | `respawn {to}` | dead-only; destination validated server-side |
| Market (player trade) | `market {op:'history'/'trades'/...}` (+`market_open` to open via Auctioneer n7) | ops catalogued; needs market context |
| Party/friends/guild/mail | `party`, `friend`, `guild`, `mail` | context-dependent |
| Gacha/refine/enchant/socket | `gacha_roll {count}`, `refine {source,blessing}`, ... | session-gated; avoid negative counts |

### 4.10 Auto-combat — on/off (server command verified)
```js
send('auto_set', { enabled: true });    // turn ON  (client: Z key / AUTO button)
send('auto_set', { enabled: false });   // turn OFF
```
- **Safe-zone gate (verified live)**: enabling inside the capital is refused — server replies via system chat: `ต่อสู้อัตโนมัติใช้ได้เฉพาะนอกเมือง` ("auto-combat is available only outside the city"). Bots must walk to a hunting map first.
- While ON: hunts monsters around the activation point (anchor), path-walks around obstacles, attacks with the configured skill rotation, loots / uses potions per settings.
- Auto **stops on: death / map change / weight > 90%** (client UI text). State lives in `character.auto` (`enabled`, `config`, `anchor`).

### 4.11 Auto-combat settings — incl. whole-map mode (ทั้งแมพ)
Config updates go through the same message, sending the full merged config object:
```js
send('auto_set', { config: { ...currentConfig, huntRadiusTiles: 'all' } });    // WHOLE MAP mode
send('auto_set', { config: { ...currentConfig, huntRadiusTiles: 12 } });       // radius mode (tiles)
send('auto_set', { config: { ...currentConfig, monsters: ['<monsterKey>'] } }); // chosen monsters ([] = ALL types)
send('auto_set', { config: { ...currentConfig, flyWing: true } });             // use Fly Wing to relocate
send('auto_set', { config: { ...currentConfig, pickupLoot: true } });          // auto-loot
send('auto_set', { config: { ...currentConfig, skills: ['<skillId>', ...] } }); // rotation (ordered, max 9)
```
- Client code (verified): `setAuto({ config: { ...m, ...patch } })` where `m = character.auto.config`.
- `huntRadiusTiles = 'all'` = whole map (special-cased in the client: no radius circle drawn).
- Known config keys: `huntRadiusTiles`, `monsters[]`, `flyWing`, `pickupLoot`, `skills[]` (max 9, ordered; use skills flagged `autoUse` from `skill_catalog`), `buffItems[]`, potion settings (ยา/บัพ tab).
- Read current values from `character.auto.config`.

### 4.12 Status point allocation (VERIFIED LIVE)
```js
send('stat_preview', { add: { STR: 1 } });   // -> recv 'stat_preview' = computed stats preview
send('stat_up', { stat: 'STR', n: 1 });      // COMMIT -> recv updated 'character'
```
- **Stat keys are UPPERCASE**: `STR AGI VIT INT DEX LUK` — lowercase keys are silently ignored (gotcha we hit).
- Cost per point comes from `character.statCosts` (our +1 STR consumed 2 points: badge 48 -> 46).
- Free points monitor: `character.statusPoints`.

### 4.13 Skill point allocation
```js
// full skill lists arrive at join: recv 'skill_catalog' ({classes:[{id,name,thai,tier,previous,...}]})
send('skill_up', { skillId: '<skillId>' });   // +1 per call (client skill-tree "+" button)
```
- Skill availability/unlock levels are server-driven; novice has no allocatable tree (class change first).

### 4.14 Job change via Valkyrie (VERIFIED LIVE — flow + gate)
```js
send('npc_talk',   { npcKey: 'n5' });   // Valkyrie — capital tile (52,30)
send('npc_option', { index: 0 });       // "ข้าพร้อมเปลี่ยนอาชีพแล้ว" (ready to change class)
// Not eligible (observed): server updates the dialog text to:
//   "ยังเร็วไป กลับมาเมื่อถึง Job Lv.10 และ Basic Skill Lv.9"
//   => requirement: JOB LV.10 + BASIC SKILL LV.9
// When eligible: character.jobChangeOptions becomes non-empty -> class-selection flow.
```

### 4.15 Full character monitoring (headless)
| Value | Source |
|---|---|
| HP / SP / maxHp / maxSp / dead | local player entity in `room.state` (SDK-decoded schema: `hp`, `sp`, `maxHp`, `maxSp`, `dead`, ...) |
| Base/Job level, class, EXP | `character` recv: `baseLevel, jobLevel, jobMaxLevel, baseExp, baseExpNext, jobExp, jobExpNext, classId, className` |
| Free status points | `character.statusPoints` |
| Free skill points | `character.skillPoints` |
| Weight / limit | `inventory` recv: `weight`, `weightLimit` (client warns >=70%; auto-combat stops >90%) |
| Free backpack slots | `inventory`: `slots - items.length` |
| Stats + derived (atk, matk, def, hit, flee, crit, aspd, maxHp, maxSp, regen, %) | `character.stats / bonusStats / statCosts / derived` — or on-demand via `stat_preview {add:{}}` |
| Auto-combat state | `character.auto` (`enabled`, `config`, `anchor`) |
| Zeny | `character` store; `storage.zeny` when storage open (verified: 460 -> 434 = fee 40 + 2 sales x7) |
- Server pushes `character`/`inventory` on every change; forced refresh: `inv_sort {}` (side effect: sorts the bag).

### 4.16 Capital NPC directory (key -> NPC -> tile coords, decoded from the join state)
| key | NPC | tile (x,y) |
|---|---|---|
| n1 | Healer Mira | 71.5, 36.5 |
| n2 | Shopkeeper Bor | 27.5, 47.5 |
| n3 | Blacksmith Enok | 77.5, 48.5 |
| n4 | Armorer Hilda — shop | 74.5, 48.5 |
| n5 | Valkyrie — job change | 52, 30 |
| n6 | Alice Service — kafra (storage/warp/heal) | 56.5, 50.5 ✓ live-verified |
| n11 | Phoenix Egg Lucky (event) | 59, 66 |
- Navigate: `move_to { x: tile_x*32+16, y: tile_y*32+16 }` then `npc_talk`.
- State encoding per NPC: `[81 nameStr][82 artStr][83 ""][84 ""][85 u16 x][86 u16 y]` (pixels = tile x 32) — same pattern in every map's join state.

## 5. Mass-testing architecture (N simultaneous clients)

1. **Accounts**: one account+character per bot. Upgraded accounts are strongly recommended (guest sessions rotate every few minutes → your bot must auto re-login; upgraded accounts keep credentials).
2. **Process layout**: 1 Node process per 3–5 bots (each bot = Client+Room+socket). An orchestrator dispatches scenarios and collects logs.
3. **Event-driven, not timer-driven**: because failures are SILENT, every scenario step needs an assertion (position, inventory count, zeny, channel, map) with timeout; use `room.onMessage`/state to resolve conditions. Never "fire and pray".
4. **Pacing**: ≥250ms between actions per bot; dialog steps ≥2s apart (observed server latencies up to ~15s on rare ops like warp_menu). Retries with exponential backoff; distinguish "slow" from "refused" via state checks.
5. **Session-rotation handler** (all bots): on socket close/reload → re-run login (or token refresh) + `/world/enter` + join; resume scenario from last verified checkpoint.
6. **Audit logging**: dump every frame (type + json) to per-bot log files; the audit value comes from reconstructing server behavior post-hoc.
7. **Negative tests** (the actual audit): scenarios assert state UNCHANGED for invalid inputs (e.g., try `npc_warp` to a locked map, `storage_put` out-of-range slot, `shop_sell` qty>have, `channel_switch` invalid) — silent no-op = pass.

## 6. Observed server quirks (budget for them in scripts)

| Quirk | Consequence |
|---|---|
| Silent rejections (no error message) | assert via state, log chat frames (some errors DO appear as chat) |
| Response latency spikes (0.2–15s) | generous timeouts + retries |
| Warp menu intermittent | retry loop + backoff |
| Guest session rotation (minutes) | re-join handler; prefer upgraded accounts |
| Proximity gates (`npc_talk`) | walk near NPC before talking |
| Context gates (shops/market/storage) | open via the right NPC dialog first |
| Zone/level gates (warp destinations, skills) | read gates from server responses, don't hardcode assumptions |
| **Safe-zone gate: auto-combat** | `auto_set {enabled:true}` is refused inside cities — server replies via system chat ("ใช้ได้เฉพาะนอกเมือง"); enable only in hunting maps |
| Auto-combat self-stop rules | stops on death / map change / weight > 90% (client UI text) |
| Warp destinations unlock by visiting | `warp_menu.destinations` = visited maps only; per-map zeny `costs` gate each warp |

## 7. Safety rules (carry over from the audit)

- Authorized testing only; prefer staging when available; keep N small and polite on live.
- No malformed-msgpack (decoder-throw) fuzzing on live rooms; no negative counts on loop-prone fields (`gacha_roll`, `*_many` lists).
- Stop-on-anomaly: if a bot ever gains unexpected state (items/zeny), halt the whole run and capture evidence.

## 8. Reference

- Message catalogue (58 send / 71 recv): `AETHERIA-AUDIT.md` + `list_msgs.ps1`.
- Payload shapes and context extracts: `ctx_*.ps1` scripts + `EVIDENCE-frames.md`.
- Storage/inventory detail: `STORAGE-INVENTORY.md`.
