# Aetheria Market+ (ตลาด+) — v0.2.1

Adds **ability-aware market search** (innate `attributes` + rolled `affixes`) and
**direct buy** to the in-game market (ตลาดกลาง) at `https://www.aetheria-online.in.th/play`.

**Supported targets: Chrome / Edge and Zen / Firefox.**

## Install (pick one per browser)

### A. Chrome / Edge — extension (recommended)

1. Download/unzip **`dist/aetheria-market-plus-chrome.zip`** (or use the unpacked
   folder **`dist/chrome/`** directly).
2. Open `chrome://extensions` → enable **Developer mode** (top-right).
3. Click **Load unpacked** → select the `chrome` folder (with `manifest.json` inside).
4. Open the game — the gold **“ตลาด+ ค้นหาละเอียด”** button appears above the footer.

> For wide distribution later: publish to the Chrome Web Store (same package), or
> keep Load-unpacked for a pilot group.

### B. Zen / Firefox — extension (recommended)

**Quick way (temporary, resets on browser restart):**

1. Open **`about:debugging#/runtime/this-firefox`**.
2. Click **Load Temporary Add-on…** → select **`dist/firefox/manifest.json`**.
3. Open the game — button appears.

**Persistent way (for real users):** sign the Firefox package:

```bash
npx web-ext sign --source-dir dist/firefox --api-key <AMO_KEY> --api-secret <AMO_SECRET> --channel unlisted
```

This produces a signed `.xpi` (unlisted on addons.mozilla.org) that anyone can
install permanently in Zen/Firefox by opening the file.

### C. Userscript — Chrome **and** Zen (single file, fastest pilot)

1. Install [Tampermonkey](https://www.tampermonkey.net/) or
   [Violentmonkey](https://violentmonkey.github.io/).
2. Open **`aetheria-market-plus.user.js`** (repo root of this folder) or
   **`dist/userscript/aetheria-market-plus.user.js`** — the manager prompts to install.
3. Open the game — button appears.

## Deploy to your users

Everything needed for distribution already lives in `dist/` — pick a route:

### Route 1 — Userscript link (fastest, works on Chrome + Zen)

1. Host `dist/userscript/aetheria-market-plus.user.js` on any HTTPS URL you control
   (your site, GitHub raw, CDN…).
2. Create `market-tool/deploy.config.json`:

   ```json
   { "userscriptBase": "https://your-domain.example/market" }
   ```

   `node build.mjs` then injects `@updateURL`/`@downloadURL` automatically, so every
   future release **auto-updates** for all users who installed it.
3. Share the link — users with Tampermonkey/Violentmonkey get the install prompt.

### Route 2 — Chrome Web Store (widest reach)

1. Create a Chrome Web Store developer account (one-time $5) and a new item.
2. Upload `dist/aetheria-market-plus-chrome.zip`.
3. Listing notes to include: runs only on `aetheria-online.in.th`, no data collected,
   no accounts touched (uses the player's own session).
4. After review, share the store link (users install with one click; updates automatic).

### Route 3 — Zen / Firefox signed XPI

1. Get AMO API keys (addons.mozilla.org → API keys).
2. `npx web-ext sign --source-dir dist/firefox --api-key <K> --api-secret <S> --channel unlisted`
3. Share the produced `.xpi` (or list it publicly on AMO — Zen users can find it there).

### Release checklist (every update)

1. Edit `core.js`, bump `VERSION` (e.g. `0.2.2`).
2. `node build.mjs` — stamps the version everywhere (manifests, userscript, updater,
   `latest-version.txt`).
3. Upload per channel — see **Auto-update for your users** below:
   Chrome zip + `latest-version.txt` · userscript (same URL) · Zen signed xpi +
   `updates.json`.

A user-facing guides ship in `dist/` — share them alongside any route above:
**`INSTALL-CHROME.txt`** (Chrome/Edge, EN+TH), **`INSTALL-ZEN.txt`** (Zen/Firefox, EN+TH),
**`INSTALL-TH.txt`** (all routes, TH).

## Features

- Server-side filters: category / kind / **class (อาชีพ)** / rarity / name / price range / refine / sort.
  - The class dropdown mirrors the game's own market filter: roster fetched live from the
    same-origin `/classes` API (33 classes), Thai labels, grouped by job tier — e.g.
    “ชุดเกราะ that อัศวิน can use”.
- **Ability chips**: innate attributes (39 types) + affixes (23 types), AND / OR mode —
  e.g. “ชุดเกราะ that has ลดดาเมจที่ได้รับ”.
- **Per-stat value ranges (optional)**: selecting a chip reveals `≥` / `≤` inputs inside it —
  leave empty for “any value”, fill min/max for finer control, e.g.
  “ลดดาเมจที่ได้รับ 7–10 + โอกาสบล็อก”. Results re-filter live as you type; the twin chip
  (stats that exist as both attribute and affix) stays in sync automatically.
- **สแกนตลาด**: scans every page of the current filter set with strict pacing
  (~30 ms/op; full armor market ≈ 80 pages ≈ 6–8 s), progress + cancel.
- Results: item (+refine/slots), price, seller, colored ability badges; auctions
  (ประมูล) / expired / own listings are labeled and not buyable.
- **ซื้อ**: confirmation → buy op → optional auto-claim (`collect_all`) so the item
  lands in your inventory; live Zeny display; out-of-funds disabled.
- **Scan cache** (`localStorage`): the game auto-reloads every few minutes — the last
  scan re-appears instantly instead of re-scanning.

## Repo layout / rebuild

```
market-tool/
  core.js                     <- single source of truth (the whole tool)
  userscript.header.txt       <- userscript metadata block
  extension/
    manifest.chrome.json      <- MV3, content_scripts world:"MAIN"
    manifest.firefox.json     <- + browser_specific_settings (Gecko id, min v142)
    icons/                    <- generated (make-icons.mjs)
  tools/make-icons.mjs        <- pure-node PNG icon generator
  build.mjs                   <- stamps version from core.js, builds dist/
  aetheria-market-plus.user.js<- built userscript (regenerated; do not edit)
  dist/                       <- built artifacts (chrome/, firefox/, userscript/, zips)
```

Rebuild after editing `core.js`:

```bash
cd market-tool
node build.mjs        # (re)generates userscript + dist/chrome + dist/firefox + zips
```

Optional `deploy.config.json` (`{"userscriptBase":"https://your-host/path"}`) adds
`@updateURL`/`@downloadURL` to the built userscript so installed copies auto-update.

## How it works (verified live 2026-10-05)

Hooks `window.WebSocket` before the game client creates its socket, then speaks the
game's own room protocol on the player's authenticated connection — no credentials,
no extra login, works while playing:

| Op | Payload | Response |
|---|---|---|
| `market` | `{op:'search', filters:{q,category,kind,job,rarity,minRefine,minLevel,maxLevel,minPrice,maxPrice,sort,page}}` | `market_results {listings:[20], total, page, pageSize:20}` + `market_done` |
| `market` | `{op:'buy', listingId, price}` | `market_done {op:'buy', ok}` — item goes to the **รับของ** delivery box |
| `market` | `{op:'collect_all'}` | `market_done` — delivery claimed into inventory |

Wire: `[0x0d] + msgpack(type) + msgpack(data)`; server accepts standard msgpack.

Key facts: the server has **no ability filter and ignores `pageSize`/unknown filter
keys** → the tool fetches pages and filters locally; **one market op at a time**
(server serializes; parallel sends are rejected) → scans are strictly chained;
listings carry the full item (`attributes`, `affixes{category: primary|secondary|special}`,
`refine`, `cards`, `slots`, …).

## Troubleshooting

- Nothing appears: check the extension is enabled and the URL matches
  `www.aetheria-online.in.th`. View page console with `window.__amktDebug = true` for
  `[Market+]` logs.
- “สแกนไม่สำเร็จ: หมดเวลา”: socket busy/disconnected — retry; the tool already retries
  each page 3×.
- Panel says “รอเชื่อมต่อ…”/buy says not connected: you must be **in-game** (joined),
  not on the login/character-select screen.
- After a game update the protocol may change — re-verify with the tooling in
  `../tools/` (extract.mjs, decode-capture.mjs).

## Auto-update for your users

Three channels, three realities:

### Userscript — fully automatic

`deploy.config.json` → `userscriptBase` adds `@updateURL`/`@downloadURL` to the built
script; Tampermonkey/Violentmonkey update automatically. Zero user action.

### Chrome "Load unpacked" zip — one-click updater

Chrome has **no silent update for unpacked folders**, so the build ships a one-click
updater: **`dist/UPDATE-CHROME.ps1` + `UPDATE-CHROME.cmd`** (URLs baked from
`deploy.config.json` at build time).

**User flow:** keep `UPDATE-CHROME.cmd` next to the extension folder → double-click it
→ it downloads the latest zip, shows `0.2.1 -> 0.2.2`, replaces the files, and asks
the user to click ↻ on `chrome://extensions`. If already current it says so and exits.

**Publish flow per release:**

1. `node build.mjs`
2. Upload `aetheria-market-plus-chrome.zip` + `latest-version.txt`
   (URLs must match `chromeZipUrl` / `chromeLatestVersionUrl` in `deploy.config.json`)

> Fully automatic alternative: publish to the **Chrome Web Store** — Chrome updates
> silently; no updater script needed.

### Zen / Firefox signed .xpi — fully automatic (permanent installs)

Firefox checks `gecko.update_url` periodically (~daily, and via about:addons →
Check for updates). One-time setup: set `firefoxUpdatesUrl` in `deploy.config.json`
(e.g. `https://host/marketplus/updates.json`) and rebuild — the manifest then
contains `update_url`.

**Publish flow per release:**

1. `node build.mjs`, then sign:
   `npx web-ext sign --source-dir dist/firefox --api-key <K> --api-secret <S> --channel unlisted`
2. Host the signed `.xpi` (filename matching `firefoxXpiUrlTemplate`).
3. `node tools/zen-updates.mjs` — appends the new version to `updates.json`.
4. Upload `dist/updates.json` to the `firefoxUpdatesUrl` location.

Two caveats:

- The **installed version must itself contain `update_url`** — the first
  auto-updating build has to be distributed manually; later releases self-update.
- Temporary add-ons (about:debugging) never auto-update — only permanent installs do.

### Suggested hosting layout

```
https://your-host/marketplus/
  aetheria-market-plus.user.js        (userscript - auto-updates)
  aetheria-market-plus-chrome.zip     (Chrome zip - used by UPDATE-CHROME.cmd)
  latest-version.txt                  (version beacon for the updater)
  aetheria-market-plus-{version}.xpi  (signed Zen build, per release)
  updates.json                        (Zen update manifest)
```

## Changelog

- **0.2.2** — fixed a UI-state desync: closing/reopening the panel kept old chip and
  AND/OR selections *invisibly active* (re-created DOM looked reset), so “checking” a
  chip could silently **unselect** it — e.g. “must have both” showing every item.
  The panel now restores chip/radio visuals from state, and a summary line always
  shows the active filter + match count.
- **0.2.1** — ability chips now match across attributes **and** affixes (picking
  “ลดดาเมจที่ได้รับ” from *either* group finds items where it's innate or rolled —
  fixes epic armor like Angelic Protection being missed); added a “filters changed —
  rescan” warning; scans now dedupe listings that shift between pages.
- **0.2.0** — deployable build: Chrome/Zen extension packages, userscript auto-update
  support, scan cache, EN/TH install guides.

## Caveats

- Depends on the game's undocumented wire protocol.
- Uses only actions the market UI itself can do (search / buy / claim), on the
  player's own session — but it is third-party automation; get the game operators'
  blessing before wide distribution.
- v0.2 polish pending: custom confirm dialog, result virtualization, bid (auction)
  support, watchlist alerts.
