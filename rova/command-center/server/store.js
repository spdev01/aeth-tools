// Tiny local JSON store (atomic writes) — accounts/characters/bots for the ROVA fleet.
// Event volume lives in per-bot JSONL files, so this stays small and fast well past 100 bots.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)); // .../rova/command-center/server
const DATA_DIR = process.env.ROVA_CC_DATA ? path.resolve(process.env.ROVA_CC_DATA) : path.join(here, '..', 'data');
const FILE = path.join(DATA_DIR, 'store.json');

const empty = () => ({
  accounts: [],
  characters: [],
  bots: [],
  settings: {},
  meta: { nextAccountId: 1, nextCharacterId: 1, nextBotId: 1 },
});

let state;
try { state = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { state = empty(); }
if (!state.accounts) state.accounts = [];
if (!state.characters) state.characters = [];
if (!state.bots) state.bots = [];
if (!state.settings) state.settings = {};

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
  file: FILE,
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
