# Aetheria Online — Game Protocol Reference

> Discovery log & source of truth for bot/command-center development.
> Last updated: 2026-10-05. Maintained alongside `testbot/` + `command-center/`.

---

## 1. Discovery sources (how this was obtained)

| Artifact | Location | Notes |
|---|---|---|
| Game SPA page | `aetheria/recon/play.html` | HTML shell of https://www.aetheria-online.in.th/play |
| **Game client bundle** | `aetheria/recon/asset1.js` | `https://www.aetheria-online.in.th/assets/index-Cw1u9ANm.js` (2.7 MB, **hash changes on game updates — re-download from /play**) |
| Wiki HTML shell | `aetheria/recon/wiki.html` | same SPA, client-routed |
| **Wiki data dump** | `aetheria/recon/wiki-data.json` | `GET https://www.aetheria-online.in.th/wiki-data` (1.2 MB) |

### Re-mining recipes (PowerShell, after re-downloading the bundle)

```powershell
$c = [IO.File]::ReadAllText("e:\GitHub\lumivaraonline\aetheria\recon\asset1.js")
# all client->server command names:
[regex]::Matches($c,'\.send\(\x60([a-z_0-9]+)\x60') | %{$_.Groups[1].Value} | Sort-Object -Unique
# all server->client messages:
[regex]::Matches($c,'onMessage\(\x60([a-z_0-9]+)\x60') | %{$_.Groups[1].Value} | Sort-Object -Unique
# all REST endpoints:
[regex]::Matches($c,'fetch\(\x60([^\x60]+)\x60') | %{$_.Groups[1].Value} | Sort-Object -Unique
# context extraction around any token:
$i = $c.IndexOf('storage_put'); $c.Substring([Math]::Max(0,$i-400), 900)
```
(`\x60` = backtick; the bundle is minified with backtick templates.)

---

## 2. Transport basics (verified by our implementation)

- **REST** (https://www.aetheria-online.in.th):
  - `POST /auth/register {userId,password}` → `{token}` — fast (~260 ms); rate-limits bursts (`429 {"error":"ลองมากเกินไป..."}`)
  - `POST /auth/login {userId,password}` → `{token}` — JWT ~12 h TTL
  - `GET /characters` (Bearer token), `POST /characters {name}`, `POST /characters/{id}/kick`, `/delete`, `/undelete`
  - `POST /world/enter` → matchmake/joinById flow → `{endpoint, processId, roomId, sessionId}`
- **Gameplay WS**: `wss://<endpoint>/<processId>/<roomId>?sessionId=...`
  - client→server frame: `[0x0d]` + msgpack(type) + msgpack(data)
  - graceful leave: `[0x0c]` (avoids "already online" ghost; ghost auto-expires ~40–60 s)
  - **travel**: server pushes `travel {ticket, roomId, endpoint}` → close WS → connect to new endpoint (code 4000 close is normal)
- **Ghost state**: forcible disconnect leaves character "online" server-side (`world/enter failed: "ตัวละครในบัญชีนี้อยู่ในแล้ว"`). Wait 40–60 s or use `POST /characters/{id}/kick`.

### Public REST endpoints (no auth)
| Endpoint | Returns |
|---|---|
| `GET /world/online` | `{"online":2196}` — global count |
| `GET /wiki-data` | full wiki JSON (see §7) |
| `GET /wiki-data/raw?target=<t>&id=<n>` | raw wiki entry |
| `GET /patch-notes`, `GET /world/events`, `GET /version.json`, `GET /auth/config` | misc metadata |

### Other REST endpoints found in bundle (auth as needed)
`/auth/guest`, `/auth/upgrade`, `/auth/upgrade-google`, `/world/atlas`, `/world/economy`, `/world/client-error`, `/maps/{id}.json`, `/sprites/...`, `/art/{classes,icons,monsters,skills}/manifest.json`, `/classes`, `/admin-data/*` (account, economy, monster, topup, transactions — CMS side).

---

## 3. Client → Server commands (complete inventory from bundle)

```
arena                arrived              auto_set           boss_list
card_insert          card_remove          cast               channel_list
channel_switch       chat                 collection_register enchant
enchant_choose       equip                exchange           friend
gacha_roll           guide_skip           guild              hotbar_set
inspect              inspect_privacy      inv_destroy        inv_move
inv_sort             inv_use              item_info          itembar_set
mail                 market               move               move_to
npc_close            npc_option           npc_talk           npc_warp
party                pet_set              pickup             plagiarism
refine               respawn              shop_buy           shop_buy_many
shop_sell            shop_sell_many       skill_facet        skill_up
socket_drill         stat_preview         stat_up            storage_move
storage_put          storage_sort         storage_take       storage_zeny
target               trade                unequip            view
```

Notable payload shapes (from call sites):
| Command | Payload | Notes |
|---|---|---|
| `auto_set` | full auto-combat config | `{skills, huntRadiusTiles, monsters, hpItems, hpPercent, spPercent, pickupLoot, ...}` — our runner normalizes skill ids to strings |
| `cast` | `{skillId, targetId}` | also used for crafting: `{skillId, recipeId, qty}` |
| `move_to` | `{x, y}` | |
| `target` | `{targetId}` | |
| `respawn` | `{to}` | `'save'` = save point |
| `npc_talk` / `npc_option` / `npc_close` | `{npcKey}` / `{index}` / `{}` | |
| `npc_warp` | `{mapId}` | warp via NPC menu |
| `shop_buy` / `shop_sell` | `{itemId, qty}` / `{slot, qty}` | |
| `shop_buy_many` / `shop_sell_many` | `{lines: [...]}` | batch variant |
| `inv_use` | `{slot}` | eggs hatch, potions drink |
| `inv_sort` / `inv_move` / `inv_destroy` | `{...}` / `{...}` | |
| `refine` | `{source, blessing}` | |
| `pet_set` | `{petId}` | |
| `equip` / `unequip` | `{slot}` / `{slot}` | |
| `mail` | `{op, id}` | |
| `party` / `guild` / `friend` / `chat` | op-based | |
| `channel_list` | `{}` | poll (client polls every 3 s while picker open) |
| `channel_switch` | `{channel}` | see §5 |
| `trade` | `{action, ...}` | see §4 |
| `storage_put` | `{slot, qty}` | slot = **inventory** slot → deposit |
| `storage_take` | `{slot, qty}` | slot = **storage** slot → withdraw |
| `storage_move` | `{from, to}` | within storage |
| `storage_sort` | `{}` | |
| `storage_zeny` | `{action:'deposit'\|'withdraw', amount}` | |

**Storage quirks (verified live 2026-10-05)**:
- NPC: `n6` "Alice Service" (kafra), capital (1808,1616); dialog option matching 'คลัง' opens storage (`storage` msg {slots:300, items, zeny}).
- **Event items (e.g. "Event Red Potion") are NOT depositable** — `storage_put` silently no-ops. A deposit loop must skip an item after 1-2 failed attempts or it stalls on the first item forever.
- Success signal for a put: **storage total qty increased OR inventory stack shrank** (item-count alone is unreliable — identical itemIds merge into one storage stack, so `items.length` may stay flat while qty grows).

---

## 4. Trade protocol (player↔player) — decoded

**Actions** (all via `trade` command):
| Action | Payload | Meaning |
|---|---|---|
| `request` | `{action:'request', name:'<charName>'}` | invite by **character name** (not id!) |
| `offer` | `{action:'offer', items:[{slot,qty},...], zeny:<n>}` | replaces your offer (send the full desired list) |
| `lock` | `{action:'lock'}` | lock your offered side ("ล็อกของที่เสนอ") |
| `confirm` | `{action:'confirm'}` | confirm (enabled when both sides locked) |
| `cancel` | `{action:'cancel'}` | abort |
| accept / decline | via **invite answer**: on `invite {kind:'trade'}` → `trade {action:'accept'}` or `{action:'decline'}` | generic invite pattern: `send(kind, {action})` |

**Server → client**: `trade` message = window state (VERIFIED live 2026-10-05):
`{ partner:'<name>', mine: {zeny, locked, confirmed, items:[{slot,qty,item}]}, theirs: {…}, expiresAt:<ts> }`
When the trade completes the server sends a `trade` message with the window cleared (mine/theirs null) — use that to detect round end.

**Limits & semantics**:
- Max **10 item stacks per side** per trade (`s.items.length >= 10` guard) — VERIFIED (offer 10/10 applied each round).
- Offer is a full-list replace; send the complete desired list each time.
- Both sides: offer → lock → (both locked) → confirm → server clears window = done.
- Timer: window has a countdown (`expiresAt`) — don't idle mid-trade.
- No distance check noted client-side — still, walk to the partner before requesting.
- **No zeny field appeared in per-round state logs when z=0**; `offer` accepts `zeny` alongside items (send with the offer).

**Verified full-drain loop (bot → collector, live-tested)**:
1. donor: `trade{action:'request', name}` → wait `trade` msg with `partner` set
2. donor: `trade{action:'offer', items:[{slot,qty}×≤10], zeny}` → wait `mine.items` populated
3. donor: `trade{action:'lock'}` → wait `mine.locked===true`; collector: lock side mirror
4. when **both** `mine.locked && theirs.locked` → both send `trade{action:'confirm'}`; wait for cleared window
5. repeat rounds until inventory drained (observed: 9 rounds / 61 stacks / 110 s; 10 stacks per round)
Collector side auto-loop: on `invite{kind:'trade'}` → `trade{action:'accept'}` → offer (empty ok) → lock → confirm when both locked.

---

## 5. Channel protocol — decoded

- Client sends `channel_list` (poll ~every 3 s while picker open).
- Server replies `channels` message:
  ```
  { current: <n>, hardCap: <n>, softCap: <n>, cooldownUntil?: <ts>,
    channels: [ { channel: <n>, players: <n> }, ... ] }
  ```
- Switch: `channel_switch {channel}` — disabled client-side for: current channel, `players >= hardCap` (เต็ม), and during `cooldownUntil` countdown (cooldown shown in seconds).
- **VERIFIED live 2026-10-05: `channel_switch` does NOT switch in place.** The server replies with a **`travel` message for the SAME map** (new ticket, new `roomId`, ticket carries `channelSwitchAt`):
  ```
  {mapId:'capital', ticket:'eyJ…(JWT scope:travel, channelSwitchAt)…', roomId:'p9t1fh-Bo', displayName:'…'}
  ```
  The client must then **leaveGraceful + rejoin the new room** (same flow as map travel: matchmake joinById → connect → join frame). Only after the rejoin does `channels` report the new `current`. Ignoring the travel message = switch silently never happens.
- Reference implementation: `runner.js switchToChannel()` — send switch → wait for fresh `travel` with `mapId === current map` → `rejoinRoom(travel)` → re-poll `channels` to confirm.
- **Least-populated selection** = `channels` entry with min `players` (respect hardCap & cooldown).
- Traveling between maps may carry you to a different channel → re-check `current` after travels.

## 5b. Server → Client messages (complete inventory)

```
alert arena_match arena_open arena_status b boss_cast boss_fx boss_list boss_mvp
boss_reward card_removal card_removal_result cast center_notice channels character
chat collection death died dps_meter enchant_result exchange exp_gain force_logout
friends gacha gacha_result guild hit inspect_view inventory invite item_fx item_gain
item_info item_used levelup mailbox market_badge market_changed market_done
market_history market_mine market_open market_outbid market_results market_trades
npc_close npc_dialog party party_board party_follow party_route party_summon
pet_fetch plagiarism refine refine_fx refine_result respawned server_notice shop
skill_catalog skill_fx socket socket_result stat_preview storage target_clear topup
trade travel warp_menu
```

---

## 6. Storage (คลังเก็บของ) — decoded

- Window state arrives as `storage` message: `{ slots, items:[{slot, itemId, name, qty, refine?, ...}], zeny, ... }` (storage slots separate from inventory; client renders inventory+storage side-by-side for drag).
- Deposit item from inventory: `storage_put {slot:<inventory slot>, qty}`
- Withdraw to inventory: `storage_take {slot:<storage slot>, qty}`
- Reorder: `storage_move {from, to}`; tidy: `storage_sort {}`
- Zeny: `storage_zeny {action:'deposit'|'withdraw', amount}` (UI: ฝาก / ถอน / ฝากหมด=deposit-all)
- **Opening storage**: via NPC dialog option (server-driven; the option's label opens it — discover empirically per NPC: talk → log options → pick the storage keyword, e.g. คลัง/ฝากของ). TODO: record NPC key + coordinates once verified.

---

## 7. Wiki data schema (`GET /wiki-data`)

Top level: `{ generatedAt, items[779], monsters[58], elements{list}, ragnarokItems[1026], classes[33], skills[137], maps[27] }`

- **items[]** sample fields: `id, name, type (Consumable|Equipment|Enchantment|Card|Life|Miscellaneous), equipmentType, weaponType, maxStack, sellPrice, weight, slots, refineable, rarity, droppedBy[], soldBy[{shop, npcs[], price}], uses[], attributes[]`
- **monsters[]**: 58 entries (fields TBD)
- **maps[]**: `{ id, name(Thai), spawns[] }` — ids include: `capital, frost_pass, gale_high, goblin_trail, novice_garden, sun_farm, willow_road, crystal_mine, field_01, clover_meadow, orc_camp, molten_core, coral_coast, anc_ruins, caravan_market, ember_cavern, azure_lake, scorch_dunes, blight_mire, abyss_cathedral, moon_forest, sunken_pyramid, shadow_crypt, venom_swamp, training_room, arena, verdant_basin`
- **ragnarokItems[]**: 1026 classic-RO reference items (id mapping/bridge)

Note: Thai strings in JSON are UTF-8; read with `[Text.Encoding]::UTF8` in PowerShell 5.1.

---

## 8. Errand/route reference (capital ⇄ farm)

capital → novice_garden → sun_farm → willow_road → gale_high → frost_pass (and reverse). Used by restock/death-recovery/deploy flows; a "traveling · novice_garden" activity badge on a knight merely means it's passing through.

---

## 9. Known gameplay quirks (from our runner experience)

- Server auto-skill engine never casts → our bot does manual **weave** casts (`cast` at mobs).
- Potions auto-drink only if item ids are in `auto_set` config `hpItems`.
- Eggs are hatched via `inv_use` (equip does nothing).
- `respawn` requires a fresh session (same-session `auto_set` refused after death → full reconnect).
- Peco rental: Healer Mira, capital n1 (2288, 1168), option 0, 2500 z (requires Peco Peco Ride skill).
- `world/enter` error "ตัวละครในบัญชีนี้อยู่ในแล้ว" = character still marked online (wait or `/characters/{id}/kick`).

---

## 10. Changelog

- **2026-10-05** — Initial document. Full command/message/endpoint inventory mined from bundle `index-Cw1u9ANm.js`; trade, channel, storage protocols decoded; wiki-data schema + dump saved; `/world/online` + kick endpoint noted.
