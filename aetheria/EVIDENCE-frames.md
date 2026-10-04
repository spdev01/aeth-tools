# Aetheria Online — active probe evidence (2026-10-04)

Session: guest → character `ReconAether` (Novice Lv1), capital CH1.
Endpoint: `wss://g5.aetheria-online.in.th/<roomId>/<processId>?sessionId=cerEsxcSZ&skipHandshake=1`

## Wire format (verified)
- `[0x0d]` + msgpack(typeString) + msgpack(data)  — client⇄server custom message
- `0x0a` join / `0x0c` ping / `0x0e` state sync
- Server decoder accepts standard msgpack (msgpackr record ext `d4 72 <id>` used by the client's own encoder; not required by the server).

## Proven round-trips
1. `boss_list` (no data) → server replied 1509-byte boss payload:
   recv hex head: `0d a9 62 6f 73 73 5f 6c 69 73 74 9? ...`  (`0d` ["boss_list"] {…})
2. `move_to {x:2256,y:2320}` send:
   `0d a7 6d 6f 76 65 5f 74 6f 82 a1 78 d1 08 d0 a1 79 d1 09 10`
   → character physically walked 67,72 → 70,72 (path simulated server-side; ~1s walked, from 120ms client throttle ≈ 8 tiles). `move_to` is grid-aligned: `(floor(px/32)+.5)*32`.
3. `channel_switch {channel:20}` → server broadcast `ReconAether เข้าสู่ เมืองหลวงโซลเฮเวน CH 20`; footer changed CH1→CH20.

## Rejections observed (no effect, no crash)
- `move_to {x:'2160'}` / `{x:NaN}` → ignored.
- `move_to {x:2147483647}` / `{x:1e308}` → clamped to walkable bound; char walked (no teleport).
- `move_to` into blocked area → Thai system line `ไปตรงนั้นไม่ได้`.
- `channel_switch`: `0`,`-1`,`999`,`2147483647` → all rejected; cooldown message `เปลี่ยน channel ได้อีกใน N วินาที`.
- `npc_warp`: `novice_garden`,`frost_pass`,`moon_forest`,`''`,`123`,`null`,`zz-nowhere` → all silently ignored at Lv1 (context/level gated).
- `stat_preview {add:{str:1}}` + `stat_up`: `1`(legit),`-1`,`0`,`1000`,`2^31`, invalid stat → all ignored (still 48 pts).
- `cast`: `bash`(unlearned),`-1`,`2^31`,`zz-no-such-skill`,`null` → all ignored (no `skill_fx`).
- `skill_up`: `bash`,`-5` → ignored.
- `guide_skip` → no observable effect at this stage.

## Status snapshot
Footer format: `CH 1 ▾ เมืองหลวงโซลเฮเวน 71, 68` (channel / map / tileX,tileY). HP 132/132 SP 42/42, 48 stat points. World map: 25 zones; capital connects to novice_garden Lv1–3, east meadow Lv1–5, clover field Lv1–5, crystal mine Lv18–28 (access likely level/guide-gated — not reproduced at Lv1).

---

# Phase 2b additions (deep sweep)

## `move{dx,dy}` walk-intent (no teleport / no speed hack)
- Single `move{dy:-64}` from (72,68): samples y = 66 @0.4s → 64 @0.8s → 60 @1.6s → 53 @2.8s → 46 @4.0s (continuous walk ≈5.5 t/s). Then `move{0,0}` → y=45, frozen (clean stop).
- Speed sweep, single message per trial (mag → tiles/s): 8→5.0, 32→5.0, 64→5.0, 128→4.5, 256→5.0, 500→5.5, 1000→5.0. Magnitude ignored, no rejections.
- Natural streams: 10 Hz × `dy:-8` → ≥3.3 t/s (wall-limited), 20 Hz → ≥4.1 t/s (wall-limited). Crafted singles ≈ same server speed → no speed advantage.
- Wall behavior: east from (72,68) blocked at x=72; north blocked at y≈35 on that column; 12 s run north at wall = 0 movement (not a rejection).

## `arrived` mid-walk (route-arriver claim)
- `move_to` (72,35)→(72,43) + `arrived` after 200 ms: y = 37 @0.7s → 43 @1.8s → 43 @3.0s. Full walk completed at normal speed, stopped at target. No snap/cancel/speedup.

## `respawn{to}` while alive
- `{to:'save'}`, `{to:'capital'}`, `{to:'frost_pass'}` → silent, no movement, no frames. (Destination validation while dead still untested — needs a mob map.)

## Economy ops on live socket (12×, ~14 frames/s incoming traffic)
- All zero-frame, zero-state-change: shop_buy{1,1} / {1,0}; storage_zeny{in,-1} / {in,9007199254740992}; market{history} / {trades}; gacha_roll{0} / {1}; exchange{shop_buy,1}; inv_move{0→1}; inv_use{0}; inv_destroy{0}.
- Client-side guards confirmed in bundle: storage zeny input is digits-only + `n<1` guard; shop qty clamp exists client-side → crafted raw values bypass those and still no-effect ⇒ server-side gating.

## Robustness
- Unknown type string, type=123, type=null, 60 KB junk field, 200× flood of `npc_close` → no frames, no error, no change; movement still works after.
- `boss_list` does NOT reliably respond (old "1.5 KB reply" = likely state-sync misattribution). Use movement-based canaries.

## Session rotation events (platform, not exploit)
- URLs observed: `g5 …/oclAv8L0K/rJNrKRgUm?sessionId=cerEsxcSZ` → `g4 …/THNhZylOB/V5NbBeffG?sessionId=LefX8_MkP` (CH3) → `g4 …/THNhZylOB/Josf-BTiL?sessionId=R6xR9ok0-` (CH15).
- Each rotation: page reloads (in-page arrays reset), new guest session, auto-rejoin; one occurred during idle (no crafted traffic). Recovery <~15 s, state intact.

## Chat XSS
- Whisper-to-self `<b>eq</b><img src=x onerror=window.__xss=1>`: rendered as literal text (no b/img elements, `__xss`=0) → escaped, no XSS observed.
