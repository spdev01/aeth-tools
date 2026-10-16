// accounts.js — account + character records for the ROVA fleet.
// TOR-ONLY INVARIANT: every request that touches the game service leaves through a SOCKS circuit
// (server/rova-http.mjs → socks.mjs). There is deliberately no direct-connection code path here.
// Registration flow live-verified 2026-10-16 — see rova/protocol/AUTH-HANDSHAKE.md.
import { store } from './store.js';
import { accountUsername, strongPassword } from './namegen.js';
import { torRequest } from './rova-http.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Registration — rides the Tor house circuit (D1). Configure with ROVA_REG_PORT / ROVA_REG_SOCKS_USER / ROVA_REG_SOCKS_PASS.
const REG_PORT = Number(process.env.ROVA_REG_PORT || 21000);
const REG_USER = process.env.ROVA_REG_SOCKS_USER || 'canary';
const REG_PASS = process.env.ROVA_REG_SOCKS_PASS || 'canary';
const RETRYABLE_NAME = new Set(['username_taken', 'bad_username', 'name_taken', 'bad_name', 'guest_taken']);

export async function registerAccounts(count = 1) {
  const n = Math.max(1, Math.min(50, parseInt(count, 10) || 1));
  const added = [];
  for (let i = 0; i < n; i++) {
    let done = false, fatal = null;
    for (let attempt = 0; attempt < 3 && !done && !fatal; attempt++) {
      const userId = accountUsername();
      const password = strongPassword(12);
      let r;
      try {
        r = await torRequest({
          port: REG_PORT, user: REG_USER, pass: REG_PASS, method: 'POST',
          path: '/api/auth/register',
          body: { username: userId, password, locale: 'en', invite: '', cbt: '' },
          timeoutMs: 60000,
        });
      } catch (e) {
        fatal = `tor circuit failed (${e?.message || e}) — check Tor daemons (node cc.mjs tor-start)`;
        break;
      }
      const j = r.json || {};
      if (r.status === 200 && j.ok !== false && j.token) {
        const acc = {
          id: store.nextId('account'),
          label: 'registered', userId, password,
          status: 'registered',
          device: j.device || null,          // server-assigned device id (needed for WS ?dv= and relogin)
          accountId: j.account?.id ?? null,
          createdAt: Date.now(),
        };
        store.data.accounts.push(acc);
        added.push(acc);
        store.save();
        done = true;
      } else {
        const code = j.err || `http_${r.status}`;
        if (RETRYABLE_NAME.has(code)) { await sleep(500); continue; } // fresh username next attempt
        fatal = code;
      }
    }
    if (fatal) return { ok: false, error: fatal, added: added.length };
  }
  if (!added.length) return { ok: false, error: 'registration produced no accounts' };
  return { ok: true, added: added.length, accounts: added.map((a) => ({ id: a.id, userId: a.userId, status: a.status })) };
}
