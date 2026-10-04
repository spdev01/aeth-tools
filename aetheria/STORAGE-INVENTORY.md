# Aetheria — Storage & Inventory flow (mapped live, 2026-10-04)

All gameplay via WebSocket room messages (`room.send`). No REST involved after entering the world.

## TL;DR — command map

| Action | Send | Payload | Server pushes back |
|---|---|---|---|
| Open an NPC dialog | `npc_talk` | `{npcKey:'n6'}` | `npc_dialog` |
| Pick an option | `npc_option` | `{index:2}` (0-based!) | `storage` (window opens; fee ~40z) |
| Refresh backpack list | `inv_sort` | `{}` | `inventory` |
| STORE item (bag→storage) | `storage_put` | `{slot:<BAG slot>, qty:<n>}` | fresh `storage` + `inventory` |
| RETRIEVE item (storage→bag) | `storage_take` | `{slot:<STORAGE slot>, qty:<n>}` | fresh `storage` + `inventory` |
| Rearrange inside storage | `storage_move` | `{from:<slot>, to:<slot>}` | `storage` |

## 1) How to open the storage (full sequence, verified)

1. **Walk within a few tiles of Alice Service** (fountain, capital). ⚠️ `npc_talk` is **proximity-gated** — out of range it is silently ignored (verified: silent at ~10 tiles, works at ≤2).
2. Send `npc_talk {npcKey:'n6'}` → server replies
   `npc_dialog = {npcKey:'n6', name:'Alice Service', art:'npc/kafra', text:'ยินดีต้อนรับ…', options:[7 strings]}`
3. Send `npc_option {index:2}` → server replies `storage` and the client opens the storage window (`.storage-window`).

### Alice's option list (0-based index — the payload uses the array index!)
| idx | option | meaning |
|---|---|---|
| 0 | บันทึกจุดเกิดที่นี่ | save respawn point |
| 1 | วาร์ป (เลือกจากแผนที่โลก) | warp via world map |
| **2** | **เปิดคลังเก็บของ (40 z)** | **open storage (choice 3 in UI)** |
| 3 | ขอรักษาหน่อย (ฟรี) | heal (free) |
| 4 | รีเซ็ตสเตตัส (10,000 z) | reset stats |
| 5 | รีเซ็ตสกิล (10,000 z) | reset skills |
| 6 | ไม่ล่ะ ขอบคุณ | close |

## 2) How to get the backpack item list (wire)

- Trigger a refresh: `inv_sort {}` → server pushes `inventory` (any inventory change also pushes it automatically).
- Payload: `{slots:100, weight:268, weightLimit:2030, items:[…]}` — each item:
  `{slot, itemId, name, type, weight, sellPrice, effects[], autoPotion, qty, maxStack, usable, destroyable}`
- Current bag at capture time: `slot 0 Carrot x4`, `slot 1 Event Red Potion x199`, `slot 2 Butterfly Wing x20`.
- `slot` = **bag slot index** — that's exactly what `storage_put` takes.
- Storage payload: `{slots:300, feeZeny, items:[…], zeny:<balance>}` — `storage.items[]` same item shape; `slot` = storage slot index (used by `storage_take`).

## 3) Store / retrieve — verified round trip (actual observed log)

```
talk n6                       → dialog options captured
npc_option {index:2}          → storage {slots:300, items:[]}
storage_put {slot:0, qty:1}   → storage: [Carrot x1 @ slot 0]   bag: Carrot 4→3
storage_take {slot:0, qty:1}  → storage: []                     bag: Carrot back to 4 ✓
```
No errors, no desync; the server pushes fresh `inventory`+`storage` after every mutation — never guess local state.

## 4) Notes for the headless test client

- Everything above = `room.send('storage_put', {slot, qty})` etc. — directly usable with colyseus.js.
- **Re-read `inventory.items[].slot` after every mutation** (slot layout can shift).
- Storage fee (~40z) is charged per open; balance comes in `storage.zeny`; fee field `storage.feeZeny`.
- NPC keys are short (`n6` = Alice). Capital keys follow the NPC list order in the join state (`n1..n12`). Verified: `n4`=Armorer Hilda, `n6`=Alice Service, `n11`=Phoenix Egg Lucky, `n12`=Auger Socket.
- Dialog options are plain strings; pick by array index (`npc_option {index:i}`), choosing by label = match string then index.

## 5) Relevant message names (from the 58-command catalogue)
`sends: npc_talk, npc_option, npc_close, inv_sort, storage_put, storage_take, storage_move, storage_sort`
`recvs: npc_dialog, storage, inventory, item_gain, item_used, item_info`
