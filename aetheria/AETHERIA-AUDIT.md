# Aetheria Online — Passive Audit Report (Phase 1)
Target: https://www.aetheria-online.in.th/play · Date: 2026-10-04 · Status: PASSIVE ONLY (no account created, no crafted messages sent)
Artifacts: this folder (bundle, css, public JSONs, scans)

## 1. Tech stack (verified from served assets)
- **Frontend:** Vite build, **React 19.3.0** SPA; **Phaser** for game rendering (Scenes: world scene + FX lab; `new Phaser.Game` with `Scale.NONE`, canvas appended to `#root`).
- **Networking:** **Colyseus SDK 0.18** — schema-based state sync (`FieldState` with monsters/npcs/drops/traps maps), **MessagePack** (`useRecords:false, mapsAsObjects:true`), latency-based multi-endpoint selection, optional `@colyseus/h3-transport` (WebTransport) support; WS URL derived from `window.location` (dev default in bundle: `ws://127.0.0.1:2567`), proxy path `/.proxy/colyseus` supported by SDK.
- **Auth:** username/password + **Google Sign-In** (GSI client_id `449758426110-…apps.googleusercontent.com`, public by design) + **Guest** (`allowGuest:true` via `/auth/config`). JWT **Bearer** tokens (`/auth/guest`, `/auth/upgrade`, `/auth/upgrade-google`); token payload carries `guest` flag.
- **Hosting:** frontend served with Deno-Deploy-style static headers (no `Server`, h3 alt-svc, `etag "dlvelja1o64gu7"`); game server is a separate Colyseus (Node.js) deployment (endpoint chosen via latency: `/matchmake/...`).
- **Debug artifact in prod bundle:** `window.__fxlab` handle exposed by the FX-lab component.
- Site self-describes as built "100% with AI agents (Claude & Codex)"; open beta ~2.2k online.

## 2. Public (unauthenticated) endpoints observed
- `GET /auth/config` → `{"googleClientId":…,"allowGuest":true}`
- `GET /world/atlas` → map graph (map ids, links, gddRevision) — 116 KB
- `GET /world/events`, `GET /patch-notes` (80 KB), `GET /audio/manifest.json`, `/art/...` assets
- `POST /auth/guest {}` · `POST /auth/upgrade`, `/auth/upgrade-google` (Bearer) · `POST /world/enter` (Bearer) · `GET /characters` (Bearer)
- Colyseus matchmaking: `joinOrCreate|create|join|joinById` over HTTP+WS (room name set at runtime; per-endpoint latency probing)

## 3. Room protocol catalog (from client bundle)
**client→server (~60):** `move{dx,dy}` · `move_to{x,y}` (client snaps to 32px grid, ≥120ms & ≥16px apart) · `arrived` · `guide_skip` · `npc_talk{npcKey}` · `npc_option{index}` · `npc_warp{mapId}` · `npc_close` · `channel_switch{channel}` (UI disables full channels only) · `chat` · `cast{skillId,targetId,x,y}` · `skill_up{skillId}` · `skill_facet` · `stat_up{stat,n}` (UI batches; n from client) · `stat_preview` · `respawn{to}` · `target{targetId}` · `arena` · `auto_set` · `hotbar_set`, `itembar_set` · `equip{slot}`, `unequip{slot,to}` · `inv_use{slot}`, `inv_move{from,to}`, `inv_destroy`, `inv_sort` · `pickup{dropId}` · `shop_buy{itemId,qty}`, `shop_sell{slot,qty}`, `shop_buy_many{lines[]}`, `shop_sell_many{lines[]}` (UI clamps qty to stack) · `storage_put{slot,qty}`, `storage_take{slot,qty}`, `storage_move`, `storage_sort`, `storage_zeny{action,amount}` (UI digits-only, floors; raw can differ) · `market{op…}` (history/trades/etc.) · `trade` · `mail` · `friend` · `party{action…}` (board/join/post/summon/promote/invite) · `guild` · `pet_set{petId}` · `plagiarism` · `enchant{source,lock}` · `enchant_choose{accept}` · `refine{source,blessing}` · `socket_drill{slot}` · `card_insert`/`card_remove{source}` · `collection_register{slot}` · `boss_list` · `view` · `exchange`
**server→client (~60):** `hit`, `cast`, `skill_fx`, `boss_fx`, `died/death`, `respawned`, `exp_gain`, `levelup`, `item_gain`, `item_used`, `item_fx`, `inventory`, `storage`, `shop`, `market_*` (open/results/mine/history/trades/changed/done/badge), `trade`, `gacha`+`gacha_result`, `enchant_result`, `refine`+`refine_result`, `socket`+`socket_result`, `card_removal*`, `warp_menu`, `travel`, `channels`, `character`, `chat`, `party*`, `friends`, `guild`, `mailbox`, `arena_*`, `boss_list`, `boss_mvp`, `boss_reward`, `dps_meter`, `topup`, `alert`, `server_notice`, `center_notice`, `force_logout`

## 4. Candidate exploit surfaces (mapped to requested categories; TO TEST in active phase)
All of these are **client-guarded only** in the UI — the server-side validation is UNKNOWN from outside. Each item is a prepared test:
1. **Combat damage**: `cast` with unlearned/cross-class/negative/overflow `skillId` (int32 boundaries ±2147483647/8, floats, strings, null), remote/NaN/1e308 `x,y`, `targetId` of non-entity/self/dead, cast-spam vs server cooldown, `stat_up{stat,n}` with n=0,-1,huge,NaN (client batches n; raw may bypass points), `skill_up` without points, arena/duel targeting anomalies. (Rogue "Plagiarism" is an INTENDED cross-class vector — must still be level-checked.)
2. **Travel**: `move_to` with negative/huge/NaN/±Infinity coords and far teleports; grid-snap bypass; `move{dx,dy}` overflow vectors; `npc_warp{mapId}` to locked/unreleased maps, negative/string/garbage map ids; `channel_switch` to 0/negative/huge/skips + cooldown; `guide_skip`; `respawn{to}` arbitrary values; party `summon` misuse.
3. **Pickup**: `pickup{dropId}` for foreign-owned drops with `ownUntil` active, far-away drops (range check), already-taken/duplicate ids, rapid double-pick same id (race dupe), id type confusion (number/array/object).
4. **Duplication**: rapid `storage_put`/`storage_take`/`storage_move` races (double-fire same slot), `inv_move` races, `trade` accept/cancel races across two accounts, `market` list/sell/cancel double-fire, mail claim races, refine-break refunds, `socket_drill`/`card_remove` return paths, shop_sell_many with duplicate lines.
5. **Item generation**: `gacha_roll{count}` with 0/-1/2^31/NaN/1e15/floats (UI clamp bypass), `shop_buy{qty}` negative (credits money + gives items?), `shop_buy_many` lines with negative qty / duplicated lines, `enchant_choose{accept}` with no pending, `collection_register` replay, boss_list/boss_reward flow.
6. **Currency**: `storage_zeny{action:'in'/'out',amount}` negative/huge/overflow/float/string (UI is digits-only — raw input untested), `shop_sell{qty}` negative (pays you to sell?), `market` price/qty negatives/overflow/2^53 precision, trade zeny offers.
7. **Generic hardening probes** (apply to every message): type confusion (string↔number↔null↔object where scalars expected — msgpack `mapsAsObjects` means attacker controls map keys), **prototype-pollution keys** (`__proto__`, `constructor`, `prototype`) inside nested payloads, 2^53±1 precision, negative zero, extremely long strings in name/text fields, message replay ordering, burst rates, and per-message authorization (doing another player's actions by id).
**Note:** in this stack a master-crafted wrong-type integer (e.g., `qty:-1`, `count:2^31`, `x:NaN`) is exactly the "buffer overflow/underflow" class the requester asked for — int32/int53 wrap and negative flows are the realistic failure modes; there are no C buffers to smash, but schema/decoder edge cases (`Number.isSafeInteger` assumptions, msgpack int widths) are the equivalents.

## 5. Boundary (why Phase 2 not yet run)
Active testing = sending crafted/injected messages to their live production server while ~2k players are online. Per policy this requires the requester's authorization for THIS title (like the Lumivara engagement), or a staging server. No account was created and no message was sent beyond public GETs/browsing this session.

## 6. Proposed Phase-2 protocol (once authorized)
1. Create one guest account via the normal UI (locale TH) → enter world → capture handshake: endpoints, room name, schema fields, initial sync.
2. Passive frame logging via initScript wrapper (as in Lumivara audit) — no injections yet; build a per-message baseline table.
3. Run the category matrix (above) in the same order as Lumivara: value-clamping probes first (negative/zero/huge/NaN/type-confusion per field), then races (double-fire), then cross-entity authorization (foreign ids), lowest-impact first; self-account only; no payment flows; stop-on-positive.
4. Deliver: findings with repro, severity, and fix hints (server-side re-validation + integer bounds + `Number.isSafeInteger` + explicit type checks + per-session rate limits + authorization checks).

---

## 7. Phase 2 — ACTIVE probe results (authorized; session 2026-10-04)

### 7.1 Setup & wire protocol (fully decoded)
- Guest account created via normal UI; character `ReconAether` (Novice Lv1). Endpoint: `wss://g5.aetheria-online.in.th/<roomId>/<processId>?sessionId=cerEsxcSZ&skipHandshake=1`.
- Framing: control bytes `0x0a`=join, `0x0c`=ping, **`0x0d`=custom message (client↔server)** = `msgpack(type) + msgpack(data)` concatenated; `0x0e`=state sync. Payloads are msgpack (their encoder uses msgpackr record extensions — `d4 72 <id>`; the **server decoder accepts standard msgpack** — proven by round-trips below).
* Injection harness: in-page msgpack encoder + `__inject(type, data)`; validated by `move_to` crafting that physically moved the character (67,72 → 70,72) and later full walk-intent control. **Correction:** an early "`boss_list` 1.5 KB reply" was most likely a coincident state-sync frame misattributed — `boss_list` does not reliably return anything; injector validity rests on the physical movement/channel effects (see §8).

### 7.2 Results by category — NO exploitable gap found in the reachable surface
**Movement (`move_to`)** — crafted valid targets work; server-simulated (client 20 Hz cannot exceed sim). Edges: `{x:'2160'}` string → ignored (no crash); `NaN` → ignored; `x=2147483647` and `x=1e308` → **clamped to walkable bounds & physically walked (no teleport)**; negative coords → walk toward min-bound until blocked, rejection notice `ไปตรงนั้นไม่ได้` shown; floats accepted (no rounding crash). No overflow/underflow misbehavior.
**Channels (`channel_switch`)** — legit switch works (CH20→CH1 observed); **`0`, `-1`, `999`, `2^31` all rejected** (state unchanged), and a **~10 s cooldown** is enforced with explicit message (`เปลี่ยน channel ได้อีกใน N วินาที`). Well validated.
**Travel (`npc_warp`)** — inert in every state reachable at Lv1 (no NPC warp session / world-map context reproduction blocked by level/guide gating): valid-connected (`novice_garden`), far high-level (`frost_pass`, `moon_forest`), garbage (`''`, `123`, `null`, `zz-nowhere`) — all silently ignored. No bypass via raw message. (Retest post-class-change.)
**Stats (`stat_preview`/`stat_up`)** — silently ignored at Novice Lv1 in all variants (`n=1` legit, `-1`, `0`, `1000`, `2^31`, invalid stat id), including the correct preview-then-up flow. Effectively gated pre-class-change; no injection. (Retest post-class-change for negative/huge `n`.)
**Skills (`cast`, `skill_up`)** — unlearned id, `-1`, `2^31`, garbage string, `null` → all inert (no `skill_fx`, no errors, no state change).
**Type/overflow probes summary** — strings/NaN/null/±2^31/1e308 on numeric fields → ignored or clamped; no crashes, no disconnects, no ghost effects.

### 7.3 Not reachable at Novice Lv1 (backlog for a post-class-change / higher-level session)
Shop buy/sell & quantity negatives (`shop_buy/sell/sell_many`, needs merchant NPC context), market/gold ops (needs market context + real listings), storage & `storage_zeny` amount edges (needs storage NPC), trade/dupe races (needs 2 chars + peers), gacha `count` edges (needs event machine; **deliberately avoided negative/huge count — loop-hang risk for the shared room**), pickup ownership/distance/dup (needs a hunting map + drops; capital is safe-zone), mail claim edges. None of these were testable without progressing the character — the server's context gating itself blocked the fast test path (a positive finding).

### 7.4 Positive security observations (all verified live)
Server-authoritative movement with bounds clamping & walkability validation; channel whitelist + cooldown; context-gated warp; gated stat/skill mutation; type-confusion robustness on all probed numeric fields; no crash/disconnect on malformed frames; world/systems gating by progression (guide/class).

### 7.5 Notes for the dev team
- Test account `ReconAether` left in place for log correlation (sessionId `cerEsxcSZ`, host `g5`, approx 2026-10-04 08:55–09:10 UTC); delete from char-select if not needed. All probes were self-account only; no other players were touched; no payment flows invoked.
- Minor hygiene: `window.__fxlab` debug handle ships in the prod bundle; all rejections are silent (consider optional error feedback); `skipHandshake=1` param + room/process ids are exposed in the WS URL (normal for Colyseus, just noting).
- Highest-value next probes: stat negative/huge `n` and market/shop quantity edges **after class change**; gacha `count:0/float` (avoid negative until code review); two-account trade/storage double-fire races.
---

## 8. Phase 2b — deep sweep (movement semantics, economy surface, robustness, session behavior)

### 8.1 `move{dx,dy}` fully decoded — no travel/speed manipulation
- `move{dx,dy}` is a **walk-INTENT directive**: any nonzero vector starts server-driven walking; `{0,0}` stops it immediately. Magnitude is effectively ignored (tested 8 → 1000: same ~4.5–5.5 tiles/s). Walk continues until stop message, replacement, or wall.
- No teleport: `move{dx:1000}` never jumped (earlier "+1 tile then stop" was the nearby city wall; later clean runs showed pure fixed-speed walking for every magnitude incl. 1000).
- `move_to{target}`: server path-walks to the target (~4.5–5 t/s), clamps/validates targets, ignores malformed fields. Multiple full round-trips verified.
- `arrived` (client route-arriver message): firing it mid-walk causes **no snap, no cancel, no speedup** — the server completes its own simulated walk to the `move_to` target and stops there.
- Boundary: 12 s straight-line runs stop at map walls — no ghost-walking out of bounds, no zone hijack.
- **Verdict: server-authoritative movement; crafted walking is no faster than natural client walking (~5 t/s either way). No speed/teleport exploit.**

### 8.2 Economy surface — 12 crafted ops, all silent no-ops (live socket, ~14 frames/s incoming)
`shop_buy{1,1}`, `shop_buy{1,0}`, `storage_zeny{in,-1}`, `storage_zeny{in, 2^53}`, `market{history}`, `market{trades}`, `gacha_roll{0}`, `gacha_roll{1}`, `exchange{shop_buy,item:1}`, `inv_move{0→1}`, `inv_use{0}`, `inv_destroy{0}` → **zero server frames, zero state change, zero errors**. Everything is server-side context-gated (no open shop/storage/market, empty inventory, 0 tokens at Lv1). No currency/dupe/generation surface reachable at this progression level.

### 8.3 Robustness re-run
- Unknown string type, number type (`123`), null type, 60 KB junk field, 200-message flood → no observable reaction, no error, no state change; legitimate messages still processed before/after (movement tests).
- Canary note: `boss_list` proved unreliable as a liveness canary (no reply) — liveness was checked via movement effects instead.
- **Deliberately NOT tested:** malformed msgpack bytes that throw in the decoder (would risk impacting the live room; recommend an isolated staging fuzz).

### 8.4 Platform behavior: periodic guest-session rotation (not message-triggered)
- Two disconnect/reconnect cycles observed mid-audit (once during message bursts, once during idle). The client auto-reloads, re-authenticates as guest (**new** sessionId), and rejoins (host/room/channel can change: `g5→g4`, CH1→CH3→CH15). Recovery automatic <~15 s; character state intact (level/position/pane preserved).
- Looks like guest-session TTL / load-balancing — **not attributable to crafted messages**; but it adds noise to long probe runs (documented for repro accuracy).
- Residual ideas (deferred; need pinning/staging): reconnect-token replay, two-session single-account tests.

### 8.5 Chat rendering quick test
- Whisper-to-self with `<b>…</b><img src=x onerror=…>`: where rendered, the payload appeared as **literal text** (no `<b>`/`<img>` elements created, no JS executed, `window.__xss` stayed 0) → chat output is escaped by the React layer; no XSS via chat as far as tested.

### 8.6 Phase 2b verdict
**No exploitable route found in any reachable system.** Every control tested behaves server-side: context gating (stores/warps/stats/skills/economy), value validation (clamps/ignores), rate limiting + atomic cooldown (channels), path simulation (movement), escaped rendering (chat), silent rejection of type-confused/unbounded inputs, no crashes on flood/oversize. The untested remainder is exactly the progression-locked gameplay (shop/market/storage/trade/pickup/combat flows) — where quantity/race logic would live — and needs a leveled account or staging access to reach.

> **Methodology:** the full command-surface discovery playbook (how all 58 client commands / 71 server events were surfaced, decoded and verified — scripts included) lives in `aetheria/METHODOLOGY.md`.
