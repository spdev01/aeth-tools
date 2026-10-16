// accounts.js — account + character records for the ROVA fleet.
//
// STATUS: registration against the ROVA service is NOT wired yet on purpose. The HTTP auth flow
// (/api/auth/* — guest/password/token) must be confirmed against a real environment first; see
// rova/protocol/ROVA-PROTOCOL-INVENTORY.md §1 (auth) and the security review's route inventory.
// Until then: IMPORT accounts (userId:password per line) or create placeholder records for smoke tests.
import { store } from './store.js';
import { accountUsername, strongPassword } from './namegen.js';

export function importAccounts(lines, { label = 'imported' } = {}) {
  const rows = String(lines || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const added = [];
  for (const row of rows) {
    const m = row.split(/[:;\t ]+/);
    if (m.length < 2) continue;
    const [userId, password] = [m[0], m.slice(1).join(':')];
    if (!userId || !password) continue;
    if (store.data.accounts.some((a) => a.userId === userId)) continue;
    const acc = {
      id: store.nextId('account'),
      label, userId, password,
      status: 'imported',
      createdAt: Date.now(),
    };
    store.data.accounts.push(acc);
    added.push(acc);
  }
  store.save();
  return added;
}

export function createPlaceholderAccounts(count, { label = 'placeholder' } = {}) {
  const added = [];
  for (let i = 0; i < count; i++) {
    const acc = {
      id: store.nextId('account'),
      label,
      userId: accountUsername(),
      password: strongPassword(12),
      status: 'planned', // credentials generated locally; NOT registered on the game yet
      createdAt: Date.now(),
    };
    store.data.accounts.push(acc);
    added.push(acc);
  }
  store.save();
  return added;
}

export function removeAccount(id) {
  const acc = store.findAccount(id);
  if (!acc) return { ok: false, error: 'account not found' };
  const chars = store.charsOfAccount(id);
  const charIds = new Set(chars.map((c) => c.id));
  store.data.bots = store.data.bots.filter((b) => !charIds.has(b.characterId));
  store.data.characters = store.data.characters.filter((c) => c.accountId !== id);
  store.data.accounts = store.data.accounts.filter((a) => a.id !== id);
  store.save();
  return { ok: true };
}

// Registration stub — fails loudly so nobody assumes it worked.
export async function registerAccounts() {
  return {
    ok: false,
    notImplemented: true,
    error: 'ROVA registration adapter not implemented yet — auth flow (/api/auth/*) must be confirmed on a real environment first. Use import or placeholder accounts for now.',
  };
}
