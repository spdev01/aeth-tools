# AETHERIA — LIVE-AUDITED COMMAND SEQUENCE (headless, foolproof)

> This is the *executed & verified* sequence. Each step lists the exact wire commands.
> Runner: `testbot/src/runner.js` (state cursor in `testbot/out/run-state.json`, logs in `testbot/out/run-*.jsonl`).
> STATUS: ✅ = verified live · 🔬 = capture probe pending · ⏳ = long farm in progress

## Core mechanics (all verified)

### Connect (per bot)
```
POST /auth/guest                          -> {token}
GET  /characters                          -> {characters[]}
POST /characters {name}                   -> {characterId}          (3-16 chars A-Za-z0-9ก-๙_)
POST /world/enter {characterId}           -> {mapId,ticket,roomId,channel,endpoint}
POST <endpoint>/matchmake/joinById/<roomId> {ticket} -> {name,sessionId,roomId,processId}
ws   wss://<endpoint-host>/<processId>/<roomId>?sessionId=<sessionId>
     <- 0x0a [token][serializerId="schema"][reflection]   (client ACKs [0x0a])
```
Send: `[0x0d] + msgpack(type) + msgpack(data)` · Receive: same, plus batched events `b:[["hit",…],["skill_fx",…]]`.

### Walking & map travel (VERIFIED)
- `move_to {x,y}` px (tile·32) — walks there server-side; `move {dx,dy}` = one-step intent.
- Portals = rect objects in `/maps/<mapId>.json` (objectgroup, property `toMap`). Exit table captured in `testbot/maps/_exits.json`.
- **Stepping into the portal rect triggers server push:**
  `travel {mapId, displayName, ticket(JWT), roomId, channel, endpoint}`
- **Rejoin procedure (exact game logic):**
  1. `[0x0c]` LEAVE_ROOM on old socket, wait ~0.9 s
  2. close old socket
  3. `POST <travel.endpoint>/matchmake/joinById/<travel.roomId> {ticket: travel.ticket, batch: true}`
  4. connect new socket, wait `0x0a` join, send `arrived`
- Route examples (physical exits): capital→field_01 (right portal 3280,1728) · capital→willow_road = novice_garden→sun_farm→willow_road (3 hops) · capital→clover_meadow→goblin_trail (2 hops) · willow_road→gale_high (top 1808,128) · gale_high→frost_pass (left 128,1392).

### Map IDs ↔ Thai names (from live travel displayNames + atlas)
| mapId | Thai | level |
|---|---|---|
| capital | เมืองหลวงโซลเฮเวน | town |
| field_01 | **ทุ่งหญ้าตะวันออก** (east meadow, right of capital) | 1-5 |
| novice_garden | สวนนักผจญภัยมือใหม่ | 1-3 |
| sun_farm | ไร่ซันเกรน | 1-6 |
| willow_road | **ถนนต้นหลิว** | 6-12 |
| clover_meadow | ทุ่งโคลเวอร์ | 1-5 |
| goblin_trail | **เส้นทางก็อบลิน** | 16-20 |
| gale_high | **ที่ราบสูงเกล** (Scales highland) | 25-35 |
| frost_pass | **ช่องเขาฟรอสต์พีค** | 35-45 |
| venom_swamp | บึงพิษ | 60-70 |

### Auto-combat (VERIFIED)
`auto_set {config:{…}}` then `auto_set {enabled:true}`. Full config schema (server-normalized, captured):
`{skills:[], monsters:[], hpPercent, spPercent, pickupLoot, lootWhen:"first", flyWing, flyWingMobs, basicAttack:true, hpItems:[], spItems:[], buffItems:[], buffParty, lootTypes:[], …}`.
- `huntRadiusTiles:"all"` = whole map · `monsters:[]` = all monsters
- Refused inside city: "ต่อสู้อัตโนมัติใช้ได้เฉพาะนอกเมือง"
- Verified: Job 1→10 at field_01 in ~40 s (Slimes: 25/19 exp); willow Treants: 224/168 exp; drops incl. **Rough Elunium**.

### Stats & skills (VERIFIED)
- `stat_up {stat:'STR', n:1}` (UPPERCASE keys) — loop per point using `character.statCosts`.
- `skill_up {skillId}` e.g. `basic-skill`, `bash` (max 15), `sword-mastery`, `provoke`, `hp-recovery`, `endure`, `magnum-break`, `two-hand-quicken`, `bowling-bash`, `peco-peco-ride`(1), `peco-peco-master`(5).

### NPC dialogs (VERIFIED)
`npc_talk {npcKey}` → server sends `npc_dialog {npcKey, name, art, text, options:[string,…]}` — **options are plain strings; index = position** (0-based).
`npc_option {index}` advances; `npc_close {}` to exit.

**Valkyrie class change (n5 @ 1664,960) — exact captured chain:**
```
npc_talk n5
 -> ["ข้าพร้อมเปลี่ยนอาชีพแล้ว","ไว้ก่อน"]                      choose 0
 -> ["Swordsman (นักดาบ)","Mage (นักเวท)","Archer (นักธนู)",…]  choose 0 (นักดาบ)
 -> ["ยืนยัน เป็น Swordsman","ไม่ ขอเลือกใหม่"]                  choose 0 (ยืนยัน)
 -> npc_close; character.classId becomes "swordsman"
```
Gate: Job Lv.10 + Basic Skill Lv.9 (else: "ยังเร็วไป…").

### Death & recovery (wired, live-verify pending)
Server messages: `death` (payload captured on first death) and `respawned`. Recovery: send `respawn {to:'save'}`, wait `respawned`, re-travel to farm map, re-enable auto. Auto also self-disables at weight>90%.

### Monitoring (all via messages, no state decode needed)
`character` (levels/exp/zeny/stats/points/auto/class) · `inventory` (slots/weight/items) · `exp_gain {base,job,monster}` · `item_gain {itemId,name,qty}` · `chat` · `center_notice` (quest text) · `item_used` · batched `b:[["hit",…],["refine_fx",…],["skill_fx",…]]`.

---

## The executed sequence (user's audit)

| # | Step | Commands | Status |
|---|---|---|---|
| 1 | Login + create char | auth reuse → `POST /characters {name}` → enter → connect | ✅ |
| 2 | STR 10 / DEX 10 | `stat_up STR` ×9 (from 1) + `stat_up DEX` ×9 | ✅ |
| 3 | Walk RIGHT map → ทุ่งหญ้าตะวันออก (field_01), farm to Job 10 | `move_to` portal (3280,1728) → travel flow → `auto_set {config:{huntRadiusTiles:'all', monsters:[], pickupLoot:true, hpPercent:60, spPercent:40}}` + `{enabled:true}` → wait `jobLevel>=10` | ✅ (~40 s) |
| 4 | Basic Skill 9/9 | `skill_up basic-skill` ×9 | ✅ (quest notice fired) |
| 5 | Back to capital + Valkyrie → Swordsman | travel back (1 hop) → walk (1664,960) → dialog chain above | ✅ |
| 6 | DEX 10, rest → STR | `stat_up DEX`→10 then `stat_up STR` dump-all | ✅ |
| 7 | Map → ถนนต้นหลิว (willow_road) | 3-hop travel: novice_garden→sun_farm→willow_road | ✅ |
| 8 | Farm Lv12 + Bash 10 + Sword Mastery 10 | `auto_set` (same) → wait `baseLevel>=12` → `skill_up bash` ×10 + `sword-mastery` ×10 (waits for job points while farming) | ✅ base 15 / job 21, both skills 10 |
| 9 | Auto config: tick Bash skill | `auto_set {config:{skills:[{id:'bash',level:10}]}}` (readback captured) | ✅ |
| 10 | ~~Return city → กลาง (market) : buy Mana Gem(Skill)3%, Lifesteal Gem(Skill)3%, Lifesteal Gem(Attack)3%~~ **REMOVED in v2 — not needed** | — | 🚫 v2 (gems drop from mobs anyway) |
| 11 | Blacksmith Enok: buy Ring pommel Saber + Rough Elunium ×12 + Phracon ×4 | `npc_talk n3` → option 3 (ซื้ออุปกรณ์ผจญภัย) → `shop_buy {itemId:91016}` = **840z**; option 2 (ซื้อแร่ตีบวก) → Rough Elunium ×12 + Phracon ×4 @ **200z ea** | ✅ |
| 12 | Refine sword → +4 | `npc_talk n3` → option 0 (ตีบวกอุปกรณ์) → `refine {source:{kind:'bag',slot:N}, blessing:false}` ×4 — **+1..+4 = 100% success**, 1 Phracon each, cost 275→386→538→725z | ✅ **+4** |
| 13 | Bag menu: equip sword (+ gems if any) | `equip {slot}` | ✅ equipped (+4) |
| 14 | Walk → เส้นทางก็อบลิน (goblin_trail), farm Job 50 | travel (capital→clover_meadow→goblin_trail) → `auto_set` → wait | 🔬 next |
| 15 | While waiting: DEX 20 / AGI 20 → rest STR | `stat_up` loops | 🔬 |
| 16 | Job 50 skills: Sword Mastery 10, Bash 10, Provoke 3, HP Recovery 10, Endure 10, Magnum Break 6 | `skill_up` per id | 🔬 |
| 17 | Knight class change + DEX 30 / AGI 30 / VIT 20 → rest STR | same Valkyrie chain (capture option list for Knight) + `stat_up` | 🔬 |
| 18 | Market gear (หัว/กลาง/ปาก/เสื้อ/ผ้าคลุม/รองเท้า/ประดับ with ลดดาเมจ options) | `market {op:'search', filters:{category/kind/job/rarity/minLevel…}}` → buy | 🔬 |
| 19 | Buy Broad Sword → +4 → equip | market buy + `refine` ×4 + `equip` | 🔬 |
| 20 | → ที่ราบสูงเกล (gale_high): farm to Job ~20; skills โบ(Bowling Bash)10, Two-Hand-Quicken 10, Peco Ride 1, Peco Master 5 | travel willow_road→gale_high → `auto_set` → `skill_up bowling-bash`/`two-hand-quicken`/`peco-peco-ride`/`peco-peco-master` | 🔬 |
| 21 | Return city, rent Peco at "Npc ขวบน" | 🕵 NOT FOUND in capital NPC list — rental NPC unknown; economy category `peco-rental` exists ("ค่าเช่า Peco Peco"). 🔬 next: NPC dialog scan of capital (n1..n12) + towns | 🕵 |
| 22 | → ช่องเขาฟรอสต์พีค (frost_pass): farm to 60-65 | gale_high→frost_pass (left portal 128,1392) → `auto_set` | 🔬 |

### Death/hiccup policy (implemented)
- On `death` → log payload · `respawn {to:'save'}` → wait `respawned` → `ensureMap(farmMap)` → re-`auto_set` → continue.
- On `auto.enabled flip false` (weight/death) → same recovery loop.
- Retries: every step runs twice with 3 s gap before aborting; cursor persists → rerun resumes.
- Multi-hop travel retries the hop up to 90 s; leave+rejoin verified idempotent.

### Known gaps remaining (probes queued in runner)
1. `market` search response shape ✅ (types `market_results` / `market_done`; listing = {listingId,item{...},price,qty,auctionEndsAt,...})
2. Blacksmith dialog tree ✅ (options captured below)
3. Gem insert → **enchant flow** (`n3` option 1 เสริมพลังอุปกรณ์ → `enchant {source, lock}` → `enchant_choose {accept}`; costs 500z + 1 Enchant Rune per line; 2 runes + 2 gems in bag — pending)
4. Peco rental NPC — n13..n24 brute force returned nothing; still unknown (economy cat `peco-rental` exists)
5. `death` payload fields — first live death pending (handler wired)

---

## Captured mechanics appendix (2026-10-04, live)

### Blacksmith Enok (n3) dialog
`["ตีบวกอุปกรณ์","เสริมพลังอุปกรณ์","ซื้อแร่ตีบวก","ซื้ออุปกรณ์ผจญภัย","ดูรายการของที่คราฟต์ได้","ไม่ล่ะ ขอบคุณ"]`
- Ores: **Phracon 90201 / Rough Elunium 90204 — 200z each** (both type "Enchantment")
- Saber sold at 840z (market had 1000z listings)

### Refine system (full)
- Request: `refine {source:{kind:'bag'|'equip', slot:N}, blessing:bool}` — **source is an OBJECT**; number slot silently ignored.
- Reply: `refine_choice` window msg (`mode:'refine'`, per-item `{source,item,to,success,onFail,material{have},zeny,safeLevel,maxed}`) + `refine_result {outcome,itemId,from,to,blessingUsed}` + `refine_fx` (broadcast ≥+7).
- Rates: +1..+4 100% (no-change) · +5 80% · +6 65% · +7 50% (downgrade) · +9 20% / +10 10% (destroy).
- Materials: weapon +1..4 Phracon, +5..7 Emveretarcon, +8..10 Oridecon; armor +1..4 Rough Elunium (→ **gems use Rough Elunium**, 3 gems × 4 = 12 exactly as planned).
- Cost scales with level (+4 saber total ≈ 1,924z). Safe levels: weapon common 7 / uncommon 6 / armor 4.
- Achievement fired: "สำเร็จ: ตีบวกอาวุธ"

### Shops
- Bor n2: `["ซื้อของหน่อย","ฝากของหน่อย","ไม่ล่ะ"]` — sold 27 junk stacks ≈ **5.3k z** (funded all purchases)
- Alice n6: `["บันทึกจุดเกิด","วาร์ป (แผนที่โลก)","เปิดคลังเก็บของ (40z)","ขอรักษาหน่อย (ฟรี)","รีเซ็ตสเตตัส (10,000z)","รีเซ็ตสกิล (10,000z)"]`
- Hilda n4: armor/accessories shop · Phoenix n11: 100,000z egg smash · Auger n12: hat socket drill

### Current leg (running)
Goblin trail farm J21→J50 with auto-sell/bank loop + stat plan (DEX20/AGI20→STR), then skills `provoke3/hp-recovery10/endure10/magnum-break6`, then **Knight** at Valkyrie.

---

## v3 live fixes (2026-10-04, post-audit)

### Why the bot was leveling slow — root causes found
1. **No potions = death loop.** The server auto-drinks only items listed in `auto.config.hpItems` (array of itemIds with `autoPotion:'HP'` on the item payload). Ours was empty — the starter Event Red Potions (90305) ran out — so the bot died every ~30-60s at goblin_trail, and each death cost ~35s (reconnect retry cycles).
   **Fix:** `buyPotions()` — n2 Bor `ซื้อของหน่อย` → General Goods → **Red Potion 90301 @50z**. Auto-restock to 40 when empty at farm start, after every death recovery, and in the bag-full sell cycle. `hpPercent` 60→75. `hpItems` now auto-derived from inventory at every `setAuto`.
2. **The server's auto-skill engine never fired Bash** (SP stayed 122/122 through constant combat). Config shape verified correct end-to-end: `auto_set {config:{skills:['bash']}}` → readback `skills:["bash"]`, `bashLv:10` (char has bash 10 = job-29 math checks out with 8 unspent points). Not a config bug — engine just doesn't cast here.
   **Fix — own skill weaving:** combat skills cast via `cast {skillId,targetId}` (from client `useHotbar`). Runner now watches `hit` events for mobs (`targetId` ~ /^m/) within ~4.7 tiles of our position and casts `['bash']` on a ~1.35s rolling cadence (SP ≥ 30 gate). Verified firing live: `weave {skill:"bash", target:"m131502", sp:130}`.
3. **Ghost sessions:** killing the client process leaves the character "ออนไลน์อยู่แล้ว" (already online) server-side for ~40s. Runner now retries the initial connect forever (60s backoff for ghost/429) instead of crashing; supervisor no longer mistakes crashes for clean completion (handler exits 3).
4. **Graceful rejoin:** every reconnect now sends leave frame `0x0c` before closing, so `matchmake/joinById` succeeds on the first try (was 6-7 retries ≈ 35s per death/recovery).

### Verified command/quiz additions
- General store (n2 option index 0): `shop_buy {itemId, qty}` · potions: Red 90301/50z, Orange 90302/200z, White 90303/1200z, Blue (SP) 90304/1000z, Concentration 90306/800z, Awakening 90307/1500z.
- `hit` events carry NO attackerId — shape: `{targetId, damage, x, y, onPlayer?, heal?, miss?}`. Self-damage detect = `targetId === sessionId`.
- Mobs hit near us ARE echoed as `hit` events (buffered as weave targets); our own bash casts ARE echoed back as `skill_fx {casterId:<selfId>}` — **live proof skill weaving lands**.

### Peco rental — SOLVED (2026-10-04 evening)
- **Healer Mira (n1 @2288,1168)** — the "top-right NPC" (has a `peco-standing` prop @2355,1184; the live map has a 13th NPC "Training Master" npcId 210 the cached copy lacked).
- Dialog: `["เช่า Peco Peco (2,500 z · ต้องมีสกิล Peco Peco Ride)", "คืน Peco Peco", "เช่าเหยี่ยว (2,500 z · Falconry Mastery)", "คืนเหยี่ยว", "ไม่ล่ะ ขอบคุณ"]` — rent = **option index 0, 2,500z, requires the skill**.
- Knight skill-id check: `bowling-bash`, `two-hand-quicken`, `peco-peco-ride`, `peco-peco-master` (also exist: two-hand-sword-mastery, grand-peco-ride/master).

### Pet system (Orc Baby egg) — SOLVED + LIVE
- **Event Lily (n9 @2032,1626)**: option `รับไข่ออร์ค (Base Lv.15 ขึ้นไป, 1 ครั้ง)` → receives **Orc Cub Egg** (once per character, base ≥15).
- Item-action rule (client `useItemBar`): `equipType && !usable ? equip {slot} : inv_use {slot}`. Eggs are **usable → `inv_use {slot}`** — this HATCHES instantly. (`equip` does nothing to eggs — verified: egg stayed in bag.)
- After hatch the server auto-activates: `char.pets = { owned:["orc-cub"], active:"orc-cub" }`.
- `pet_set {petId}` toggles the active pet (null = stow). Collection catalog: `collection` message → `pets[] {id,name,thai,eggItemId,eggName}`.
- Active pet **follows and auto-fetches drops within 15 tiles** (`pet_fetch` events); bags fill faster during farm (sell cycles already handle it).

### Final operator sequence v3 (authoritative, 2026-10-04)
Removed forever: market gem purchase (v2), market DR-affix gear, Broad Sword +4. Added to runner PLAN: `23b-gems-refine-equip` (refine dropped gems to +4 w/ Rough Elunium + equip), `23c-orc-egg` (Event Lily n9 @2032,1626 — free **Orc Baby Egg** at base ≥15, once per character; equip the egg to hatch it), `27-travel-gale`, `28-farm-gale-job27` (4 knight skills need 26 pts ⇒ job 27; operator said "~20"), `29-skills-gale`, `30-peco-rental` (Mira, option 0), `31-frost-farm` (until base 60). Total 33 steps; supervisor runs `--upto 33`. **2026-10-05: `23b-gems-refine-equip` deactivated (no-op stub — gems no longer refined/equipped/hoarded; gems dropped from protection regexes).**

### Economy (funds the potion drain)
- Junk sells at n2 (`ฝากของหน่อย`, sellPrice>0, skip Card/Enchantment types) — goblin_trail drops (Stem / Scream Leaf / Bat Wing / Wolf Pelt / Mandragora Root / Pike…) accumulate fast; one organic sell cycle banked **~14.7k zeny** (305 → 14,992).
- Potion burn is the main cost: auto-drinks at `hpPercent` (75). 38 reds ≈ 5 min of heavy goblin combat → death loop when dry. Restock policy now: buy batches of 45 (budget zeny-200, 50z each) at farm start (when <8 left), after every death recovery (sell junk first if zeny<600), and in bag-full sell cycles.
- SP stays ~max while weaving (regen ≥ bash drain at this level) — SP is not the constraint; potions are.
- Death→refresh→back-in-fight now ≈ 20-60s (graceful leave 0x0c makes rejoin single-try; ghost "already online" retry when a previous process was hard-killed).
