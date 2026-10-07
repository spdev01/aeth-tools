// Wiki data cache — mirrors GET /wiki-data to data/wiki.json (24h TTL).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.CC_DATA ? path.resolve(process.env.CC_DATA) : path.join(here, '..', 'data');
const FILE = path.join(DATA_DIR, 'wiki.json');

let wiki = null;
export function getWiki() { return wiki; }

export async function initWiki() {
  try {
    if (fs.existsSync(FILE) && Date.now() - fs.statSync(FILE).mtimeMs < 24 * 3600 * 1000) wiki = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {}
  if (!wiki) {
    try {
      const r = await fetch('https://www.aetheria-online.in.th/wiki-data');
      wiki = await r.json();
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(wiki));
      console.log('[wiki] loaded items=' + (wiki.items?.length ?? 0) + ' monsters=' + (wiki.monsters?.length ?? 0) + ' skills=' + (wiki.skills?.length ?? 0));
    } catch (e) {
      console.error('[wiki] fetch failed:', e?.message);
      try { wiki = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
    }
  }
  return wiki;
}

// all card item ids (type 'Card' + ragnarok card set) — powers the "keep all cards" toggle: the manager merges
// these into the whitelist pushed to each bot, so cards ride the normal keep machinery (never sold, banked, traded).
export function cardItemIds() {
  const w = wiki ?? {};
  const out = [];
  for (const it of [...(w.items ?? []), ...(w.ragnarokItems ?? [])]) if (it && it.type === 'Card' && it.id != null) out.push(it.id);
  return [...new Set(out)];
}

// Slim slices for the UI (avoid shipping 1.2MB to the browser).
export function wikiSlices() {
  const w = wiki ?? {};
  return {
    items: (w.items ?? []).map((i) => ({ id: i.id, name: i.name, type: i.type ?? null, sellPrice: i.sellPrice ?? null })),
    roItems: (w.ragnarokItems ?? []).map((i) => ({ id: i.id, name: i.name, type: i.type ?? null })),
    monsters: (w.monsters ?? []).map((m) => ({
      id: m.id ?? m.monsterId ?? null,
      name: m.name ?? m.id ?? '?',
      level: m.level ?? null,
      // unique mapIds this monster spawns on (drives the per-map monster picker)
      maps: [...new Set((m.spawns ?? []).map((s) => (s && s.mapId) || null).filter(Boolean))],
    })),
    skills: (w.skills ?? []).map((s) => ({ id: s.id ?? s.skillId ?? null, name: s.name ?? s.id ?? '?', cls: s.classId ?? s.class ?? s.job ?? null, maxLevel: s.maxLevel ?? null })),
    maps: (w.maps ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id })),
  };
}
