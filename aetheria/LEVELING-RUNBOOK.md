# AETHERIA LEVELING RUNBOOK — Full-Loop Scenario: Analysis, Command Catalog, Profile & Command Center

> Status: 2026-10-04 · Companion to `HEADLESS-TESTING.md`, `STORAGE-INVENTORY.md`, `METHODOLOGY.md`
> Testbot code: `aetheria/testbot/` (working raw headless client — **no browser needed**)

Legend: ✅ verified live · 📋 payload verified from shipped client code (call untested or partially tested) · ❓ not yet identified/needs capture

---

## PART 0 — What we HAVE today (single client works)

A fully working **raw Node client** (`testbot/src/client.js`) that:

1. `POST /auth/guest` → `{token, guest{userId,secret}}` (or reuse `testbot/out/session.json` — **guest signups are rate-limited, reuse tokens!**)
2. `GET /characters` → `{slots:3, nameRules:{minLength:3,maxLength:16,pattern:"^[A-Za-z0-9ก-๙_]+$", uniqueScope:"server"}, characters[]}`
3. `POST /characters {name}` → `{characterId}` ✅ (character creation SOLVED — step 1 of the scenario)
4. `POST /world/enter {characterId}` → `{mapId, ticket, displayName, roomId, channel, endpoint}`
5. `POST <endpoint>/matchmake/joinById/<roomId> {ticket}` → **flat reservation** `{name, sessionId, roomId, processId}`
6. `ws://<endpoint-host>/<processId>/<roomId>?sessionId=<sessionId>` → server immediately pushes `0x0a` JOIN (token + `serializerId:"schema"` + reflection), client ACKs `[0x0a]`
7. All gameplay messages: `[0x0d]` + **msgpack(type) + msgpack(data)** — decoded with `@msgpack/msgpack`
8. Sends commands: `[0x0d] + msgpack(type) + msgpack(data)` — **verified live**: `stat_up STR+1` (48→46 pts, STR 1→2)

Verified working from Node: `move_to`, `move` (5 t/s walk-intent), `inv_sort`, `stat_up`, `shop_sell(_many)`, `storage_*`, `npc_*`, `auto_set`, `channel_switch`, `skill_up`, `stat_preview`, `npc_warp` (browser-verified; same bytes from Node).

Data received on join (all decoded): `character` (incl. **zeny**, stats, statCosts, baseExp/jobExp, derived{maxHp,…}, discoveredMaps, equipment, skills, hotbar, savePoint, auto, jobChangeOptions), `inventory` (slots/weight/items), **`skill_catalog` (130 skills w/ ids like `bash`, `sword-mastery`, `peco-peco-ride` — saved at `testbot/out/skill-catalog.json`)**, `chat`, `mailbox`, `arena_status`, `party`, `guild`, `friends`, `market_badge`, `collection`, …

Known decode gap: 0x0e/0x0f **room.state** is schema-encoded and the server build is not decodable by any published `@colyseus/schema` (1/2/3/3.0.0-alpha/4/5 all tested). **Current HP / dead flag live only in state** — workaround: monitor `auto` disable + `respawn {to}` 📋; refine later.

---

## PART 1 — FULL COMMAND CATALOG (58 message types, extracted from shipped client + live testing)

### Movement / view
| type | payload | status | notes |
|---|---|---|---|
| `move_to` | `{x,y}` px (tile center = (t+0.5)*32) | ✅ | teleport-like walk to point |
| `move` | `{dx,dy}` | ✅ | walk intent ~5 tiles/s |
| `view` | `{w,h}` | 📋 | camera report (probably optional for bots) |
| `arrived` | — | 📋 | sent after travel completes |

### Combat / targeting / auto
| type | payload | status | notes |
|---|---|---|---|
| `target` | `{targetId}` | 📋 | manual target |
| `cast` | `{skillId, recipeId, qty}` | 📋 | includes crafting casts |
| `pickup` | `{dropId}` | 📋 | manual loot (auto loot also exists) |
| `auto_set` | `{enabled}` / `{config:{huntRadiusTiles, monsters[], skills[], flyWing, pickupLoot, …}}` | ✅ | hunting allowed outside city only; stops on death/weight>90% |
| `respawn` | `{to}` | 📋 | death handling |
| `boss_list` | — | 📋 | |

### Stats / skills
| type | payload | status | notes |
|---|---|---|---|
| `stat_up` | `{stat:'STR',n:1}` (UPPERCASE) | ✅ | costs from `character.statCosts` |
| `stat_preview` | `{add:{STR:1}}` | ✅ | |
| `skill_up` | `{skillId}` | ✅ | ids from skill_catalog |
| `skill_facet` | `{skillId,tier,option}` | 📋 | skill rune/facet system |
| `plagiarism` | `{action:'list',targetId}` | 📋 | |

### Inventory / equipment
| type | payload | status | notes |
|---|---|---|---|
| `inv_sort` | `{}` | ✅ | also forces fresh inventory msg |
| `inv_use` | `{slot}` | 📋 | use consumable |
| `inv_move` | `{from,to}` | 📋 | bag↔storage↔equip cross-moves |
| `inv_destroy` | `{slot,qty}` | 📋 | |
| `equip` / `unequip` | `{slot}` / `{slot,to}` | 📋 | |
| `itembar_set` | `{slot,itemId}` | 📋 | |
| `hotbar_set` | `{slot,entry}` | 📋 | |
| `item_info` | `{itemId}` | 📋 | item DB lookup |

### Economy — NPC shops / market / storage
| type | payload | status | notes |
|---|---|---|---|
| `shop_sell` / `shop_sell_many` | `{slot,qty}` / `{lines:[{slot,qty}]}` | ✅ | verified math live |
| `shop_buy` / `shop_buy_many` | `{itemId,qty}` / `{lines}` | 📋 | |
| `market` | `{op:'search',filters}` | 📋 | response shape to probe |
| `market` | `{op:'buy',listingId,price}` | 📋 | buying exact listings |
| `market` | `{op:'bid',listingId,amount}` | 📋 | auctions |
| `market` | `{op:'history',itemId,refine,range}` | 📋 | price research |
| `market` | `{op:'trades'}` | 📋 | |
| `storage_put` / `storage_take` | `{slot,qty}` | ✅ | |
| `storage_move` | `{from,to}` | ✅ | |
| `storage_sort` | `{}` | 📋 | |
| `storage_zeny` | `{action,amount}` | 📋 | bank zeny |
| `exchange` | `t` | 📋 | |

### Crafting / refine / socket / cards
| type | payload | status | notes |
|---|---|---|---|
| `refine` | `{source,blessing}` | 📋 | blacksmith refine; `source`=slot, `blessing`=? (probe) |
| `socket_drill` | `{slot}` | 📋 | Auger |
| `enchant` | `{source,lock}` + `enchant_choose {accept}` | 📋 | Enchant Rune flow |
| `card_insert` | `{card,target}` | 📋 | |
| `card_remove` | `{source}` | 📋 | |
| `collection_register` | `{slot}` | 📋 | card collection |
| `gacha_roll` | `{count}` | 📋 | |

### NPC / travel / world
| type | payload | status | notes |
|---|---|---|---|
| `npc_talk` | `{npcKey}` (n1..n12 map-local) | ✅ | |
| `npc_option` | `{index}` 0-based | ✅ | |
| `npc_close` | `{}` | ✅ | |
| `npc_warp` | `{mapId}` | ✅ | via warp-capable NPC (Alice n6 option 1) |
| `channel_list` / `channel_switch` | / `{channel}` | ✅ | shard spreading |
| `guide_skip` | — | 📋 | skip tutorial guide |

### Social / misc
| `chat {channel,text,itemSlot?}` ✅recv · `mail {op,id}` · `party {action:'invite',name}` · `friend` · `guild` · `trade` · `arena` · `pet_set {petId}` · `gacha_roll` |

### Known NPC directory (capital, px = tile*32)
| key | NPC | tile | dialog |
|---|---|---|---|
| n1 | Healer Mira | 71.5,36.5 | heal |
| n2 | Shopkeeper Bor | 27.5,47.5 | shop (sell/buy) — option index to verify |
| n3 | Blacksmith Enok | 77.5,48.5 | refine 📋 |
| n4 | Armorer Hilda | 74.5,48.5 | shop, option 0 opens |
| n5 | **Valkyrie** | 52,30 | class change (option 0 = request) |
| n6 | Alice | 56.5,50.5 | 0 save · 1 warp · 2 storage (40z) |
| n11 | Phoenix Egg Lucky | 59,66 | gacha |
| n12 | Auger Socket | — | socket drill |

---

## PART 2 — THE 25-STEP SCENARIO, MAPPED TO COMMANDS

| # | Step (as requested) | Command sequence | Status |
|---|---|---|---|
| 1 | ตั้งชื่อสร้างตัวละคร | `POST /characters {name}` (rules: 3-16 chars A-Za-z0-9ก-๙_) | ✅ |
| 2 | STR10 DEX10 | `stat_up{stat:'STR',n:9}` ×, `stat_up{stat:'DEX',n:9}` (48 pts at start) | ✅ |
| 3 | ฟาร์มทุ่งหญ้าตะวันออก → Job10 | `travel→east-meadow` ❓ + `auto_set{config:{huntRadiusTiles:'all',pickupLoot:true,…}}` until `jobLevel==10` | ⚠ route ❓, farm ✅ |
| 4 | Basic Skill 9/9 | `skill_up{skillId:'basic-skill'}` ×9 (catalog: maxLevel 9, learnMax 9) | ✅ |
| 5 | Valkyrie → นักดาบ (Swordsman) | walk n5(52,30) → `npc_talk{n5}` → `npc_option{index}` 📋 **capture option indices when eligible (Job10+Basic9)** | 📋 |
| 6 | ไปถนนวิลโลว์ | on-foot route/portal ❓ (see Part 5) | ❓ |
| 7 | Lv12 + Bash10 SwordMastery10 | `skill_up{'bash'}` ×10, `skill_up{'sword-mastery'}` ×10; farm to base Lv12 | ✅ skills |
| 8 | ตลาด: อัญมณี + ดาบร้านตี + ตีบวก | `market{op:'search',filters}` 📋 → `buy{listingId,price}` 📋; blacksmith n3 dialog ❓; `refine{source,blessing}` 📋 | 📋/❓ |
| 9 | โกบลิน → Job50 | travel ❓; auto farm (job exp) ✅; sell/store loop ✅ | ⚠ route ❓ |
| 10 | เปลี่ยนอาชีพ Knight | Valkyrie again — `jobChangeOptions` repopulate; capture indices (Requirement per class — likely Job40+) | 📋 |
| 11 | จัด stat ตามแผน | `stat_up` sequence driven by a **plan table with target stats** (engine auto-computes n from statCosts) | ✅ |
| 12 | ตลาด: ชุดเกราะ + Broad Sword +4 | market buy 📋; `refine{source}` ×4 at n3 📋 (+blessing probe) | 📋 |
| 13 | ทุ่งเนินสเกลส์ — อัพสกิล | travel ❓; `skill_up` knight ids: `spear-mastery`, `pierce`, `bowling-bash`, `brandish-spear`, `two-hand-sword-mastery`, `spear-dynamo` ✅(ids) | ⚠ route ❓ |
| 14 | เช่า Peco | ❓ rental NPC unidentified (skill `peco-peco-ride` max 1 exists; mount flow = ?) — M2 discovery: scan capital NPC dialogs | ❓ |
| 15 | Frost Peak → 60-65 | travel ❓ + auto ✅ | ⚠ route ❓ |
| 16 | Dawbreaker +7 | market search by name → itemId ❓; `refine` ×7 📋 | 📋/❓ |
| 17 | บึงพิษ → Lv99 | travel ❓ + long auto farm + death loop `respawn{to}` 📋 | ⚠ route ❓ |
| 18 | สรุป stat STR90 AGI70 DEX40 VIT30 LUK40 | `stat_up` plan (engine computes points/costs; VIT before armor swaps if needed) | ✅ |

**Remaining unknowns (M2 capture list):**
1. Class-change dialog option indices at eligibility (steps 5 & 10) — reachable by the bot itself once farming works.
2. On-foot map travel: no `travel` send from client → the server moves you when stepping on portals; the `travel` **message** (mapId, roomId, ticket) → client must leave + `joinById` re-join. Need portal tile coords per map (probe: walk-scan with `move_to`).
3. Blacksmith/refine dialog flow + `refine{source,blessing}` semantics + ore requirements & safe-level behavior (probe with cheap weapon).
4. Peco rental NPC (scan class-change city NPC dialogs / text search).
5. `market{op:'search'}` filter schema + response shape (live probe with `{}` and by-name).
6. HP/death visibility (state undecodable) — fallback: auto-disable detection + `respawn` probe; alternative: sniff `0x0f` patch refs (heavy) or read hp via a mini browser helper during M2. Tracked.

---

## PART 3 — SELL / STORE POLICY (exactly as requested)

User rule: **sell everything EXCEPT all cards + Enchant Runes; store those into storage when backpack is full or heavy.**

Item classification (from `inventory.items[]`: `{slot,itemId,name,type,qty,sellPrice,maxStack,usable,destroyable}`):
- PROTECT = `type in ['Card','Enchantment']` OR `name` matches `Enchant Rune` (types seen live: Consumable, Card, Enchantment).
- SELLABLE = `sellPrice>0` AND not PROTECT.
- Event items (sellPrice 0, e.g. Event Red Potion) → never sold; optionally `inv_destroy` later (policy flag, default keep).

Loop (runs on every `inventory` message and every N seconds):

```
if (bagFreeSlots < minBagFree(=10) OR weightPct > maxWeightPct(=85) OR protectedCount grew):
    # 1) BANK TRIP (only if protected items exist or bag critical)
    if protectedItems.length > 0 or bagFreeSlots < minFree:
        move_to 56.5,50.5 (Alice n6)
        npc_talk{npcKey:'n6'} → npc_option{index:2} (storage, 40z fee)
        for each protected item: storage_put{slot, qty}
        npc_close{}
    # 2) SELL TRIP
    if sellableItems.length > 0:
        move_to 27.5,47.5 (Bor n2)
        npc_talk{npcKey:'n2'} → npc_option{index:0}  # shop open index: VERIFY in M2
        shop_sell_many{lines:[{slot,qty},… all sellable]}
        npc_close{}
```

Guard rails: never sell `destroyable:false` items unless explicitly listed; keep `Butterfly Wing` (fly-wing item for auto), keep equipped slots (slot indexes are bag-only here); sell before banking if bag full but no protected items — go straight to Bor. Zeny check after each trip via `character.zeny`.

---

## PART 4 — PROFILE / COMMAND-SEQUENCE STORAGE (design)

Profiles are **JSON stage machines** (file per plan, e.g. `testbot/profiles/novice-to-knight-99.json`). Runner loads profile + character, then executes stages sequentially, **idempotently** (each op first checks current state from `character`/`inventory` messages and skips if already satisfied — makes crash/restart/reconnect safe).

```jsonc
{
  "profileId": "novice-to-knight-99",      // file: profiles/<id>.json
  "version": 1,
  "character": { "nameTemplate": "Farm%03d" },
  "stages": [
    {
      "id": "s03-farm-job10",
      "map": "east-meadow",                 // travel op before steps if map differs
      "steps": [
        { "op": "stats",  "plan": { "STR": 10, "DEX": 10 } },
        { "op": "skills", "plan": { "basic-skill": 9 } },
        { "op": "farm",   "until": { "jobLevel": 10 },
          "auto": { "huntRadiusTiles": "all", "pickupLoot": true, "flyWing": true,
                    "monsters": ["*"], "skills": [{"id": "basic-attack", "level": 1}] } },
        { "op": "sellStore", "policy": "default" }
      ]
    },
    {
      "id": "s05-class-change-1",
      "map": "capital",
      "steps": [
        { "op": "gotoNpc", "npc": "n5" },
        { "op": "npc", "npc": "n5", "options": [0], "expect": { "jobChangeOptions": true } },
        { "op": "npc", "npc": "n5", "options": ["AUTO_CLASS:swordsman"], "capture": "job-change-dialog" },
        { "op": "waitFor", "condition": { "classId": "swordsman" } }
      ]
    }
  ],
  "policies": {
    "sell":    { "protect": { "types": ["Card", "Enchantment"], "nameMatches": ["Enchant Rune"] },
                 "sellIf": { "sellPrice": ">0" }, "minBagFree": 10, "maxWeightPct": 85 },
    "storage": { "npc": "n6", "option": 2, "put": ["protected"], "feeZeny": 40 },
    "death":   { "respawn": { "to": "capital" }, "then": "resumeStage" },
    "reconnect": { "maxRetries": 5, "backoffSec": 15 }
  },
  "runtime": { "stateFile": "../out/run-<botId>.json" }   // resume cursor + last known snapshot
}
```

Op vocabulary (the runner implements these): `travel {to}` · `gotoNpc {npc}` · `npc {npc, options, expect?}` · `stats {plan}` (targets, engine computes deltas from current+statCosts) · `skills {plan}` (target levels, spends skillPoints) · `farm {until, auto}` · `sellStore {policy}` · `buy {shop|market, items[]}` · `refine {item, target, blessing?}` · `socket/enchant/card` ops · `equip {itemId}` · `waitFor {condition}` · `capture {tag}` (logs raw messages for protocol discovery) · `sleep {ms}`.

Conditions: `{baseLevel, jobLevel, classId, zeny, skill:{id,level}, stats:{…}, map, jobChangeOptions:true}`.

**`capture` op is key**: it auto-saves raw frames when executing unknown dialogs (class change, refine) so each ❓ in Part 2 turns into a 📋 without manual sniffing.

---

## PART 5 — COMMAND CENTER (1 → 10 → 100 clients)

Architecture (all Node, one repo):

```
testbot/
  src/client.js          # raw client (DONE)
  src/runner.js          # M2: executes a profile for one bot (stage FSM + policies)
  src/orchestrator.js    # M3: spawns N runners, channel sharding, staggering, restarts
  src/dashboard/         # M3: tiny HTTP + SSE UI (grid of bot cards, controls)
  profiles/*.json        # scenario storage (DONE: novice-to-knight-99)
  out/                   # logs/jsonl, session tokens, captures
```

- **M2 (next)**: single-bot runner end-to-end through stages 1-9 (create → Job10 → Swordsman → Bash/SwordMastery → sell/bank loops). Each ❓ capture op fires automatically → we close gaps by observation, not guessing.
- **M3 (10 clients)**: orchestrator with per-bot FSM; joins staggered 30–60 s; `channel_switch` to spread (e.g. channels 1..10); shared map/NPC/item DB JSON; dashboard = one HTML page via SSE: per-bot card (name, map, level/job, zeny, bag%, weight%, stage, last event), global log stream, per-bot buttons (pause/resume/command).
- **M4 (100 clients)**: 4 processes × 25 bots (CPU-friendly — raw client is a few KB/bot); resume from `out/run-*.json`; rate-limit ledger for REST calls (guest signup 429 observed!); auto-reconnect with backoff; a kill switch (disconnect all); dashboard aggregates processes.
- Optionally `move`-based anti-detection niceties are NOT needed for testing correctness; keep intervals natural (walk speed limits already enforced server-side ~5 t/s).

---

## PART 6 — OPS NOTES

- **Guest sessions rotate** every few minutes (new host/channel per `world/enter`) — always re-`enter` on reconnect; upgrade to a real account for long grinds.
- `/auth/guest` returns **429 "ลองมากเกินไป"** when hammered — reuse `out/session.json` until expiry (~12 h), or space signups.
- Server accepts the join URL with `?sessionId=` (no extra frames needed); client should still ACK `[0x0a]` after JOIN (matches game behavior).
- `auto_set` refused in city: "ต่อสู้อัตโนมัติใช้ได้เฉพาะนอกเมือง" — farming stages must travel out first.
- Keep `flyWing:true` in auto config to return to savepoint when bag is full — pairs well with the sell/bank loop (savepoint = capital).
- All raw frames of every session are logged to `testbot/out/*.jsonl` — evidence for every claim.

### Fast start (today)
```
cd aetheria/testbot
node src/m1-raw.js      # join + snapshot + skill catalog (already run OK)
node src/m1-act.js      # stat point round-trip + inventory (already run OK)
```
