# ROVA Wiki — drop EV calculator

Standalone tool for **ROVA ONLINE** that answers one question per monster:
**how much zeny is one kill worth in NPC sell value?**

```
EV(monster) = Σ  (drop chance × NPC sell price of the dropped item)
```

- **Per-monster EV** over the game's real drop tables (regular drops, MVP bonus drops and special map-limited drops).
- **Category toggles** — include/exclude Weapons, Armor, Cards, Healing, Usable, Materials, Ammo, Pet Eggs, Pet Armor.
  Presets: `All` / `None` / `No cards` / `Gear only` / `Vendor loot`.
- **Drop class toggles** — regular / MVP / special drops.
- **Monster filters** - level range, aggressiveness, and DEF / MDEF / HIT / FLEE ranges (shared with the Maps tab),
  plus bosses-only, exclude-bosses, has-spawns and a map filter on the monster list.
- **Items browser** - sell/buy price, weight, where it drops (per monster with chance), which shops sell it, quest rewards, boxes.
- **Maps browser** - spawn counts, respawn timers, spawn-weighted average EV/kill per map. The same monster filters apply
  to the map calculation, and an **Exclude bosses** switch (on by default) keeps boss EV out of the averages. Great for picking a farm spot.
- **CSV export** of the current monster list with EV breakdowns.
- Search, level range, boss filters, map filter. Settings persist in localStorage.

All prices are the game's own NPC sell prices (`native_items`), all drop rates and spawn data come from the
game's official wiki feed. Nothing is estimated.

## Quick start

```powershell
cd rova-wiki
node tools/serve.mjs        # then open http://127.0.0.1:4321/
```

The built database (`public/data/rova-db.json`) is committed, so serving works right away.

## Refreshing the data (after a game update)

```powershell
cd rova-wiki
node tools/fetch-all.mjs    # downloads raw data through Tor (see below)
node tools/build-db.mjs     # joins everything into public/data/rova-db.json
```

`fetch-all.mjs` reuses the guest session at `rova/recon/dev/dev-session.json`;
if `/api/wiki/full` returns 401, mint a fresh guest first:

```powershell
node rova/tools/dev-connect.mjs --stay 5
```

### Icons

Item icons are loaded from the game's public UI assets (`rovaonline.net/pub/ui/...`) while you browse.
To make the tool fully offline, mirror all 2310 icons locally once (through Tor):

```powershell
node tools/fetch-icons.mjs
```

The UI automatically switches to `public/icons/` when the mirror manifest exists.

## Data sources (all fetched through Tor by `tools/fetch-all.mjs`)

| Data | Source |
| --- | --- |
| Monster drops + rates, MVP/special tables, spawns, shops, quests | `rovaonline.net/api/wiki/full` (guest session) |
| Item names, types, NPC sell prices, weights | `rovaonline.net/content/client.json` (`runtime_profile110.native_items`) |
| Item display names + monster/map names | `rovaonline.net/content/locales/{en,th}.json` |
| Item effect facts (heal etc.) | `rovaonline.net/content/item_facts.json` |
| Item icons | `rovaonline.net/content/item_icons.json` + `pub/ui/` assets |

Drop chances are per-kill out of 10,000 (72.00% = 7200). Each drop rolls independently, so EV is a plain sum.
If the drop chances ever look 2-3x off after a game update, refresh the data — the server can adjust rates without a client build.

## Tor-only note

Per the repo-wide invariant, every **fetch** tool here rides a Tor circuit
(`rova/tools/tor-net.mjs` → `rova-http.mjs`). `node rova/tools/audit-tor-only.mjs` covers this folder too and must PASS.
The web UI itself only talks to the local server (plus optional static icon loads while browsing, like the official wiki page does).

## Layout

```
rova-wiki/
  tools/
    fetch-all.mjs    fetch raw data via Tor        -> data/raw/
    build-db.mjs     join + validate               -> public/data/rova-db.json
    fetch-icons.mjs  optional icon mirror (Tor)    -> public/icons/
    serve.mjs        local static server (port 4321)
  data/raw/          raw downloads (gitignored)
  public/            the web app (index.html, style.css, js/, data/, icons/)
```
