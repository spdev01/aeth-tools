// Tiny local JSON store (atomic writes). Holds accounts/characters/bots; event volume lives in
// per-bot JSONL files, so this stays small and fast well past 100 bots.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)); // .../command-center/server
const DATA_DIR = process.env.CC_DATA ? path.resolve(process.env.CC_DATA) : path.join(here, '..', 'data');
const FILE = path.join(DATA_DIR, 'store.json');

const empty = () => ({ accounts: [], characters: [], bots: [], settings: { collector: null, tracked: [], plans: [], wings: { enabled: true, keep: 10 }, autoCollect: { enabled: false, everyMin: 360, minZeny: 15000, minStacks: 1, lastAt: 0 } }, meta: { nextAccountId: 1, nextCharacterId: 1, nextBotId: 1 } });

let state;
try { state = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { state = empty(); }
if (!state.settings) state.settings = { collector: null, tracked: [] };
if (!state.settings.autoCollect) state.settings.autoCollect = { enabled: false, everyMin: 360, minZeny: 15000, minStacks: 1, lastAt: 0 };
if (!state.settings.wings) state.settings.wings = { enabled: true, keep: 10 };
if (!Array.isArray(state.settings.plans)) state.settings.plans = [];
// multi-collector pool (2026-10-08): each collector has a zeny cap + a per-item quantity cap; transfers spill
// to the next collector when one is full and a fresh collector is auto-created when they all are.
// Defaults (user-set): zeny 297,431,629 (deliberately non-round) · 4,995 per item.
if (!Array.isArray(state.settings.collectors)) {
  state.settings.collectors = state.settings.collector?.charName
    ? [{
        id: 1,
        charName: state.settings.collector.charName,
        channel: state.settings.collector.channel ?? 1,
        spot: state.settings.collector.spot ?? { x: 880, y: 1520 },
        zenyCap: 297431629,
        itemCapPerItem: 4995,
        createdAt: Date.now(),
      }]
    : [];
}
if (!state.meta.nextCollectorId) state.meta.nextCollectorId = state.settings.collectors.length + 1;

let writeQueued = false;
function persist() {
  if (writeQueued) return;
  writeQueued = true;
  setTimeout(() => {
    writeQueued = false;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
      fs.renameSync(tmp, FILE);
    } catch (e) { console.error('[store] persist failed', e?.message); }
  }, 300);
}

export const store = {
  data: state,
  dir: DATA_DIR,
  save: persist,
  nextId(kind) {
    const key = `next${kind[0].toUpperCase()}${kind.slice(1)}Id`;
    const id = state.meta[key] ?? 1;
    state.meta[key] = id + 1;
    persist();
    return id;
  },
  findAccount: (id) => state.accounts.find((a) => a.id === id),
  findCharacter: (id) => state.characters.find((c) => c.id === id),
  findBot: (id) => state.bots.find((b) => b.id === id),
  charsOfAccount: (accountId) => state.characters.filter((c) => c.accountId === accountId),
  getSettings: () => state.settings,
};
