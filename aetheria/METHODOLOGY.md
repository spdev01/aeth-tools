# Aetheria Online — Command-Surface Discovery & Wire-Protocol Methodology

How the complete client→server command surface (**58 send messages / 71 receive events**) was surfaced, decoded, and verified — and how to reproduce the process. Companion docs: `AETHERIA-AUDIT.md` (findings + results), `EVIDENCE-frames.md` (raw captured frames).

---

## 1. The core idea — three sources of truth

| Source | What it gives you | How |
|---|---|---|
| **Client bundle** (static JS) | Every message *name* + payload *shape* | Regex-grep minified code for `send(` / `onMessage(` — wire names are string literals and **survive minification** |
| **Live wiretap** | Real frames, real values, UI→message mapping | Wrap `WebSocket` via `addInitScript`, hex-log both directions |
| **Crafted sends** (injector) | Semantics proven by *physical effect* | msgpack-encode `[0x0d]+type+data`, send on the live socket, observe world reaction |

Never trust any single source: code tells you what exists, capture tells you what's used, crafting proves what it *does*.

---

## 2. Get the client code

```powershell
curl.exe --ssl-no-revoke -o aetheria\index-main.js https://www.aetheria-online.in.th/assets/index-main.js
curl.exe --ssl-no-revoke -o aetheria\index-main.css https://www.aetheria-online.in.th/assets/index-main.css
```

Fingerprint the stack (grep for `colyseus`, `msgpack`, `new Phaser.Game`, `wss://`): **Vite + React 19 + Phaser; Colyseus SDK 0.18 (schema/message-based); msgpack payloads**. The SDK choice dictates the wire format.

Windows notes: `--ssl-no-revoke` is required (schannel revocation check fails); always read files via `[IO.File]::ReadAllText(...)` because PowerShell 5.1 reads BOM-less UTF-8 as ANSI and mojibakes the Thai strings.

## 3. Extract ALL command names (the string-literal trick)

`aetheria/list_msgs.ps1` (verbatim, re-runnable):

```powershell
$c = [IO.File]::ReadAllText('e:\GitHub\lumivaraonline\aetheria\index-main.js')
$sends = [regex]::Matches($c, 'send\(`([^`]{2,40})`') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
$recvs = [regex]::Matches($c, 'onMessage\(`([^`]{2,40})`') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
Write-Output ("SENDS (" + @($sends).Count + "): " + (@($sends) -join ', '))
Write-Output ("RECVS (" + @($recvs).Count + "): " + (@($recvs) -join ', '))
```

Why it works: minified calls look like ``room.send(`move`,{dx:e,dy:t})`` — backtick-delimited protocol names are wire values, so minifiers keep them. The `onMessage` list gives the counterpart events (what success looks like: warp ⇒ `travel`, shop ⇒ `shop`, dialog ⇒ `npc_dialog`, …).

## 4. Payload shapes via context windows

Print ±150 chars around an occurrence; the object literal with parameter names follows immediately:

```powershell
$i = $c.IndexOf('shop_buy')
$c.Substring([Math]::Max(0,$i-140), 300) -replace '[^\u0020-\u007E]','?'
```

Recovered examples (verbatim from the bundle):
- ``buy(e,t){…send(`shop_buy`,{itemId:e,qty:t})}`` / ``sell{…send(`shop_sell`,{slot:e,qty:t})}``
- ``send(`shop_buy_many`,{lines:e})`` / ``send(`shop_sell_many`,{lines:e})``
- ``marketHistory{…send(`market`,{op:`history`,itemId:e,refine:t,range:n})}`` / ``marketTrades(){…send(`market`,{op:`trades`})}``
- ``respawn(e){…send(`respawn`,{to:e})}`` / ``rollGacha(e){…send(`gacha_roll`,{count:e})}``
- ``storage_zeny`` widget: digits-only input + client-side `n<1` guard (good bypass test: crafted sub-1 amounts hit the server directly)
- ground-item sprite handler: ``room.send(`pickup`,{dropId:e})`` (drop entity carries owner/ownUntil fields)
- click-to-cast: ``send(`cast`,{skillId,targetId,x,y})``; target select: ``send(`target`,{targetId})``
- chat: ``send(`chat`,{channel,text})`` (+ `itemSlot` variant; whisper adds `to`)
- Move-tween routine sends `arrived` when a route step completes (client claim, server ignores — see audit §8)

## 5. Wiretap the live socket

Install via `addInitScript` (survives page reloads — which matter, see §12):

```js
const OrigWS = WebSocket;
window.WebSocket = function (...a) {
  const s = new OrigWS(...a);
  window.__lastWS = s;
  s.addEventListener('message', ev => {
    const d = ev.data;
    const u8 = new Uint8Array(d.buffer, d.byteOffset, d.byteLength); // MUST respect offset/length
    window.__frames.push({ dir: 'recv', len: u8.length, hex: hex(u8).slice(0, 400) });
  });
  const origSend = s.send.bind(s);
  s.send = (data) => {
    const u8 = data instanceof ArrayBuffer ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    window.__frames.push({ dir: 'send', len: u8.length, hex: hex(u8).slice(0, 400) });
    return origSend(data);
  };
  return s;
};
window.WebSocket.prototype = OrigWS.prototype;
```

**#1 gotcha:** the Colyseus SDK transmits as `subarray` views into one shared 8192-byte buffer. Slicing `data.buffer` naively corrupts the hex — always `new Uint8Array(buf, byteOffset, byteLength)`. Cap hex length (~400 B) or big state syncs blow up your logs.

## 6. Wire format anatomy (decoded from captures)

| byte | meaning |
|---|---|
| `0x0a` | join (client sends bare `0x0a` first; server replies `0x0a` + reconnect token) |
| `0x0c` | ping (1 byte) |
| `0x0d` | **custom message** = `msgpack(type)` + concatenated `msgpack(data)` |
| `0x0e` | room state sync/patch (msgpack) |

Real captured frame, annotated (this one taught us the 32-px grid):

```
0d                          ← protocol: custom message
a7 6d 6f 76 65 5f 74 6f     ← fixstr(7): "move_to"
82                          ← fixmap(2)
a1 78                       ← "x"
d1 08 d0                    ← uint16 = 2256
a1 79                       ← "y"
d1 09 10                    ← uint16 = 2320
```

2256 = (70+0.5)×32, 2320 = (72+0.5)×32 → target = center of tile (70,72); the character physically walked there. Client computes `(floor(px/32)+0.5)*32`.

Msgpack quick-cheatsheet while reading hex: `00–7f` small positive int, `e0–ff` small negative (e.g. `f8` = −8), `a0–bf` fixstr, `80–8f` fixmap, `d1` uint16, `d2` uint32, `d3` uint64, `cb` float64. (The client's own encoder uses msgpackr record extensions `d4 72 <id>` — but the server accepts **standard msgpack**; only BigInt (>2⁵³) and NaN/Infinity need special encoding in your injector.)

## 7. UI → frame correlation

Keep the send-log running, do **one** action in the UI, diff the log:

| UI action | Message observed |
|---|---|
| walk (key/click) | `move{dx,dy}` ~10 Hz, small ints |
| click spot on map | `move_to{x,y}` (px, tile-center grid) |
| channel picker (footer "CH n ▾") | `channel_list` → recv `channels`; pick → `channel_switch{channel}` |
| click NPC | `npc_talk{npcKey}` → recv `npc_dialog` → option click = `npc_option{index}` |
| click monster / hotbar skill | `target{targetId}`, `cast{skillId,targetId,x,y}` (no separate "attack" message exists — basic attacks ride the cast path) |
| click ground drop | `pickup{dropId}` |
| open shop / storage / market windows | recv `shop` / `storage` / `market_open` (state context created server-side) |

Client throttles (move_to ≥120 ms & ≥16 px; stat-preview 120 ms debounce) are **client-side only** — server limits must be probed separately with crafted frames.

## 8. Injector & verification by effect

```js
window.__inject = (type, data) => {
  const bytes = [0x0d, ...__mpEnc(type), ...(data === undefined ? [] : __mpEnc(data))];
  window.__lastWS.send(new Uint8Array(bytes));
};
```

Verification examples (semantics proven physically, not from code):
- `move_to{2256,2320}` → character walked exactly to tile (70,72). Round-trip proven.
- `channel_switch{channel:2}` → broadcast + footer "CH 2"; invalid values rejected with cooldown text.
- `move{dx:1000}` → walked (intent semantics), no teleport → led to full speed-limit sweep (§8 of audit).

Canary warning: `boss_list` does **not** reliably respond (an early "1.5 KB reply" was a misattributed state-sync). Use movement for liveness: small `move_to` hop → footer tile must change.

## 9. Full catalogue (verified extraction output)

**SENDS (58):** arena, arrived, auto_set, boss_list, card_insert, card_remove, cast, channel_list, channel_switch, chat, collection_register, enchant, enchant_choose, equip, exchange, friend, gacha_roll, guide_skip, guild, hotbar_set, inv_destroy, inv_move, inv_sort, inv_use, item_info, itembar_set, mail, market, move, move_to, npc_close, npc_option, npc_talk, npc_warp, party, pet_set, pickup, plagiarism, refine, respawn, shop_buy, shop_buy_many, shop_sell, shop_sell_many, skill_facet, skill_up, socket_drill, stat_preview, stat_up, storage_move, storage_put, storage_sort, storage_take, storage_zeny, target, trade, unequip, view

**RECVS (71):** alert, arena_match, arena_open, arena_status, boss_cast, boss_fx, boss_list, boss_mvp, boss_reward, card_removal, card_removal_result, cast, center_notice, channels, character, chat, collection, death, died, dps_meter, enchant_result, exchange, exp_gain, force_logout, friends, gacha, gacha_result, guild, hit, inventory, invite, item_fx, item_gain, item_info, item_used, levelup, mailbox, market_badge, market_changed, market_done, market_history, market_mine, market_open, market_results, market_trades, npc_close, npc_dialog, party, party_board, party_follow, party_route, party_summon, pet_fetch, plagiarism, refine, refine_fx, refine_result, respawned, server_notice, shop, skill_catalog, skill_fx, socket, socket_result, stat_preview, storage, target_clear, topup, trade, travel, warp_menu

## 10. Command-by-command: how each was found + live-verification status

| Goal | Message(s) | Payload | Discovery | Live-verified |
|---|---|---|---|---|
| Move | `move`, `move_to`, `arrived` | intents `{dx,dy}` / px target `{x,y}` / — | regex + walk capture + footer correlation + crafted sweeps | ✅ deep (fixed-speed intent, no teleport) |
| Change server/channel | `channel_switch` (`channel_list`/`channels` for the picker) | `{channel:N}` | regex + UI capture + footer + crafted rejections | ✅ (whitelist, ~10 s cooldown) |
| Attack monster | `target`, `cast` (+`auto_set`, `skill_up`) | ids from state/UI | regex contexts (`castAim`, `selectTarget`) + recv `cast/hit/skill_fx` to confirm | ⚠️ catalogued; gated at Lv1 (silent no-ops) |
| Warp to map | `npc_warp{mapId}` (world-map UI / NPC menu) | mapIds from `/world/atlas` | regex + atlas cross-check | ⚠️ crafted = inert (context-gated) |
| Warp via NPC | `npc_talk` → `npc_dialog` → `npc_option` (server may emit `npc_warp`) | npcKey from click capture; option index | regex + click capture | ⚠️ flow mapped; execution gated |
| Pick up items | `pickup{dropId}` | dropId from state entity | regex (sprite handler) | ⚠️ no drops in safe zone |
| Class change | NPC dialog chain (Job Master) — no bespoke message | — | atlas NPC roster + patch notes | ❌ not performed (gated) |
| Sell items | `shop_sell`, `shop_sell_many{lines}` | `{slot,qty}` | regex | ❌ needs open-shop context |
| Buy items | `shop_buy`, `shop_buy_many{lines}` | `{itemId,qty}` | regex | ❌ needs open-shop context |
| Storage | `storage_put/take/move/sort`, `storage_zeny{action,amount}` | slots/qty; zeny guarded client-side | regex (drag-drop handlers, zeny widget) | ❌ needs storage context |

## 11. Recipe for mapping any remaining action

1. Wiretap on, clear-ish log; 2. perform the action once through the UI; 3. diff sends → find the new message (+ payload keys); 4. watch recvs → confirm counterpart event; 5. replay via `__inject` with mutated values (bounds, negatives, wrong types, oversize); 6. prove effect/failure physically; 7. document payload + result.

## 12. Gotchas & safety rules

- Colyseus subarray frames → always slice with `byteOffset/byteLength`.
- Guest sessions rotate every few minutes (auto page reload + rejoin; new sessionId/host/channel). In-page tooling resets — re-install via `addInitScript`; re-verify liveness before trusting "silent" results.
- PS 5.1: write `.ps1` files (multi-line paste garbles); read via `[IO.File]::ReadAllText`; strip non-ASCII before printing.
- In-page `.click()` often misses React handlers — use real tool clicks / `{force:true}`.
- Server-side validation must be probed with crafted frames; client guards (qty clamps, digits-only inputs) hide server behavior.
- **Safety on live rooms:** no malformed-msgpack fuzzing (decoder-throw risk = possible room impact — staging only), no negative counts on loop-prone fields (`gacha_roll`, `*_many` `lines`), stop on any positive, self-accounts only.

## 13. Artifact index

| File | Purpose |
|---|---|
| `aetheria/index-main.js` | The client bundle (2.66 MB) — all regex work targets this |
| `aetheria/list_msgs.ps1` | Full command-catalogue extractor (§3) |
| `aetheria/ctx_probe.ps1` / `ctx_probe2.ps1` | Payload-shape context windows (§4) |
| `aetheria/scan1–5.ps1` | Early endpoint/keyword scans (auth, world, assets) |
| `aetheria/world_atlas.json` | Public map graph: mapIds, NPCs, connections |
| `aetheria/patch_notes.json`, `auth_config.json`, `world_events.json` | Public API data (cross-validation of ids/keys) |
| `AETHERIA-AUDIT.md` | Findings: Phase 1 passive + §7–8 live results |
| `EVIDENCE-frames.md` | Raw frame captures + probe logs |
