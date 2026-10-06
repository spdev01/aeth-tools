// Tiny local JSON store (atomic writes). Holds accounts/characters/bots; event volume lives in
// per-bot JSONL files, so this stays small and fast well past 100 bots.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)); // .../command-center/server
const DATA_DIR = process.env.CC_DATA ? path.resolve(process.env.CC_DATA) : path.join(here, '..', 'data');
const FILE = path.join(DATA_DIR, 'store.json');

const empty = () => ({ accounts: [], characters: [], bots: [], settings: { collector: null, tracked: [], autoCollect: { enabled: false, everyMin: 360, minZeny: 15000, minStacks: 1, lastAt: 0 } }, meta: { nextAccountId: 1, nextCharacterId: 1, nextBotId: 1 } });

let state;
try { state = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { state = empty(); }
if (!state.settings) state.settings = { collector: null, tracked: [] };
if (!state.settings.autoCollect) state.settings.autoCollect = { enabled: false, everyMin: 360, minZeny: 15000, minStacks: 1, lastAt: 0 };

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
