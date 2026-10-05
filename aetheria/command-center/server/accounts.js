// Account + character service for the command center.
// - registration: serialized /auth/guest with 429 backoff (game rate-limits this endpoint)
// - characters: one per account, giphy-style names, retries on server name conflicts
// - import: userId:password lists (validated via /auth/login)
import { store } from './store.js';
import { characterName, accountUsername, strongPassword } from './namegen.js';

const BASE = 'https://www.aetheria-online.in.th';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// shared rate limiter for auth endpoints (token bucket-ish with cooldown)
const limiter = {
  nextAt: 0,
  async wait(minGapMs = 4000) {
    const now = Date.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + minGapMs;
    if (at > now) await sleep(at - now);
  },
};

const api = async (pathname, { method = 'GET', token, body } = {}) => {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
};

// Proper account registration via /auth/register (fast; returns {token} directly).
export async function registerAccount({ userId, password }) {
  const { status, json } = await api('/auth/register', { method: 'POST', body: { userId, password } });
  if (status === 200 && json.token) return { userId: json.user?.userId ?? json.userId ?? userId, password, token: json.token };
  throw new Error(`register ${status}: ${JSON.stringify(json).slice(0, 140)}`);
}

export async function login(userId, password) {
  const { status, json } = await api('/auth/login', { method: 'POST', body: { userId, password } });
  if (status !== 200 || !json.token) throw new Error(`login failed ${status}: ${JSON.stringify(json).slice(0, 120)}`);
  return json.token;
}

export async function listServerCharacters(token) {
  const { status, json } = await api('/characters', { token });
  if (status !== 200) throw new Error(`characters failed ${status}: ${JSON.stringify(json).slice(0, 120)}`);
  return json.characters ?? [];
}

export async function createCharacterFor(account, { token: provided } = {}) {
  const token = provided ?? await login(account.userId, account.password);
  let name = null, lastErr = null;
  const taken = new Set(store.data.characters.map((c) => c.name.toLowerCase()));
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = (() => { let n; do { n = characterName(); } while (taken.has(n.toLowerCase())); return n; })();
    const { status, json } = await api('/characters', { method: 'POST', token, body: { name: candidate } });
    if (status === 200 && json.characterId) { name = candidate; lastErr = null; break; }
    lastErr = `${status} ${JSON.stringify(json).slice(0, 120)}`;
    await sleep(1500); // likely name conflict — retry with a new name
  }
  if (!name) throw new Error('create character failed: ' + lastErr);
  return { name, token };
}

export function addCharacter(account, { characterId = null, name, classId = 'novice', baseLevel = 1, jobLevel = 1, mapName = null, included = true }) {
  const c = {
    id: store.nextId('character'),
    accountId: account.id,
    characterId,
    name,
    classId,
    baseLevel,
    jobLevel,
    mapName,
    included: included ? 1 : 0,
    updatedAt: Date.now(),
  };
  store.data.characters.push(c);
  store.save();
  return c;
}

export async function refreshCharacter(character) {
  const account = store.findAccount(character.accountId);
  if (!account) return null;
  try {
    const token = await login(account.userId, account.password);
    const list = await listServerCharacters(token);
    const me = list.find((x) => x.name === character.name || x.characterId === character.characterId);
    if (me) {
      character.characterId = me.characterId ?? character.characterId;
      character.mapName = me.mapName ?? character.mapName;
      character.classId = me.classId ?? character.classId;
      character.baseLevel = me.baseLevel ?? character.baseLevel;
      character.jobLevel = me.jobLevel ?? character.jobLevel;
      character.updatedAt = Date.now();
      store.save();
    }
  } catch (e) { /* ignore — refresh is best-effort */ }
  return character;
}

// ---- background jobs (registration / character creation batches) ----
export const jobs = { active: null, history: [] };

async function runJob(job, work) {
  jobs.active = job;
  try {
    await work();
    job.status = 'done';
  } catch (e) {
    job.status = 'failed';
    job.error = String(e?.message || e);
    job.log.push({ ts: Date.now(), msg: job.error, level: 'error' });
  } finally {
    job.finishedAt = Date.now();
    jobs.history.unshift(job);
    if (jobs.history.length > 20) jobs.history.pop();
    jobs.active = null;
  }
}

export function startRegisterJob({ count = 1, createChars = true, autoInclude = true }) {
  if (jobs.active) throw new Error('a job is already running: ' + jobs.active.kind);
  const job = { id: Date.now(), kind: 'register', total: count, done: 0, failed: 0, status: 'running', log: [], startedAt: Date.now() };
  const onUpdate = startRegisterJob.onUpdate ?? (() => {});
  runJob(job, async () => {
    for (let i = 0; i < count; i++) {
      try {
        // register with generated credentials (retry with a new username on conflict)
        let account = null, lastErr = null;
        for (let attempt = 0; attempt < 4 && !account; attempt++) {
          const userId = accountUsername();
          const password = strongPassword();
          try {
            await limiter.wait(1500);
            const r = await registerAccount({ userId, password });
            account = {
              id: store.nextId('account'),
              label: `bot-${String(store.data.meta.nextAccountId - 1).padStart(3, '0')}`,
              userId: r.userId,
              password,
              token: r.token,
              type: 'upgraded',
              status: 'active',
              includeDefault: autoInclude ? 1 : 0,
              createdAt: Date.now(),
            };
          } catch (e) {
            lastErr = e;
            const msg = String(e?.message || e);
            await sleep(/429|limit/i.test(msg) ? 8000 : 2000);
          }
        }
        if (!account) throw lastErr ?? new Error('register failed');
        store.data.accounts.push(account);
        store.save();
        let line = `created ${account.label} (${account.userId})`;
        if (createChars) {
          const { name } = await createCharacterFor(account, { token: account.token });
          addCharacter(account, { name, included: autoInclude });
          line += ` · char ${name}`;
        }
        job.done++;
        job.log.push({ ts: Date.now(), msg: line, level: 'ok' });
      } catch (e) {
        job.failed++;
        job.log.push({ ts: Date.now(), msg: `account ${i + 1} failed: ${String(e?.message || e).slice(0, 160)}`, level: 'error' });
      }
      onUpdate(job);
    }
  });
  return job;
}

export function startCharJob({ accountIds = null } = {}) {
  if (jobs.active) throw new Error('a job is already running: ' + jobs.active.kind);
  const targets = (accountIds ? store.data.accounts.filter((a) => accountIds.includes(a.id)) : store.data.accounts.slice())
    .filter((a) => store.charsOfAccount(a.id).length === 0);
  const job = { id: Date.now(), kind: 'characters', total: targets.length, done: 0, failed: 0, status: 'running', log: [], startedAt: Date.now() };
  const onUpdate = startCharJob.onUpdate ?? (() => {});
  runJob(job, async () => {
    for (const account of targets) {
      try {
        const { name } = await createCharacterFor(account);
        addCharacter(account, { name, included: !!account.includeDefault });
        job.done++;
        job.log.push({ ts: Date.now(), msg: `${account.label} · char ${name}`, level: 'ok' });
      } catch (e) {
        job.failed++;
        job.log.push({ ts: Date.now(), msg: `${account.label} failed: ${String(e?.message || e).slice(0, 160)}`, level: 'error' });
      }
      onUpdate(job);
    }
  });
  return job;
}

export function importAccounts({ lines = '', autoInclude = true } = {}) {
  const results = [];
  for (const raw of String(lines).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [userId, ...rest] = line.split(/[:,\s]+/);
    const password = rest.join(' ').trim();
    if (!userId || !password) { results.push({ line, ok: false, error: 'expected userId:password' }); continue; }
    if (store.data.accounts.some((a) => a.userId === userId)) { results.push({ line, ok: false, error: 'already imported' }); continue; }
    results.push({ line, ok: true, pending: { userId, password } });
  }
  const valid = results.filter((r) => r.ok);
  if (!valid.length) return { imported: 0, results };
  // validate + store asynchronously in a job (login calls are rate-aware)
  if (jobs.active) throw new Error('a job is already running: ' + jobs.active.kind);
  const job = { id: Date.now(), kind: 'import', total: valid.length, done: 0, failed: 0, status: 'running', log: [], startedAt: Date.now() };
  const onUpdate = importAccounts.onUpdate ?? (() => {});
  runJob(job, async () => {
    for (const r of valid) {
      try {
        await limiter.wait(2500);
        await login(r.pending.userId, r.pending.password);
        const account = {
          id: store.nextId('account'),
          label: `imp-${String(store.data.meta.nextAccountId - 1).padStart(3, '0')}`,
          userId: r.pending.userId,
          password: r.pending.password,
          type: r.pending.userId.startsWith('g_') ? 'guest' : 'upgraded',
          status: 'active',
          includeDefault: autoInclude ? 1 : 0,
          createdAt: Date.now(),
        };
        store.data.accounts.push(account);
        store.save();
        job.done++;
        job.log.push({ ts: Date.now(), msg: `imported ${account.userId}`, level: 'ok' });
      } catch (e) {
        job.failed++;
        job.log.push({ ts: Date.now(), msg: `${r.pending.userId}: ${String(e?.message || e).slice(0, 120)}`, level: 'error' });
      }
      onUpdate(job);
    }
  });
  return { imported: valid.length, job, results };
}
