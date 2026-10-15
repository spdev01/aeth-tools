/* Command Center dashboard — vanilla JS, WS-driven. */
const $ = (id) => document.getElementById(id);
const api = async (path, method = 'GET', body) => {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return res.json().catch(() => ({}));
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  bots: [], jobs: null, accounts: [], characters: [],
  logs: new Map(), // botId -> [events]
  selectedLog: null, sel: new Set((() => { try { return JSON.parse(localStorage.getItem('cc.sel') || '[]'); } catch { return []; } })()),
  lv: new Map(), // botId -> { at, lv } — level-up celebration window
  act: new Map(), // botId -> { evt, b, at } — client-side activity feed (WS log stream)
  pw: new Map(), // accountId -> password (fetched on demand)
  pwShow: new Set(), // accountIds currently revealed
  accSel: new Set(), // accountIds ticked in the Accounts tab (delete tool)
  accSelIdx: -1, // index of the last-clicked account checkbox (shift+click range anchor)
  botSelIdx: -1, // index of the last-clicked dashboard bot checkbox (shift+click range anchor)
  view: localStorage.getItem('cc.view') || 'grid',
  drawerTab: 'log',
  earnCache: new Map(), // botId -> { at, data, hours, inflight } — drawer earnings graph
  earnCfg: (() => { try { return Object.assign({ range: 12, xtick: 'auto', ytick: 'auto' }, JSON.parse(localStorage.getItem('cc.earnCfg') || '{}')); } catch { return { range: 12, xtick: 'auto', ytick: 'auto' }; } })(),
  cfgKeep: [],
  cfgMobSel: new Set(),
  cfgBotMap: null,
  cfgFarmMap: null,
  cfgWeave: [],
  cfgBuff: [],
  wiki: { items: [], roItems: [], monsters: [], skills: [], maps: [] },
  cfgBot: null,
  settings: null, collect: null, fleet: null,
  whOpen: new Set(), whRefreshing: false, whWatch: null,
  killData: null, killF: { view: 'monster', from: '', to: '', bot: 'all', mob: '' },
  killOpen: new Set(), killWatch: null, killArm: false,
  botModalId: null, botWatch: null,
  plans: [],
  cfgPlan: null,
  groupFilter: null, // dashboard group filter: null = all · '__ungrouped__' · group name
  shop: null, // shopping (gear-up) queue view: {jobs, counts} from /api/state
};

// ---------- tabs ----------
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('on', x === b));
  for (const t of ['dash', 'accounts', 'stress', 'collector', 'shopping', 'captchas']) $('tab-' + t).classList.toggle('hidden', t !== b.dataset.tab);
  if (b.dataset.tab === 'collector' || b.dataset.tab === 'shopping') refreshState();
}));

// ---------- WS ----------
let ws;
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/live');
  ws.onopen = () => { $('conn').classList.remove('off'); const l = $('conn').querySelector('span'); if (l) l.textContent = 'LIVE'; };
  ws.onclose = () => { $('conn').classList.add('off'); const l = $('conn').querySelector('span'); if (l) l.textContent = 'OFFLINE'; setTimeout(connect, 2500); };
  ws.onmessage = (m) => {
    let msg; try { msg = JSON.parse(m.data); } catch { return; }
    if (msg.type === 'hello') {
      state.bots = msg.bots; state.jobs = msg.jobs;
      for (const e of msg.events ?? []) { pushLog(e.botId, e); feedAct(e.botId, e); }
      renderAll();
    } else if (msg.type === 'bots') { state.bots = msg.bots; state.jobs = msg.jobs; if (!document.hidden) { renderBots(); renderKpis(); renderCollector(); renderShopping(); renderCaptchas(); } }
    else if (msg.type === 'jobs') { state.jobs = msg.jobs; renderJobs(); }
    else if (msg.type === 'log') { pushLog(msg.botId, msg.e); feedAct(msg.botId, msg.e); if (msg.botId === state.selectedLog) renderLog(); }
    else if (msg.type === 'state_dirty') { refreshState(); }
  };
}
function pushLog(botId, e) {
  if (!state.logs.has(botId)) state.logs.set(botId, []);
  const arr = state.logs.get(botId);
  arr.push(e);
  if (arr.length > 400) arr.shift();
}

// compact digest of an event for the activity badge
const EVT_BRIEF = (evt, d) => {
  try {
    switch (evt) {
      case 'route': return { to: d.to };
      case 'travel_msg': return { to: d.mapId };
      case 'traveled': return { to: d.now };
      case 'npc_dialog': return { name: d.name };
      case 'levelup': return { level: d.level };
      default: return {};
    }
  } catch { return {}; }
};
function feedAct(botId, e) {
  if (!e || !e.evt || e.evt === 'HEARTBEAT') return;
  state.act.set(botId, { evt: e.evt, b: EVT_BRIEF(e.evt, e.data ?? {}), at: Date.now() });
}

// ---------- data refresh (accounts etc.) ----------
async function refreshState() {
  const s = await api('/api/state');
  state.accounts = s.accounts ?? []; state.characters = s.characters ?? []; state.bots = s.bots ?? state.bots; state.jobs = s.jobs ?? state.jobs;
  state.settings = s.settings ?? state.settings; state.collect = s.collect ?? state.collect; state.fleet = s.fleet ?? state.fleet; state.plans = s.plans ?? state.plans;
  state.shop = s.shop ?? state.shop;
  renderAll();
}

// ---------- render ----------
const fmt = (n) => n == null ? '?' : Number(n).toLocaleString();
const fmtC = (n) => n == null ? '—' : n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
function renderAll() { renderKpis(); renderBots(); renderAccounts(); renderJobs(); renderStress(); renderCollector(); renderShopping(); renderLog(); renderCaptchas(); }

// ---------- per-bot activity badge (what is this bot doing right now) ----------
const ACTS = {
  combat: ['⚔', 'In combat', 'a-combat'],
  dead: ['☠', 'Dead', 'a-dead'],
  suspect: ['☠?', 'Death msg (unconfirmed)', 'a-recover'],
  recovering: ['✚', 'Recovering', 'a-recover'],
  traveling: ['➜', 'Traveling', 'a-travel'],
  restocking: ['◈', 'Restocking', 'a-restock'],
  npc: ['⌂', 'At NPC', 'a-npc'],
  farming: ['✦', 'Farming', 'a-farm'],
  script: ['▸', 'Script', 'a-script'],
  levelup: ['▲', 'Level up', 'a-level'],
  idle: ['◦', 'Idle', 'a-idle'],
};
const ACTMAP = {
  skill_use: 'combat', skill_fx_self: 'combat', kill: 'combat',
  DEATH: 'dead',
  death_recover: 'recovering', respawned: 'recovering', reconnect_start: 'recovering',
  reconnect_attempt_fail: 'recovering', RECONNECT_FAIL: 'recovering', relogin_fail: 'recovering',
  reconnect_done: 'recovering', death_recovered: 'recovering',
  route: 'traveling', travel_msg: 'traveling', traveled: 'traveling',
  shop: 'restocking', buy_potions: 'restocking', pot_restocked: 'restocking', auto_sold: 'restocking',
  npc_dialog: 'npc', chose: 'npc',
  farm_status: 'farming',
  STEP_START: 'script', STEP_DONE: 'script',
};
function activityBadge(b, s) {
  const a = b.activity ?? state.act.get(b.id);
  if (a?.evt === 'levelup') state.lv.set(b.id, { at: a.at ?? Date.now(), lv: a.b?.level });
  let kind = null, info = '';
  if (s.dead) kind = 'dead';
  else {
    if (a && Date.now() - (a.at ?? 0) < 180000) {
      kind = ACTMAP[a.evt] ?? null;
      if (kind === 'traveling' && a.b?.to) info = String(a.b.to);
      if (kind === 'npc' && a.b?.name) info = String(a.b.name).slice(0, 16);
    }
    if (!kind && s.sus) kind = 'suspect';
    if (!kind && b.state === 'running') kind = s.auto ? 'farming' : 'idle';
    const lv = state.lv.get(b.id);
    if (lv && Date.now() - lv.at < 45000 && kind !== 'dead' && kind !== 'recovering') { kind = 'levelup'; info = lv.lv ? 'lv ' + lv.lv : ''; }
  }
  if (!kind) return '';
  const [ic, label, cls] = ACTS[kind] ?? ACTS.idle;
  return `<span class="act ${cls}">${ic} ${label}${info ? ` · ${info}` : ''}</span>`;
}

// Knight gear completeness (2026-10-08): the build requires 3 gems equipped — Lifesteal (Attack),
// Lifesteal (Skill), Mana (Skill) — and a +7-or-better Dawnbreaker in the main hand. Data comes from
// the heartbeat's `equipment: [{slot, name, itemId, refine}]`. Dots: left = gems (all three), right = weapon.
const KNIGHT_GEM_REQS = [
  ['Lifesteal (Attack)', /lifesteal gem \(attack\)/i],
  ['Lifesteal (Skill)', /lifesteal gem \(skill\)/i],
  ['Mana (Skill)', /mana gem \(skill\)/i],
];
function gearStatus(b) {
  const s = b.status ?? {};
  const knight = /knight/i.test(String(s.classId ?? ''));
  if (!knight) return { knight: false };
  const eq = Array.isArray(s.equipment) ? s.equipment : null;
  if (!eq) return { knight: true, gems: null, weapon: null };
  const gems = eq.filter((e) => /^gem-\d/.test(String(e.slot ?? '')));
  const gemPct = (n) => { const m = String(n ?? '').match(/(\d+(?:\.\d+)?)\s*%/); return m ? parseFloat(m[1]) : 0; };
  // minimum 2% per type (user rule 2026-10-08): a 1% gem counts as missing everywhere (dots + shopping)
  const gemChecks = KNIGHT_GEM_REQS.map(([label, re]) => [label, gems.some((g) => { const nm = String(g.name ?? ''); return re.test(nm) && gemPct(nm) >= 2; })]);
  const main = eq.find((e) => e.slot === 'main-hand') ?? null;
  const mainName = main ? `${main.name}${main.refine ? ` +${main.refine}` : ''}` : null;
  const weapon = !!main && /dawnbreaker/i.test(String(main.name ?? '')) && (Number(main.refine) || 0) >= 7;
  return { knight: true, gems: gemChecks.every(([, ok]) => ok), gemChecks, weapon, mainName };
}
function gearDots(b) {
  const g = gearStatus(b);
  const cls = (v) => (!g.knight || v == null ? 'na' : v ? 'ok' : 'no');
  const gTitle = !g.knight ? `not a knight (class: ${b.status?.classId ?? '?'}) — knight gear checks don't apply`
    : g.gems === null ? 'gems: no equipment data yet (waiting for a heartbeat)'
    : `knight gems — ${g.gemChecks.map(([l, ok]) => `${ok ? '\u2713' : '\u2717'} ${l}`).join(' \u00b7 ')}`;
  const wTitle = !g.knight ? "weapon: knight gear checks don't apply"
    : g.weapon === null ? 'weapon: no equipment data yet (waiting for a heartbeat)'
    : g.weapon ? `weapon \u2713 ${g.mainName}` : `weapon \u2717 ${g.mainName ?? 'nothing equipped'} — need a +7 Dawnbreaker`;
  return `<span class="gdots"><span class="gdot ${cls(g.gems)}" title="${esc(gTitle)}"></span><span class="gdot ${cls(g.weapon)}" title="${esc(wTitle)}"></span></span>`;
}

function whitelistTotals({ ids: scopeIds = null } = {}) {
  const { keep, ids } = whitelistIds();
  const rows = [...ids].map((id) => ({ id, name: itemNameOf(id), bots: 0, botCount: 0, bStore: 0, storeBots: 0, cBag: 0, cStore: 0, per: [], auto: !keep.has(id) }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  // the fleet collector-storage snapshot can't be attributed to a group → only present in the fleet-wide view
  const store = scopeIds ? {} : (state.fleet?.collectorStorage?.items ?? {});
  const per = new Map(); // botId -> { name, id, isCol, bag, store, storeAt }
  let oldestStoreAt = 0, newestStoreAt = 0, storeAtBots = 0;
  for (const b of state.bots) {
    if (b.retired) continue; // retired bots (e.g. the decommissioned collector) must not linger in totals
    if (scopeIds && !scopeIds.has(b.id)) continue; // scoped view: only the ticked bots count
    const isCol = !scopeIds && b.mode === 'collector'; // scoped: a ticked collector counts as a regular holder
    const e = { name: b.name, id: b.id, isCol, bag: {}, store: {}, storeAt: b.status?.storageAt ?? 0 };
    for (const it of (b.status?.inventory ?? [])) {
      if (!byId.has(it.itemId)) continue;
      e.bag[it.itemId] = (e.bag[it.itemId] ?? 0) + (it.qty ?? 1);
    }
    // each bot's OWN storage snapshot (whitelist-filtered here; collectors excluded — theirs is the 🏦 column)
    if (!isCol && Array.isArray(b.status?.storage?.items)) {
      for (const it of b.status.storage.items) {
        if (!byId.has(it.itemId)) continue;
        e.store[it.itemId] = (e.store[it.itemId] ?? 0) + (it.qty ?? 1);
      }
      if (Object.keys(e.store).length && e.storeAt) {
        storeAtBots++;
        oldestStoreAt = oldestStoreAt ? Math.min(oldestStoreAt, e.storeAt) : e.storeAt;
        newestStoreAt = Math.max(newestStoreAt, e.storeAt);
      }
    }
    const heldBag = Object.keys(e.bag).length, heldStore = Object.keys(e.store).length;
    if (heldBag || heldStore) per.set(b.id, e);
    for (const sid of Object.keys(e.bag)) {
      const r = byId.get(+sid); const n = e.bag[sid];
      if (isCol) r.cBag += n; else { r.bots += n; r.botCount++; }
    }
    for (const sid of Object.keys(e.store)) {
      const r = byId.get(+sid); const n = e.store[sid];
      r.bStore += n; r.storeBots++;
    }
  }
  for (const r of rows) {
    r.cStore = store[r.id] ?? 0;
    r.per = [...per.values()]
      .map((e) => ({ name: e.name, id: e.id, isCol: e.isCol, bag: e.bag[r.id] ?? 0, store: e.store[r.id] ?? 0, storeAt: e.storeAt }))
      .filter((x) => x.bag > 0 || x.store > 0)
      .sort((a, b2) => (b2.bag + b2.store) - (a.bag + a.store));
  }
  if (scopeIds) {
    // scoped: hide items the ticked bots hold nothing of (fleet-union rows would just be noise)
    for (let i = rows.length - 1; i >= 0; i--) { const r = rows[i]; if (!(r.bots + r.bStore + r.cBag)) rows.splice(i, 1); }
  }
  const totals = { bots: 0, bStore: 0, cBag: 0, cStore: 0 };
  for (const r of rows) { totals.bots += r.bots; totals.bStore += r.bStore; totals.cBag += r.cBag; totals.cStore += r.cStore; }
  return { rows, totals, storeAt: { oldest: oldestStoreAt, newest: newestStoreAt, bots: storeAtBots }, scoped: !!scopeIds };
}
function openWhModal() {
  const sc = scopeInfo();
  const scoped = !!sc.ids;
  const { rows, totals, storeAt } = whitelistTotals({ ids: sc.ids });
  const cs = scoped ? null : (state.fleet?.collectorStorage ?? null);
  const colCount = state.bots.filter((b) => b.mode === 'collector').length;
  const atTxt = cs?.at ? new Date(cs.at).toLocaleTimeString() : 'never';
  const ago = cs?.at ? `${Math.max(0, Math.round((Date.now() - cs.at) / 60000))}m ago` : '';
  const oldestAgo = storeAt.oldest ? `${Math.max(0, Math.round((Date.now() - storeAt.oldest) / 60000))}m` : null;
  const refreshing = !!state.whRefreshing;
  const grand = totals.bots + totals.bStore + totals.cBag + (cs ? totals.cStore : 0);
  const stale = !!state.fleet?.collectorStorageStale;
  const titleEl = $('wh-title');
  if (titleEl) titleEl.textContent = scoped ? (sc.custom ? `Whitelist — ${sc.n} ticked bots` : `Whitelist — ${sc.tag} · ${sc.n} bots`) : 'Whitelist across all bots — bags + storage';
  $('wh-body').innerHTML = rows.length
    ? `<div class="wh-tools">
        <span class="muted small">${scoped ? `<b>scope: ${sc.custom ? `${sc.n} ticked bots` : `${esc(sc.tag)} · ${sc.n} bots`}</b> · total <b>${fmt(grand)}</b> · bot bags <b>${fmt(totals.bots)}</b> · 🗄 bot storage <b>${fmt(totals.bStore)}</b>${oldestAgo ? ` <span class="muted">(oldest snapshot ${oldestAgo} ago)</span>` : ''} · <span class="muted">collector columns are fleet-level — hidden while a scope is active</span>` : `grand total <b>${fmt(grand)}</b> · bot bags <b>${fmt(totals.bots)}</b> · 🗄 bot storage <b>${fmt(totals.bStore)}</b>${oldestAgo ? ` <span class="muted">(oldest snapshot ${oldestAgo} ago)</span>` : ''} · collector bag <b>${fmt(totals.cBag)}</b> · collector storage <b>${cs ? fmt(totals.cStore) : '—'}</b>`}</span>
        <span class="wh-store">${scoped ? '<span class="muted small">🎯 fleet-level collector bag + 🏦 storage are excluded from a scoped view — ✕ deselect all to see them again</span>' : `${stale ? '<span class="muted small">⚠ a storage snapshot from a retired collector was hidden — </span>' : ''}<span class="muted small">🏦 collector storage as of <b>${atTxt}</b>${ago ? ` <span class="muted">(${ago})</span>` : ''}</span><button id="wh-refresh" class="btn small" ${refreshing || !colCount ? 'disabled' : ''} title="ask the collector to open its storage and re-read it">${refreshing ? '⟳ refreshing…' : '⟳ refresh storage'}</button>`}</span>
      </div>
      <table class="bagt wht"><thead><tr><th>item</th><th>🎒 bot bags</th><th title="number of ${scoped ? 'ticked' : 'farming'} bots holding this item in their bag">bots</th><th title="whitelist items sitting in bots' OWN storage (kafra) — banked on errands, pulled out for collection">🗄 bot storage</th>${scoped ? '' : '<th class="wh-sep">🧰 collector bag</th><th title="last snapshot the collector read from its storage NPC">🏦 collector storage</th>'}<th>total</th></tr></thead><tbody>${rows.map((r) => `
        <tr class="wh-item" data-whrow="${String(r.id)}" title="click for the per-character breakdown"><td><span class="wh-chev">${state.whOpen.has(String(r.id)) ? '▾' : '▸'}</span> ${r.name}${r.auto ? ' <span class="muted small" title="card seen in a character — counted &amp; kept automatically, no whitelist edit needed">🃏 auto</span>' : ''}</td><td class="bl-mono">${fmt(r.bots)}</td><td class="muted">${r.botCount}</td><td class="bl-mono" title="${r.storeBots} bot(s) hold this in their own storage">${fmt(r.bStore)}</td>${scoped ? '' : `<td class="bl-mono wh-sep">${fmt(r.cBag)}</td><td class="bl-mono" title="${cs?.at ? 'last read ' + new Date(cs.at).toLocaleString() : 'collector has not read its storage yet'}">${cs ? fmt(r.cStore) : '—'}</td>`}<td class="bl-mono"><b>${fmt(r.bots + r.bStore + r.cBag + (cs ? r.cStore : 0))}</b></td></tr>
        <tr class="wh-det hidden" data-whdet="${String(r.id)}"><td colspan="${scoped ? 5 : 7}">${r.per.length ? r.per.map((p) => `<span class="tr-chip wh-chip">${p.isCol ? '🧰 ' : ''}${p.name} <span class="muted">#${p.id}</span> · bag <b>${fmt(p.bag)}</b>${p.store > 0 ? ` · 🗄 <b>${fmt(p.store)}</b>${p.storeAt ? ` <span class="muted">(${Math.max(0, Math.round((Date.now() - p.storeAt) / 60000))}m)</span>` : ''}` : ''}</span>`).join(' ') : '<span class="muted small">no character holds this item right now</span>'}</td></tr>`).join('')}</tbody></table>
      <p class="muted small">${scoped ? `scope: ${sc.custom ? `${sc.n} ticked bots` : `${esc(sc.tag)} · ${sc.n} bots`} — the numbers below cover only the ticked bots · ` : ''}bot bags = live sum across all farming bots (≤20s heartbeat lag) · <b>🗄 bot storage</b> = each bot's OWN kafra storage, as of its last visit (whitelist items are banked there on errands and pulled back out during a collect — snapshot age shown per character in the breakdown) · collector bag = live · <b>collector storage</b> = last snapshot the collector read from the storage NPC (persisted — survives restarts; if it looks stale hit ⟳ refresh storage) · click an item for the per-character breakdown · union of every bot's whitelist + <b>🃏 auto</b> rows for every card a character holds (counted &amp; kept automatically — no whitelist edits needed) — edit the explicit list per bot in its ⚙ config (Apply-to-all there sets every bot)</p>`
    : '<p class="muted small">nothing whitelisted yet — open a bot\'s ⚙ config and add items (they are never sold and get traded to the collector)</p>';
  for (const id of state.whOpen) {
    const det = $('wh-body').querySelector(`tr[data-whdet="${id}"]`);
    const tr = $('wh-body').querySelector(`tr[data-whrow="${id}"]`);
    if (det && tr) { det.classList.remove('hidden'); const c = tr.querySelector('.wh-chev'); if (c) c.textContent = '▾'; }
  }
  $('wh-modal').classList.remove('hidden');
}
// ⟳ — ask the collector to re-read its storage; poll until the snapshot advances (or 60s), then re-render
async function refreshCollectorStorage(btn) {
  const col = state.bots.find((b) => b.mode === 'collector');
  if (!col || state.whRefreshing) return;
  state.whRefreshing = true;
  const prevAt = state.fleet?.collectorStorage?.at ?? 0;
  if (btn) { btn.disabled = true; btn.textContent = '⟳ refreshing…'; }
  await api(`/api/bots/${col.id}/refresh-storage`, 'POST').catch(() => {});
  const t0 = Date.now();
  clearInterval(state.whWatch);
  state.whWatch = setInterval(async () => {
    const s = await api('/api/state').catch(() => null);
    if (s) { state.fleet = s.fleet ?? state.fleet; state.bots = s.bots ?? state.bots; }
    const at = state.fleet?.collectorStorage?.at ?? 0;
    if (at > prevAt || Date.now() - t0 > 60000) {
      clearInterval(state.whWatch); state.whWatch = null; state.whRefreshing = false;
      if (!$('wh-modal').classList.contains('hidden')) openWhModal();
    }
  }, 2500);
}

// ---------- kill log modal ----------
function killRows() {
  const d = state.killData; if (!d) return [];
  if (d._parsed) return d._parsed;
  const out = [];
  for (const [k, n] of Object.entries(d.rows ?? {})) {
    const i = k.indexOf('|'); const j = k.indexOf('|', i + 1);
    if (i < 0 || j < 0) continue;
    out.push({ day: k.slice(0, i), bot: +k.slice(i + 1, j), mob: k.slice(j + 1), n });
  }
  d._parsed = out;
  return out;
}
function killFiltered() {
  const f = state.killF;
  const mob = f.mob.trim().toLowerCase();
  return killRows().filter((r) => (!f.from || r.day >= f.from) && (!f.to || r.day <= f.to) && (f.bot === 'all' || String(r.bot) === String(f.bot)) && (!mob || r.mob.toLowerCase().includes(mob)));
}
const botNameOf = (id) => state.bots.find((b) => b.id === +id)?.name ?? ('#' + id);
const killEscA = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
async function fetchKills() {
  const d = await api('/api/kills').catch(() => null);
  if (d && d.rows) state.killData = d;
  return state.killData;
}
function openKillModal() {
  $('kill-modal').classList.remove('hidden');
  buildKillControls();
  fetchKills().then(() => renderKillAll());
  clearInterval(state.killWatch);
  state.killWatch = setInterval(async () => {
    if (document.hidden || $('kill-modal').classList.contains('hidden')) return;
    await fetchKills(); renderKillAll();
  }, 8000);
}
function buildKillControls() {
  const f = state.killF;
  const bots = state.bots.slice().sort((a, b) => a.id - b.id);
  $('kl-controls').innerHTML = `<div class="kl-bar">
      <span class="kl-seg">${['monster', 'bot', 'day'].map((v) => `<button class="btn small kl-v${f.view === v ? ' on' : ''}" data-v="${v}">by ${v}</button>`).join('')}</span>
      <label class="muted small">from <input type="date" id="kl-from" value="${f.from}"></label>
      <label class="muted small">to <input type="date" id="kl-to" value="${f.to}"></label>
      <label class="muted small">bot <select id="kl-bot"><option value="all">all bots</option>${bots.map((b) => `<option value="${b.id}"${String(f.bot) === String(b.id) ? ' selected' : ''}>#${b.id} ${b.name}</option>`).join('')}</select></label>
      <input type="text" id="kl-mob" placeholder="filter monster…" value="${f.mob.replace(/"/g, '&quot;')}">
      <span class="kl-sp"><button id="kl-reset" class="btn small" title="reset filters">↺ reset</button><button id="kl-refresh2" class="btn small" title="refresh now">⟳</button></span>
    </div>`;
  $('kl-controls').querySelectorAll('.kl-v').forEach((b) => { b.onclick = () => { state.killF.view = b.dataset.v; buildKillControls(); renderKillAll(); }; });
  $('kl-from').onchange = (e) => { state.killF.from = e.target.value; renderKillAll(); };
  $('kl-to').onchange = (e) => { state.killF.to = e.target.value; renderKillAll(); };
  $('kl-bot').onchange = (e) => { state.killF.bot = e.target.value; renderKillAll(); };
  $('kl-mob').oninput = (e) => { state.killF.mob = e.target.value; renderKillAll(); };
  $('kl-reset').onclick = () => { state.killF = { view: state.killF.view, from: '', to: '', bot: 'all', mob: '' }; buildKillControls(); renderKillAll(); };
  $('kl-refresh2').onclick = async () => { await fetchKills(); renderKillAll(); };
}
function renderKillAll() { renderKillTop(); renderKillChart(); renderKillResults(); }
function renderKillTop() {
  const list = killFiltered();
  const total = list.reduce((s, r) => s + r.n, 0);
  const at = state.killData?.at ? new Date(state.killData.at).toLocaleTimeString() : '—';
  $('kl-top').innerHTML = `<div class="kl-top">
      <span class="muted small"><b class="kl-big">${fmt(total)}</b> kills shown · ${new Set(list.map((r) => r.day)).size} day(s) · ${new Set(list.map((r) => r.bot)).size} bot(s) · ${new Set(list.map((r) => r.mob)).size} monster(s) · updated ${at}</span>
      ${state.killArm
        ? `<span class="kl-arm">⚠ delete the ENTIRE kill history (all bots, all days)? this cannot be undone <button id="kl-clear-yes" class="btn small bad">yes, delete</button><button id="kl-clear-no" class="btn small">cancel</button></span>`
        : '<button id="kl-clear" class="btn small bad" title="wipe the kill log (confirmation required)">🗑 clear kill log</button>'}
    </div>`;
  const arm = $('kl-clear'); if (arm) arm.onclick = () => { state.killArm = true; renderKillTop(); };
  const yes = $('kl-clear-yes');
  if (yes) yes.onclick = async () => { await api('/api/kills/clear', 'POST').catch(() => {}); state.killArm = false; state.killOpen.clear(); await fetchKills(); renderKillAll(); };
  const no = $('kl-clear-no'); if (no) no.onclick = () => { state.killArm = false; renderKillTop(); };
}
function renderKillChart() {
  const list = killFiltered();
  const by = new Map();
  for (const r of list) by.set(r.day, (by.get(r.day) ?? 0) + r.n);
  const days = [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (!days.length) { $('kl-chart').innerHTML = ''; return; }
  const max = Math.max(...days.map(([, n]) => n));
  const bw = 36, gap = 12, pad = 26, H = 158;
  const W = Math.max(560, days.length * (bw + gap) + pad * 2);
  const f = state.killF;
  const sel = f.from && f.to && f.from === f.to ? f.from : null;
  const bars = days.map(([day, n], i) => {
    const x = pad + i * (bw + gap);
    const h = Math.max(3, Math.round((n / max) * (H - 56)));
    const y = H - 26 - h;
    const hot = day === sel;
    return `<g class="klbar" data-day="${day}" style="cursor:pointer"><title>${day} — ${fmt(n)} kills${hot ? ' — click to clear the day filter' : ' — click to filter this day'}</title><rect x="${x}" y="${y}" width="${bw}" height="${h}" rx="4" fill="${hot ? 'var(--gold)' : 'url(#klg)'}"/><text x="${x + bw / 2}" y="${y - 5}" text-anchor="middle" font-size="10" fill="${hot ? 'var(--gold)' : '#cbd5e1'}">${n >= 1000 ? (n / 1000).toFixed(1) + 'k' : n}</text><text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle" font-size="9.5" fill="#64748b">${day.slice(5)}</text></g>`;
  }).join('');
  $('kl-chart').innerHTML = `<div class="kl-chart" style="overflow-x:auto"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><defs><linearGradient id="klg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#6d5cff" stop-opacity=".3"/></linearGradient></defs>${bars}</svg></div>`;
}
function renderKillResults() {
  const list = killFiltered();
  const f = state.killF;
  const total = list.reduce((s, r) => s + r.n, 0) || 1;
  let rows = [];
  if (f.view === 'monster') {
    const agg = new Map();
    for (const r of list) {
      let a = agg.get(r.mob); if (!a) { a = { n: 0, bots: new Map() }; agg.set(r.mob, a); }
      a.n += r.n; a.bots.set(r.bot, (a.bots.get(r.bot) ?? 0) + r.n);
    }
    rows = [...agg.entries()].sort((a, b) => b[1].n - a[1].n).map(([mob, a]) => ({ key: 'm:' + mob, name: mob, n: a.n, sub: `${a.bots.size} bot(s)`, chips: [...a.bots.entries()].sort((x, y) => y[1] - x[1]).map(([bid, n]) => `${botNameOf(bid)} <span class="muted">#${bid}</span> · <b>${fmt(n)}</b>`) }));
  } else if (f.view === 'bot') {
    const agg = new Map();
    for (const r of list) {
      let a = agg.get(r.bot); if (!a) { a = { n: 0, mobs: new Map() }; agg.set(r.bot, a); }
      a.n += r.n; a.mobs.set(r.mob, (a.mobs.get(r.mob) ?? 0) + r.n);
    }
    rows = [...agg.entries()].sort((a, b) => b[1].n - a[1].n).map(([bid, a]) => ({ key: 'b:' + bid, name: `${botNameOf(bid)} <span class="muted">#${bid}</span>`, n: a.n, sub: `${a.mobs.size} monster(s)`, chips: [...a.mobs.entries()].sort((x, y) => y[1] - x[1]).slice(0, 30).map(([m, n]) => `${m} · <b>${fmt(n)}</b>`) }));
  } else {
    const agg = new Map();
    for (const r of list) {
      let a = agg.get(r.day); if (!a) { a = { n: 0, mobs: new Map(), bots: new Set() }; agg.set(r.day, a); }
      a.n += r.n; a.mobs.set(r.mob, (a.mobs.get(r.mob) ?? 0) + r.n); a.bots.add(r.bot);
    }
    const wd = (d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(d + 'T12:00:00').getDay()] ?? '';
    rows = [...agg.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([day, a]) => ({ key: 'd:' + day, name: `${day} <span class="muted">${wd(day)}</span>`, n: a.n, sub: `${a.bots.size} bot(s)`, chips: [...a.mobs.entries()].sort((x, y) => y[1] - x[1]).slice(0, 30).map(([m, n]) => `${m} · <b>${fmt(n)}</b>`) }));
  }
  const heads = f.view === 'monster' ? ['monster', 'bots'] : f.view === 'bot' ? ['bot', 'monsters'] : ['day', 'bots active'];
  $('kl-results').innerHTML = rows.length ? `<table class="bagt wht"><thead><tr><th>${heads[0]}</th><th>kills</th><th>share</th><th>${heads[1]}</th></tr></thead><tbody>${rows.map((r) => `
      <tr class="wh-item" data-krow="${killEscA(r.key)}" title="click for the breakdown"><td><span class="wh-chev">${state.killOpen.has(r.key) ? '▾' : '▸'}</span> ${r.name}</td><td class="bl-mono"><b>${fmt(r.n)}</b></td><td class="muted">${(r.n / total * 100).toFixed(1)}%</td><td class="muted">${r.sub}</td></tr>
      <tr class="wh-det hidden" data-kdet="${killEscA(r.key)}"><td colspan="4">${r.chips.map((c) => `<span class="tr-chip wh-chip">${c}</span>`).join(' ')}</td></tr>`).join('')}</tbody></table>
      <p class="muted small">stored server-side in <code>data/kill-log.json</code> — accumulates until you clear it · click a chart bar to filter that day (click again to clear) · rows expand for per-bot / per-monster breakdowns · days = server local time</p>`
    : '<p class="muted small">no kills match the current filters — the log fills up as bots farm</p>';
  for (const key of state.killOpen) {
    const det = [...$('kl-results').querySelectorAll('[data-kdet]')].find((el) => el.dataset.kdet === key);
    const tr = [...$('kl-results').querySelectorAll('[data-krow]')].find((el) => el.dataset.krow === key);
    if (det && tr) { det.classList.remove('hidden'); const c = tr.querySelector('.wh-chev'); if (c) c.textContent = '▾'; }
  }
}

// ---------- bot detail modal (stats + skills + scrolls) ----------
function openBotModal(id) {
  state.botModalId = id;
  renderBotModal();
  $('bot-modal').classList.remove('hidden');
  clearInterval(state.botWatch);
  state.botWatch = setInterval(() => {
    if (document.hidden || $('bot-modal').classList.contains('hidden')) return;
    renderBotModal();
  }, 3000);
}
function normSkills(sk) {
  if (Array.isArray(sk)) return sk.map((e) => [e?.id ?? e?.skillId, e?.level ?? 1]).filter(([id]) => !!id);
  if (sk && typeof sk === 'object') return Object.entries(sk).map(([id, v]) => [id, typeof v === 'object' ? (v?.level ?? 0) : (v ?? 0)]);
  return [];
}
function renderBotModal() {
  const b = state.bots.find((x) => x.id === state.botModalId);
  if (!b) { $('botm-body').innerHTML = '<p class="muted small">bot not found</p>'; return; }
  const s = b.status ?? {};
  $('botm-title').innerHTML = `${b.name} <span class="muted">#${b.id} · ${b.mode} · ${s.classId ?? '?'}</span>`;
  const st = s.stats ?? {};
  const target = { DEX: 30, AGI: 30, VIT: 20 };
  const statRows = ['STR', 'AGI', 'VIT', 'INT', 'DEX', 'LUK'].map((k) => {
    const v = st[k] ?? 0;
    const tgt = target[k];
    const low = tgt != null && v < tgt;
    return `<tr><td class="muted">${k}</td><td class="bl-mono"${low ? ' style="color:var(--gold)"' : ''}><b>${v}</b>${low ? ` <span class="muted small">/ ${tgt}</span>` : ''}</td></tr>`;
  }).join('');
  const sk = normSkills(s.skills).sort((a, b2) => b2[1] - a[1]);
  const skRows = sk.length
    ? sk.map(([id, lv]) => `<tr><td>${skillNameOf(id)} <span class="muted small">${id}</span></td><td class="bl-mono"><b>${lv}</b></td></tr>`).join('')
    : '<tr><td colspan="2" class="muted small">no skills in the last heartbeat — try again in a moment</td></tr>';
  // equipment + gems (2026-10-07) — slot list mirrors the game's equipment panel: gear 12 · costumes · gems 1–4
  const EQ_LABEL = { 'main-hand': '⚔ main hand', 'off-hand': '🛡 off hand', 'head-upper': '🎩 head upper', 'head-middle': '👓 head middle', 'head-lower': '📿 head lower', armor: '🧥 armor', garment: '🧣 garment', gloves: '🧤 gloves', legs: '👖 legs', boots: '🥾 boots', 'accessory-left': '💍 acc left', 'accessory-right': '💍 acc right', 'gem-1': '💎 gem 1', 'gem-2': '💎 gem 2', 'gem-3': '💎 gem 3', 'gem-4': '💎 gem 4', 'costume-head-upper': '👒 costume top', 'costume-head-mid': '👒 costume mid', 'costume-spirit': '👻 costume spirit', 'costume-head-low': '👒 costume low', 'costume-garment': '🧣 costume garment' };
  const GEAR = ['main-hand', 'off-hand', 'head-upper', 'head-middle', 'head-lower', 'armor', 'garment', 'gloves', 'legs', 'boots', 'accessory-left', 'accessory-right'];
  const GEMS = ['gem-1', 'gem-2', 'gem-3', 'gem-4'];
  const eq = s.equipment ?? [];
  const bySlot = new Map(eq.map((e) => [e.slot, e]));
  const eqRow = (k) => {
    const it = bySlot.get(k);
    return `<tr><td class="muted">${EQ_LABEL[k] ?? k}</td><td>${it ? `<b>${esc(it.name)}</b>${it.refine ? ` <span class="rf">+${it.refine}</span>` : ''}` : '<span class="muted">—</span>'}</td></tr>`;
  };
  const gearRows = GEAR.map(eqRow).join('');
  const gemRows = GEMS.map(eqRow).join('');
  const gemCount = GEMS.filter((k) => bySlot.has(k)).length;
  const hasCostumes = Object.keys(EQ_LABEL).some((k) => k.startsWith('costume-') && bySlot.has(k));
  const bagGemAgg = new Map();
  for (const it of (s.inventory ?? [])) if (/gem\s*\d+%/i.test(it.name ?? '')) bagGemAgg.set(it.name, (bagGemAgg.get(it.name) ?? 0) + (it.qty ?? 1));
  const bagGems = [...bagGemAgg.entries()].sort((a, b2) => b2[1] - a[1]).map(([n, q]) => `<span class="tr-chip wh-chip">${esc(n)} ×${q}</span>`).join(' ') || '<span class="muted small">none in the bag</span>';
  const scrollCls = (s.weightScrolls ?? 0) >= 10 ? 'scroll-ok' : 'scroll-pend';
  $('botm-body').innerHTML = `
    <div class="muted small" style="margin-bottom:8px">base <b>${s.base ?? '?'}</b>/job <b>${s.job ?? '?'}</b> · map <b>${s.map ?? '—'}</b>${s.channel != null ? ` · CH <b>${s.channel}</b>` : ''} · HP <b>${s.dead ? 0 : Math.round(s.hp ?? 0)}/${s.maxHp ?? '?'}</b> · SP <b>${Math.round(s.sp ?? 0)}/${s.maxSp ?? '?'}</b> · ⚔ <b>${fmt(s.killsTotal ?? 0)}</b> kills · zeny <b>z ${fmt(s.zeny)}</b> · weight <b>${fmt(s.bag?.weight)}/${fmt(s.bag?.weightLimit)}</b> · 🧾 <b class="${scrollCls}" title="consumed weight-limit scrolls (permanent +weight, max 10)">${s.weightScrolls ?? 0}/10</b> · ${s.dead ? '<span class="dead">☠ dead</span>' : 'alive'}</div>
    <div class="bm-grid">
      <div>
        <div class="cfg-lab">stats${(s.statusPoints ?? 0) > 0 ? ` — <span style="color:var(--gold)">${fmt(s.statusPoints)} unspent</span>` : ''}</div>
        <table class="bagt"><thead><tr><th>stat</th><th>value <span class="muted">(guide: DEX 30 → AGI 30 → VIT 20 → rest STR)</span></th></tr></thead><tbody>${statRows}</tbody></table>
      </div>
      <div>
        <div class="cfg-lab">skills${(s.skillPoints ?? 0) > 0 ? ` — <span style="color:var(--gold)">${fmt(s.skillPoints)} points unspent</span>` : ''}</div>
        <table class="bagt"><thead><tr><th>skill</th><th>lv</th></tr></thead><tbody>${skRows}</tbody></table>
      </div>
      <div>
        <div class="cfg-lab">equipment</div>
        <table class="bagt"><thead><tr><th>slot</th><th>item</th></tr></thead><tbody>${gearRows}</tbody></table>
      </div>
      <div>
        <div class="cfg-lab">gems — <b>${gemCount}/4</b> equipped</div>
        <table class="bagt"><thead><tr><th>slot</th><th>gem</th></tr></thead><tbody>${gemRows}</tbody></table>
        <div class="cfg-lab" style="margin-top:8px">gems in the bag</div>
        <div style="line-height:1.9;margin-top:4px">${bagGems}</div>
        ${hasCostumes ? `<div class="cfg-lab" style="margin-top:8px">costumes</div><table class="bagt"><tbody>${Object.keys(EQ_LABEL).filter((k) => k.startsWith('costume-')).map(eqRow).join('')}</tbody></table>` : ''}
      </div>
    </div>`;
}

// ---------- saved plans modal ----------
function openPlansModal() { renderPlans(); $('plans-modal').classList.remove('hidden'); }
function planCfgFromBot(bot) {
  return { ...(bot.cfg ?? {}), mode: bot.mode, keep: (bot.cfg?.keep ?? []).slice() };
}
function renderPlans() {
  const plans = state.plans ?? [];
  const selCount = state.sel.size;
  $('pl-selcount').textContent = selCount;
  const src = $('pl-from');
  const prev = src.value;
  src.innerHTML = '<option value="blank">✨ start from scratch (blank plan)</option>' + state.bots.filter((b) => b.mode !== 'collector').map((b) => `<option value="${b.id}">#${b.id} ${esc(b.name)} — ${b.mode}</option>`).join('');
  if (prev && [...src.options].some((o) => o.value === prev)) src.value = prev;
  $('pl-list').innerHTML = plans.length
    ? `<table class="bagt wht"><thead><tr><th>plan</th><th>bots on it</th><th>updated</th><th></th></tr></thead><tbody>${plans.map((pl) => {
        const users = state.bots.filter((b) => b.plan?.id === pl.id);
        return `<tr><td>📋 ${esc(pl.name)}</td><td class="muted" title="${esc(users.map((u) => u.name).join(', '))}">${users.length}</td><td class="muted">${pl.updatedAt ? new Date(pl.updatedAt).toLocaleString() : ''}</td><td style="text-align:right"><button class="btn small" data-pledit="${pl.id}" title="open the full plan editor (configure from scratch)">✎ edit</button> <button class="btn small ok" data-plapply="${pl.id}" ${selCount ? '' : 'disabled'} title="${selCount ? `apply to the ${selCount} ticked bot(s)` : 'tick bots on the dashboard first'}">▶ apply to ${selCount} selected</button> <button class="btn small" data-plupdate="${pl.id}" title="re-capture this plan from the source bot's live settings">⤓ update from source</button> <button class="btn small bad" data-pldel="${pl.id}" title="delete this plan (configs already applied stay)">🗑</button></td></tr>`;
      }).join('')}</tbody></table>`
    : '<p class="muted small">no plans yet — create one above by copying a running bot\'s live settings, or save the ⚙ config form with “💾 save as plan”</p>';
}

// ---------- selection scope (2026-10-09): the header summary strip + whitelist modal follow the TICKED bots.
// Nothing ticked = the whole fleet. Clicking a group pill already ticks the whole group → one click scopes
// every number to that group; ✕ deselect all (or unticking everything) widens them back to fleet-wide.
function scopeInfo() {
  if (!state.sel.size) return { ids: null, n: state.bots.length, tag: 'all bots', tagShort: 'total', custom: false };
  const f = state.groupFilter;
  if (f) {
    const members = state.bots.filter((b) => (f === '__ungrouped__' ? !groupOf(b) : groupOf(b) === f)).filter((b) => b.mode !== 'collector');
    if (members.length && members.length === state.sel.size && members.every((b) => state.sel.has(b.id))) {
      const tag = f === '__ungrouped__' ? 'ungrouped' : `“${f}”`;
      return { ids: state.sel, n: state.sel.size, tag, tagShort: tag, custom: false };
    }
  }
  return { ids: state.sel, n: state.sel.size, tag: 'ticked', tagShort: 'ticked', custom: true };
}
// re-render everything that follows the ticked selection (header summary + the whitelist modal if it is open)
function renderScopeViews() { renderKpis(); if (!$('wh-modal').classList.contains('hidden')) openWhModal(); }

function renderKpis() {
  const sc = scopeInfo();
  const scoped = !!sc.ids;
  const b = state.bots.filter((x) => !sc.ids || sc.ids.has(x.id));
  const by = (s) => b.filter((x) => x.state === s).length;
  const ALIVE_ST = ['running', 'starting', 'paused', 'pausing', 'stalled', 'restarting'];
  const alive = b.filter((x) => ALIVE_ST.includes(x.state));
  const kills = alive.reduce((a, x) => a + (x.status?.killsTotal ?? 0), 0);
  const zeny = alive.reduce((a, x) => a + (x.status?.zeny ?? 0), 0);
  const base = alive.filter((x) => x.status?.base).map((x) => x.status.base);
  // the collectors' zeny (fleet bank) — deliberately NOT scoped: group scopes never absorb the pooled treasury
  const colBanks = state.bots.filter((x) => x.mode === 'collector' && !x.retired && ALIVE_ST.includes(x.state));
  const bank = colBanks.reduce((a, x) => a + (x.status?.zeny ?? 0), 0);
  const bankTitle = colBanks.length ? `collector bank — zeny held by the ${colBanks.length} collector(s): ${colBanks.map((x) => `${x.name} ${fmt(x.status?.zeny ?? 0)}`).join(' · ')} (live heartbeat). Stays fleet-level: scopes never absorb it — tick a collector's own card to fold its zeny into the zeny figure.` : 'no collector online — the bank sits here (as —) until a collector runs';
  const wl = whitelistTotals({ ids: sc.ids });
  const wh = wl.rows.length ? wl.totals.bots + wl.totals.bStore + wl.totals.cBag + wl.totals.cStore : null;
  const cap = b.reduce((a, x) => { const c = x.status?.captchas; if (c) { a.ans += c.answered ?? 0; a.suc += c.success ?? 0; a.wr += c.wrong ?? 0; } return a; }, { ans: 0, suc: 0, wr: 0 });
  const scopeTile = `<div class="kpi k-scope${scoped ? ' on' : ''}" title="${scoped ? `these numbers cover the ${sc.n} ticked bot(s) — untick everything (✕ deselect all) to widen them back to the whole fleet` : 'these numbers cover the whole fleet — tick bots (or click a group pill) to scope them to that group'}"><div class="k-ic">🎯</div><div class="k-tx"><div class="k-v">${fmt(sc.n)}</div><div class="k-l">scope · ${esc(sc.tag)}</div></div></div>`;
  const tiles = [
    ['k-ok', '●', by('running'), 'running'],
    ['k-sky', '⏸', by('paused'), 'paused'],
    ['k-bad', '✖', by('error'), 'error'],
    ['k-acc', '⚔', fmt(kills), 'kills', 'kpi-kills', 'click for the kill log — breakdowns by monster / bot / day'],
    ['k-gold', 'z', fmt(zeny), 'zeny', null, scoped ? "the ticked bots' zeny — collectors count only if you tick one (group pills never do; the 💼 bank stays separate)" : "every alive bot's zeny, collectors included — their pooled share is broken out in the 💼 collector bank tile"],
    ['k-treas', '💼', colBanks.length ? fmt(bank) : '—', 'collector bank', 'kpi-treas', bankTitle],
    ['k-cyan', '▲', base.length ? `${Math.min(...base)}–${Math.max(...base)}` : '—', 'base level'],
    ['k-cap', '🛡', cap.ans ? `${fmt(cap.suc)} / ${fmt(cap.ans)}` : '—', 'captcha survived', 'kpi-cap', "anti-cheat 'human check' survival — cleared / answered. Click for the captcha log."],
  ];
  $('kpis').innerHTML = scopeTile + tiles.map(([cls, ic, v, l, id, title]) =>
    `<div class="kpi ${cls}${id ? ' clickable' : ''}"${id ? ` id="${id}"` : ''}${title ? ` title="${title}"` : ''}><div class="k-ic">${ic}</div><div class="k-tx"><div class="k-v">${v}</div><div class="k-l">${l}</div></div></div>`
  ).join('') + `<div class="kpi k-wh clickable" id="kpi-wh" title="whitelist items + every card seen in a character — bot bags + bot storage${scoped ? ` — scoped to the ${sc.n} ticked bot(s)` : ' + collector bag + collector storage (last seen)'}"><div class="k-ic">🧺</div><div class="k-tx"><div class="k-v">${wh == null ? '—' : fmt(wh)}</div><div class="k-l">whitelist · ${esc(sc.tagShort)}</div></div></div>`;
  const kw = document.getElementById('kpi-wh');
  if (kw) kw.onclick = openWhModal;
  const kk = document.getElementById('kpi-kills');
  if (kk) kk.onclick = openKillModal;
  const kt = document.getElementById('kpi-treas');
  if (kt) kt.onclick = () => document.querySelector('nav button[data-tab="collector"]')?.click();
  const kc = document.getElementById('kpi-cap');
  if (kc) kc.onclick = () => document.querySelector('nav button[data-tab="captchas"]')?.click();
}

// ---------- captchas — anti-cheat survival log ----------
function renderCaptchas() {
  const withCap = (state.bots ?? []).filter((x) => { const c = x.status?.captchas; return c && (c.answered || c.wrong || c.success || c.prompts); })
    .sort((a, b) => (b.status?.captchas?.lastAt ?? 0) - (a.status?.captchas?.lastAt ?? 0));
  const tot = withCap.reduce((a, x) => { const c = x.status.captchas; a.ans += c.answered ?? 0; a.suc += c.success ?? 0; a.wr += c.wrong ?? 0; return a; }, { ans: 0, suc: 0, wr: 0 });
  const rate = tot.ans ? Math.round(tot.suc / tot.ans * 100) : null;
  const lastAt = Math.max(0, ...withCap.map((x) => x.status.captchas.lastAt ?? 0));
  const tf = (ms) => ms ? new Date(ms).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  const tile = (ic, v, l, tip) => `<div class="kpi"${tip ? ` title="${tip}"` : ''}><div class="k-ic">${ic}</div><div class="k-tx"><div class="k-v">${v}</div><div class="k-l">${l}</div></div></div>`;
  const el = $('cap-summary');
  if (el) el.innerHTML =
    tile('🎯', fmt(tot.ans), 'challenges answered') +
    tile('🛡️', fmt(tot.suc), 'survived') +
    tile('❌', fmt(tot.wr), 'failed') +
    tile('📈', rate == null ? '—' : rate + '%', 'success rate', 'survived ÷ answered — 100% = every check cleared, no retries') +
    tile('⏱️', lastAt ? tf(lastAt) : '—', 'last cleared');
  const tb = document.querySelector('#captchas-table tbody');
  if (!tb) return;
  tb.innerHTML = withCap.map((x) => {
    const c = x.status.captchas;
    const r = c.answered ? Math.round((c.success ?? 0) / c.answered * 100) : null;
    return `<tr>
      <td><b>${esc(x.name)}</b> <span class="idtag">#${x.id} · ${esc(x.mode ?? '')}</span></td>
      <td><span class="state st-${x.state}">${x.state}</span></td>
      <td>${esc(x.status.map ?? '—')}</td>
      <td title="challenge messages received (also counts the server's clear/dismiss message — may read +1 per cleared check)">${c.prompts ?? 0}</td>
      <td>${c.answered ?? 0}</td>
      <td><b>${c.success ?? 0}</b></td>
      <td>${c.wrong ?? 0}</td>
      <td>${r == null ? '—' : r + '%'}</td>
      <td>${esc(String(c.lastResult ?? '—'))}</td>
      <td>${tf(c.lastAt)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="10" class="muted">no captcha activity recorded yet — this log fills as human checks arrive</td></tr>';
}

function botCard(b) {
  const s = b.status ?? {};
  const hpPct = s.maxHp ? Math.round((s.hp ?? 0) / s.maxHp * 100) : 0;
  const spPct = s.maxSp ? Math.round((s.sp ?? 0) / s.maxSp * 100) : 0;
  return `<div class="card st-${b.state} ${state.selectedLog === b.id ? 'sel' : ''}" data-bot="${b.id}">
      <div class="top">
        <input type="checkbox" data-sel="${b.id}" ${state.sel.has(b.id) ? 'checked' : ''} />
        <span class="dot"></span>
        <span class="name">${b.name}</span>
        <span class="state st-${b.state}">${b.state}</span>
        <span class="idtag">#${b.id} · ${b.mode}</span>
      </div>
      <div class="meta">
        ${activityBadge(b, s)}
        <span class="badge">${s.classId ?? '?'}</span>
        ${gearDots(b)}
        <span class="lv">base <b>${s.base ?? '?'}</b></span>
        <span class="lv">job <b>${s.job ?? '?'}</b></span>
        <span class="map">${s.map ?? '—'}${s.channel != null ? ` · CH ${s.channel}` : ''}</span>
        <span class="ms tor" title="Tor exit IP this session (logged before the bot touches the server)">🧅 ${b.exitIp ?? '—'}</span>
        <span class="ms">z ${fmt(s.zeny)}</span>
        <span class="ms ${(s.weightScrolls ?? 0) >= 10 ? 'scroll-ok' : 'scroll-pend'}" title="weight-limit scrolls consumed (permanent +weight, max 10)">🧾 ${s.weightScrolls ?? 0}/10</span>
        ${b.plan ? `<span class="ms plan-chip" title="plan \u201c${esc(b.plan.name)}\u201d applied ${new Date(b.plan.at ?? 0).toLocaleString()}">📋 ${esc(b.plan.name)}</span>` : ''}
        ${b.group ? `<span class="ms" title="group">📁 ${esc(b.group)}</span>` : ''}
        ${s.pets?.owned ? `<span class="ms pet">pet ${s.pets.active ? '✓' : s.pets.owned}</span>` : ''}
      </div>
      <div class="vitals">
        <div class="barpair"><span class="bl">HP</span><div class="vbar hpb"><i style="width:${hpPct}%"></i></div><span class="val">${s.dead ? '0' : (s.hp > 0 ? Math.round(s.hp) : '~')}/${s.maxHp ?? '?'}</span></div>
        <div class="barpair"><span class="bl">SP</span><div class="vbar spb"><i style="width:${spPct}%"></i></div><span class="val">${Math.round(s.sp ?? 0)}/${s.maxSp ?? '?'}</span></div>
      </div>
      <div class="step"><span class="st-lab">STEP</span> <span class="st-meta">${s.step ?? '—'}${s.dead ? ' · ' : ''}</span>${s.dead ? '<span class="dead">☠ dead</span>' : ''}</div>
      <div class="foot">
        <button class="btn ok small" data-act="play" data-id="${b.id}" title="play">▶</button>
        <button class="btn warn small" data-act="pause" data-id="${b.id}" title="pause">⏸</button>
        <button class="btn bad small" data-act="stop" data-id="${b.id}" title="stop">⏹</button>
        <button class="btn small" data-stat="${b.id}" title="stats & skills">📊</button>
        <button class="btn small" data-cfg="${b.id}" title="config (auto-combat, weave, channel, collect)">⚙</button>
        ${b.mode !== 'collector' ? `<button class="btn small" data-collect="${b.id}" title="queue collection to collector">⇪</button>` : ''}
        <button class="btn small" data-kick="${b.id}" title="force online — kick this character's previous (stale) session so it can log in — use when stuck at 'already online'">🔓</button>
        <span class="exits">${b.lastExit ? `exit ${b.lastExit.code}` : ''}${b.restarts ? `${b.lastExit ? ' · ' : ''}↻${b.restarts}` : ''}</span>
      </div>
    </div>`;
}

// compact one-liner shown while the treasury panel is collapsed
function renderCollectorSum(colBots) {
  const sum = $('collector-sum');
  if (!sum) return;
  const b = colBots[0];
  if (!b) { sum.textContent = ''; return; }
  const s = b.status ?? {};
  const q = (state.collect?.queue?.length ?? 0) + (state.collect?.actives?.length ?? (state.collect?.active != null ? 1 : 0));
  sum.textContent = `${b.name} · ${b.state} · bag ${s.bag?.used ?? '?'} · z ${fmt(s.zeny)}${q ? ` · queue ${q}` : ''}`;
}

// ---------- groups (dashboard filter + bulk operations over a group) ----------
const groupOf = (b) => (b.group ? String(b.group) : '');
const saveSel = () => { try { localStorage.setItem('cc.sel', JSON.stringify([...state.sel])); } catch {} };
function groupedBots() {
  const f = state.groupFilter;
  if (!f) return state.bots;
  if (f === '__ungrouped__') return state.bots.filter((b) => !groupOf(b));
  return state.bots.filter((b) => groupOf(b) === f);
}
let _groupBarSig = null;
function renderGroupBar() {
  const bar = $('group-bar');
  if (!bar) return;
  const bots = state.bots;
  const groups = [...new Set(bots.map(groupOf).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (state.groupFilter && state.groupFilter !== '__ungrouped__' && !groups.includes(state.groupFilter)) state.groupFilter = null;
  const un = bots.filter((b) => !groupOf(b)).length;
  // build the bar ONCE — the live re-renders every ~2s used to replace these buttons mid-click (clicks silently
  // swallowed) and native prompt() can be suppressed by the browser after repeated dialogs → "group" felt broken
  if (!bar.dataset.ready) {
    bar.dataset.ready = '1';
    bar.innerHTML =
      '<span class="muted small" style="font-weight:700;letter-spacing:1px;margin-right:2px">GROUPS</span>' +
      '<span id="gchips" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"></span>' +
      '<span style="flex:1"></span>' +
      '<span id="gmsg" class="muted small" style="margin-right:2px"></span>' +
      '<button class="btn small" id="gset" title="assign the ticked bots to a group — create a new group or move them between groups">📁 assign ticked…</button>' +
      '<span id="gedit" style="display:none;align-items:center;gap:4px">' +
      '<select id="gsel" title="move the ticked bots to an existing group — applies immediately (∅ = ungroup)" style="background:#0b1220;color:#e5e7eb;border:1px solid #2a3550;border-radius:6px;padding:4px 6px;font:inherit;max-width:170px"></select>' +
      '<input id="gname" list="glist" placeholder="or type a new name (empty = ungroup)" style="background:#0b1220;color:#e5e7eb;border:1px solid #2a3550;border-radius:6px;padding:4px 8px;font:inherit;width:190px" />' +
      '<datalist id="glist"></datalist>' +
      '<button class="btn small ok" id="gok">✓ apply</button>' +
      '<button class="btn small" id="gx">✕</button>' +
      '</span>' +
      '<button class="btn small" id="rs-sel" title="restart the ticked bots (stop → wait → start — needed after mode changes)">↻ restart ticked</button>' +
      '<button class="btn small" id="gsync" title="enroll included characters (Accounts tab) that have no dashboard bot yet">⟲ enroll</button>' +
      '<button class="btn small" id="sel-gearless" title="replace the selection with every knight (in the current view) missing required gear — the red dots">⚠ select gearless</button>' +
      '<button class="btn small ok" id="gearup" title="queue the ticked incomplete knights for gear-up — the richest collector buys the missing pieces and delivers them">🛒 gear up</button>' +
      '<button class="btn small ok" id="gcollect" title="queue the ticked bots for a collection turn — they sell junk and trade whitelist + zeny to the collectors (moved from the Collector tab)">⇪ collect ticked</button>';
    $('gset').onclick = () => {
      $('gmsg').textContent = state.sel.size ? `${state.sel.size} ticked — pick a group to move them to, or type a new name:` : 'tick bots first — shift+click selects a range, or click a group pill to select the whole group';
      $('gedit').style.display = 'inline-flex';
      $('gname').focus();
    };
    const applyGroup = async (name) => {
      const ids = [...state.sel];
      const msg = $('gmsg');
      if (!ids.length) { msg.textContent = 'tick bots first (checkbox on each card / row; shift+click selects a range)'; return; }
      const r = await api('/api/bots/group', 'POST', { ids, group: name });
      msg.textContent = r.ok ? (r.group ? `✓ grouped ${r.updated} \u2192 \u201c${r.group}\u201d` : `✓ cleared group on ${r.updated} bot(s)`) : `\u2717 ${r.error ?? 'group failed'}`;
      $('gedit').style.display = 'none';
      $('gname').value = '';
      $('gsel').value = '__pick__';
      _groupBarSig = null; // force chips + move-dropdown refresh (group→group moves change counts without a new name)
      refreshState();
    };
    $('gok').onclick = () => applyGroup($('gname').value.trim());
    $('gname').onkeydown = (e) => { if (e.key === 'Enter') applyGroup($('gname').value.trim()); if (e.key === 'Escape') $('gedit').style.display = 'none'; };
    $('gsel').onchange = () => { const v = $('gsel').value; if (v === '__pick__') return; applyGroup(v); };
    $('gx').onclick = () => { $('gedit').style.display = 'none'; };
    $('rs-sel').onclick = async () => {
      const ids = [...state.sel];
      if (!ids.length) { $('gmsg').textContent = 'tick bots first'; return; }
      if (!confirm(`restart ${ids.length} ticked bot(s)?`)) return;
      await api('/api/bots/restart-many', 'POST', { ids });
      setTimeout(refreshState, 800);
    };
    $('gsync').onclick = async () => {
      const r = await api('/api/bots/sync', 'POST', {});
      $('gmsg').textContent = r.created ? `✓ enrolled ${r.created} new bot(s) — stopped` : 'nothing new to enroll';
      refreshState();
    };
    $('sel-gearless').onclick = () => {
      const bad = groupedBots().filter((b) => { const g = gearStatus(b); return g.knight && (g.gems === false || g.weapon === false); });
      state.sel = new Set(bad.map((b) => b.id));
      state.botSelIdx = -1; // programmatic selection breaks the shift anchor
      saveSel();
      renderBots();
      renderScopeViews();
      $('gmsg').textContent = bad.length ? `${bad.length} gearless knight(s) ticked — hit 🛒 gear up` : 'all knights shown are fully geared ✓';
    };
    $('gearup').onclick = async () => {
      const ids = [...state.sel].filter((id) => { const b = state.bots.find((x) => x.id === id); const g = b ? gearStatus(b) : null; return g && g.knight && (g.gems === false || g.weapon === false); });
      const msg = $('gmsg');
      if (!ids.length) { msg.textContent = state.sel.size ? 'none of the ticked bots need gear (must be a knight with a red dot)' : 'tick knights first — ⚠ select gearless picks them for you'; return; }
      msg.textContent = `queuing ${ids.length} bot(s) for gear-up…`;
      const r = await api('/api/shop/queue', 'POST', { ids }).catch((e) => ({ error: String((e && e.message) || e) }));
      msg.textContent = r?.ok
        ? `✓ queued ${r.queued} bot(s) → ${r.collector ?? 'richest collector'}${r.skipped ? ` · skipped ${r.skipped}` : ''} — see the Shopping tab`
        : `✗ ${r?.error ?? 'queue failed'}`;
      refreshState();
    };
    $('gcollect').onclick = async () => {
      const msg = $('gmsg');
      const ids = [...state.sel].filter((id) => { const b = state.bots.find((x) => x.id === id); return b && b.mode !== 'collector' && (b.state === 'running' || b.state === 'starting'); });
      if (!ids.length) { msg.textContent = state.sel.size ? 'none of the ticked bots are online' : 'tick bots first — click a group pill to select a whole group, then hit ⇪ collect ticked'; return; }
      msg.textContent = `queuing ${ids.length} bot(s) for collection…`;
      let ok = 0; const errs = {};
      for (const id of ids) {
        const r = await api(`/api/bots/${id}/collect`, 'POST').catch(() => ({}));
        if (r?.ok) ok++; else if (r?.error) errs[r.error] = (errs[r.error] ?? 0) + 1;
      }
      const eTxt = Object.keys(errs).length ? ` · ${Object.entries(errs).map(([e, n]) => `${n} ${e}`).join('; ')}` : '';
      msg.textContent = `⇪ queued ${ok} bot(s)${eTxt}`;
      refreshState();
    };
  }
  const cnts = groups.map((g) => [g, bots.filter((b) => groupOf(b) === g).length]);
  const sig = JSON.stringify([cnts, un, bots.length, state.groupFilter]);
  if (sig === _groupBarSig) return;
  _groupBarSig = sig;
  // keep the toolbar checkbox honest about its scope — it selects exactly what the active filter shows
  const labEl = $('sel-all')?.parentElement;
  if (labEl) {
    const tn = [...labEl.childNodes].find((n) => n.nodeType === 3);
    if (tn) tn.textContent = ` select all shown (${groupedBots().length})`;
  }
  // one click on a group pill = view + tick that whole group (then ▶ Play selected / 📋 Plans → apply to selected)
  const chip = (key, label, n, title) => `<button class="btn small${state.groupFilter === key ? ' ok' : ''}" data-gfilter="${esc(key)}" title="${esc(title)}">${label} <b>${n}</b></button>`;
  const chips = $('gchips');
  const cnt = (g) => bots.filter((b) => groupOf(b) === g).length;
  chips.innerHTML =
    chip('__all__', '🌐 all', bots.length, 'show every bot (does not select)') +
    groups.map((g) => chip(g, `📁 ${esc(g)}`, cnt(g), `view + select all ${cnt(g)} bots in “${g}”`)).join('') +
    (un ? chip('__ungrouped__', '∅ ungrouped', un, 'view + select all bots with no group') : '') +
    (state.groupFilter && state.groupFilter !== '__ungrouped__' && groups.includes(state.groupFilter)
      ? `<button class="btn small bad" id="gdissolve" title="remove “${esc(state.groupFilter)}” from its bots — they become ungrouped">🗑 dissolve “${esc(state.groupFilter)}”</button>`
      : '');
  chips.querySelectorAll('[data-gfilter]').forEach((el) => {
    el.onclick = () => {
      const k = el.dataset.gfilter;
      const msg = $('gmsg');
      if (k === '__all__') {
        state.groupFilter = null;
        renderBots();
        msg.textContent = `showing all ${bots.length} bots`;
        return;
      }
      state.groupFilter = k;
      const members = groupedBots().filter((b) => b.mode !== 'collector');
      // REPLACE the selection — clicking a group pill selects exactly that group (was additive → fleet+leveling
      // accumulated to 100 ticked, which then showed up as “apply to 100 selected” in the Plans modal)
      state.sel = new Set(members.map((b) => b.id));
      state.botSelIdx = -1; // programmatic selection breaks the shift anchor
      saveSel();
      renderBots();
      renderScopeViews();
      msg.textContent = `${members.length} ticked — ▶ Play selected · ⏹ Stop selected · 📋 Plans → apply to selected`;
    };
  });
  // move-to-existing dropdown + name autocomplete — repopulated whenever the group set/counts change
  const gselEl = $('gsel'); const glistEl = $('glist');
  if (gselEl) gselEl.innerHTML = '<option value="__pick__">— move to existing… —</option>'
    + '<option value="">∅ ungroup</option>'
    + groups.map((g) => `<option value="${esc(g)}">📁 ${esc(g)} (${cnt(g)})</option>`).join('');
  if (glistEl) glistEl.innerHTML = groups.map((g) => `<option value="${esc(g)}"></option>`).join('');
  const gd = $('gdissolve');
  if (gd) gd.onclick = async () => {
    const k = state.groupFilter;
    const members = state.bots.filter((b) => groupOf(b) === k);
    const r = await api('/api/bots/group', 'POST', { ids: members.map((b) => b.id), group: '' });
    state.groupFilter = null;
    _groupBarSig = null;
    $('gmsg').textContent = r.ok ? `✓ dissolved “${k}” — ${r.updated} bot(s) ungrouped` : `✗ ${r.error ?? 'failed'}`;
    refreshState();
    renderBots();
  };
}

// list-only since 2026-10-08 (card view removed per user) — collector stays pinned in its own section above
function renderBots() { renderBotsList(); }

function renderAccounts() {
  const tb = $('accounts-table').querySelector('tbody');
  const pwCell = (a) => {
    const id = a.id;
    if (state.pwShow.has(id) && state.pw.has(id)) {
      return `<td><span class="pw shown">${state.pw.get(id)}</span> <button class="btn small" data-pw="${id}">hide</button> <button class="btn small" data-pwcopy="${id}">copy</button></td>`;
    }
    return `<td><span class="pw">••••••••</span> <button class="btn small" data-pw="${id}">reveal</button></td>`;
  };
  const rows = [];
  // collector accounts live in the Collector tab; retired accounts are hidden everywhere (2026-10-08)
  const colNames = new Set((state.bots ?? []).filter((b) => b.mode === 'collector').map((b) => b.name));
  const visibleAccounts = (state.accounts ?? []).filter((a) => !a.retired && !(a.chars ?? []).some((c) => colNames.has(c.name)));
  const selCell = (a) => `<td><input type="checkbox" data-accsel="${a.id}" ${state.accSel.has(a.id) ? 'checked' : ''} /></td>`;
  for (const a of visibleAccounts) {
    const chars = a.chars ?? [];
    if (!chars.length) {
      rows.push(`<tr>${selCell(a)}<td>${a.label ?? ''}</td><td class="muted">${a.userId}</td>${pwCell(a)}<td>${a.type ?? ''}</td><td class="muted">— none —</td><td></td><td></td><td></td><td><button class="btn small" data-mkchar="${a.id}">+ char</button> <button class="btn small" data-pull="${a.id}" title="pull one of this game account's characters into the Command Center">👤 pick</button></td></tr>`);
      continue;
    }
    for (const c of chars) {
      rows.push(`<tr>
        ${selCell(a)}
        <td>${a.label ?? ''}</td><td class="muted">${a.userId}</td>${pwCell(a)}<td>${a.type ?? ''}</td>
        <td><b>${c.name}</b></td>
        <td>${c.classId ?? '?'} · ${c.baseLevel ?? '?'}/${c.jobLevel ?? '?'}</td>
        <td class="muted">${c.mapName ?? '—'}</td>
        <td><input type="checkbox" data-inc="${c.id}" ${c.included ? 'checked' : ''} /></td>
        <td><button class="btn small" data-refresh="${c.id}">refresh</button> <button class="btn small" data-pull="${a.id}" title="pull another character from this account">👤 pick</button></td>
      </tr>`);
    }
  }
  tb.innerHTML = rows.join('') || '<tr><td colspan="10" class="muted">no accounts yet — create some above</td></tr>';
  const msg = $('acc-del-msg');
  if (msg) msg.textContent = state.accSel.size ? `${state.accSel.size} account(s) ticked` : '';
}

// Accounts tab — "👤 pick": list the game account's REAL characters and pull one into the CC. The pulled
// character instantly becomes a dashboard bot (stopped). Use when an imported account didn't auto-pull
// its character (2026-10-08).
async function openCharPick(accId) {
  $('cp-title').textContent = 'Pick a character';
  $('cp-body').innerHTML = '<p class="muted small">loading characters from the game…</p>';
  $('cp-modal').classList.remove('hidden');
  const r = await api(`/api/accounts/${accId}/gamechars`).catch((e) => ({ error: String(e?.message ?? e) }));
  if (r.error) { $('cp-body').innerHTML = `<p class="muted">${esc(r.error)}</p>`; return; }
  const chars = r.characters ?? [];
  if (!chars.length) { $('cp-body').innerHTML = '<p class="muted">no characters on this game account</p>'; return; }
  $('cp-body').innerHTML = '<p class="muted small">click a character to pull it in — it becomes a dashboard bot (starts stopped)</p>'
    + chars.map((c) => `<button class="btn" style="display:block;width:100%;text-align:left;margin:4px 0" data-pullpick="${accId}" data-pullname="${esc(c.name)}"><b>${esc(c.name)}</b> <span class="muted" style="font-size:11px">· ${esc(c.classId ?? '?')} · lv ${c.baseLevel ?? '?'}/${c.jobLevel ?? '?'} · ${esc(c.mapName ?? '—')}</span>${c.linked ? ' <span class="muted" style="font-size:11px">· in CC ✓</span>' : ''}</button>`).join('');
}
async function doPullPick(accId, name) {
  $('cp-body').innerHTML = `<p class="muted small">pulling <b>${esc(name)}</b>…</p>`;
  const r = await api(`/api/accounts/${accId}/pull`, 'POST', { name }).catch((e) => ({ error: String(e?.message ?? e) }));
  $('cp-body').innerHTML = r.ok
    ? `<p>✓ pulled <b>${esc(r.name)}</b> — bot #${r.bot} is now on the Dashboard (stopped)</p>`
    : `<p class="muted">${esc(r.error ?? 'pull failed')}</p>`;
  refreshState();
}

function renderJobs() {
  const box = $('jobbox');
  const j = state.jobs?.active;
  const last = state.jobs?.history?.[0];
  const lines = [];
  if (j) {
    lines.push(`<div class="line">⏳ <b>${j.kind}</b> ${j.done}/${j.total}${j.failed ? ` (${j.failed} failed)` : ''}</div>`);
    for (const l of (j.log ?? []).slice(-6)) lines.push(`<div class="line ${l.level === 'error' ? 'err' : 'okline'}">${l.msg}</div>`);
  } else if (last && last.status !== 'done') {
    lines.push(`<div class="line">last job <b>${last.kind}</b>: ${last.status} ${last.error ?? ''}</div>`);
  } else if (last) {
    lines.push(`<div class="line muted">last ${last.kind}: done (${last.done}/${last.total})</div>`);
  }
  box.innerHTML = lines.join('');
}

function renderStress() {
  const incl = (state.characters ?? []).filter((c) => c.included);
  const running = state.bots.filter((b) => ['running', 'starting', 'paused', 'pausing', 'restarting'].includes(b.state)).length;
  $('st-summary').innerHTML = `<p class="muted small">roster: <b>${incl.length}</b> included characters · <b>${running}</b> bots active · total bots tracked: <b>${state.bots.length}</b></p>`;
}

function renderLog() {
  const drawer = $('logdrawer');
  const id = state.selectedLog;
  if (!id) { drawer.classList.add('hidden'); document.body.classList.remove('drawer-open'); return; }
  drawer.classList.remove('hidden');
  document.body.classList.add('drawer-open');
  const bot = state.bots.find((b) => b.id === id);
  $('drawer-tab-log').classList.toggle('on', state.drawerTab === 'log');
  $('drawer-tab-bag').classList.toggle('on', state.drawerTab === 'bag');
  $('drawer-tab-earn').classList.toggle('on', state.drawerTab === 'earn');
  if (state.drawerTab === 'bag') { $('log-title').textContent = `bag — ${bot?.name ?? 'bot #' + id}`; renderBag(bot); return; }
  if (state.drawerTab === 'earn') { $('log-title').textContent = `earnings — ${bot?.name ?? 'bot #' + id}`; renderEarnings(bot); return; }
  $('log-title').textContent = `live log — ${bot?.name ?? 'bot #' + id}`;
  const arr = state.logs.get(id) ?? [];
  const body = $('log-body');
  body.innerHTML = arr.map((e) => {
    const t = (e.t ?? '').slice(11, 19);
    const d = JSON.stringify(e.data ?? {});
    return `<div class="ln e-${e.evt}"><span class="t">${t}</span> <span class="t2">${e.evt}</span> <span class="d">${d.length > 220 ? d.slice(0, 220) + '…' : d}</span></div>`;
  }).join('');
  if ($('log-follow').checked) body.scrollTop = body.scrollHeight;
}

// ---------- list view ----------
function botListRow(b) {
  const s = b.status ?? {};
  const hpPct = s.maxHp ? Math.round((s.hp ?? 0) / s.maxHp * 100) : 0;
  const spPct = s.maxSp ? Math.round((s.sp ?? 0) / s.maxSp * 100) : 0;
  const exits = `${b.lastExit ? `exit ${b.lastExit.code}` : ''}${b.restarts ? `${b.lastExit ? ' · ' : ''}↻${b.restarts}` : ''}`;
  return `<tr class="row-bot st-${b.state} ${state.selectedLog === b.id ? 'sel' : ''}" data-bot="${b.id}">
      <td><input type="checkbox" data-sel="${b.id}" ${state.sel.has(b.id) ? 'checked' : ''} /></td>
      <td class="bl-name"><b>${b.name}</b> <span class="sdot st-${b.state}" title="${b.state}"></span> <span class="idtag">#${b.id}</span>${b.group ? ` <span class="ms" title="group">📁 ${esc(b.group)}</span>` : ''}${exits ? ` <span class="muted small">${exits}</span>` : ''}</td>
      <td>${activityBadge(b, s)}</td>
      <td><span class="badge">${s.classId ?? '?'}</span></td>
      <td class="bl-gear">${gearDots(b)}</td>
      <td class="bl-plan" title="${b.plan ? `plan: ${esc(b.plan.name)}` : 'no plan applied'} ">${b.plan ? '📋 ' + esc(b.plan.name) : '<span class="muted">—</span>'}</td>
      <td class="bl-mono">${s.base ?? '?'}/${s.job ?? '?'}</td>
      <td class="bl-mono">${s.map ?? '—'}${s.channel != null ? ` · CH ${s.channel}` : ''}</td>
      <td class="bl-hp">
        <div class="vbar hpb" title="HP ${s.dead ? '0' : Math.round(s.hp ?? 0)}/${s.maxHp ?? '?'}"><i style="width:${hpPct}%"></i></div>
        <div class="vbar spb" title="SP ${Math.round(s.sp ?? 0)}/${s.maxSp ?? '?'}"><i style="width:${spPct}%"></i></div>
      </td>
      <td>${s.pets?.owned ? `<span class="ms pet">pet ${s.pets.active ? '✓' : s.pets.owned}</span>` : '<span class="muted">—</span>'}</td>
      <td class="bl-mono">z ${fmt(s.zeny)}</td>
      <td class="bl-mono bl-earnx">${earnCell(b)}</td>
      <td class="bl-mono tor" title="Tor exit IP this session (logged before the bot touches the server)">🧅 ${b.exitIp ?? '—'}</td>
      <td class="bl-step">${s.step ?? '—'}${s.dead ? ' <span class="dead">☠ dead</span>' : ''}</td>
      <td class="bl-acts">
        <button class="btn small" data-stat="${b.id}" title="stats & skills">📊</button>
        <button class="btn small" data-cfg="${b.id}" title="config">⚙</button>
        ${b.mode !== 'collector' ? `<button class="btn small" data-collect="${b.id}" title="collect">⇪</button>` : ''}
        <button class="btn small" data-kick="${b.id}" title="force online — kick the previous (stale) session so it can log in — use when stuck at 'already online'">🔓</button>
        <button class="btn ok small" data-act="play" data-id="${b.id}" title="play">▶</button>
        <button class="btn warn small" data-act="pause" data-id="${b.id}" title="pause">⏸</button>
        <button class="btn bad small" data-act="stop" data-id="${b.id}" title="stop">⏹</button>
      </td>
    </tr>`;
}

function botListTable(bots) {
  return `<div class="botlistwrap"><table class="botlist">
    <thead><tr><th></th><th>bot</th><th>activity</th><th>class</th><th class="bl-gear" title="knight gear — left dot: required gems (lifesteal attack + lifesteal skill + mana skill) · right dot: +7 Dawnbreaker — green = ok · red = missing · grey = n/a">gear</th><th>plan</th><th>base/job</th><th>map · ch</th><th>hp / sp</th><th>pet</th><th>zeny</th><th class="bl-earnx" title="estimated zeny per hour — loot drops × NPC sell price (last 3h while active)">≈z/h</th><th title="Tor exit IP this session">exit IP</th><th>step</th><th></th></tr></thead>
    <tbody>${bots.map(botListRow).join('')}</tbody></table></div>`;
}

function renderBotsList() {
  renderGroupBar();
  $('empty-bots').classList.toggle('hidden', state.bots.length > 0);
  const fleet = groupedBots().filter((b) => b.mode !== 'collector' && !b.retired);
  const colBots = state.bots.filter((b) => b.mode === 'collector' && !b.retired);
  const sec = $('collector-sec');
  if (sec) sec.classList.toggle('hidden', colBots.length === 0);
  renderCollectorSum(colBots);
  // live re-renders replace the tables wholesale — keep the horizontal scroll where the user left it
  const keep = [...document.querySelectorAll('.botlistwrap')].map((el) => [el.parentElement?.id ?? '', el.scrollLeft, el.scrollTop]);
  if (colBots.length) $('collector-bot').innerHTML = botListTable(colBots);
  $('bots').innerHTML = botListTable(fleet);
  for (const el of document.querySelectorAll('.botlistwrap')) {
    const s = keep.find((w) => w[0] === (el.parentElement?.id ?? ''));
    if (s) { el.scrollLeft = s[1]; el.scrollTop = s[2]; }
  }
}

// ---------- bag / storage viewer ----------
function renderBag(bot) {
  const body = $('log-body');
  if (!bot) { body.innerHTML = ''; return; }
  const s = bot.status ?? {};
  const inv = s.inventory ?? [];
  const st = s.storage;
  const tracked = new Set(state.settings?.tracked ?? []);
  const rowFor = (it, where) => `<tr${tracked.has(it.itemId) ? ' class="tr-row"' : ''}><td class="muted">${it.slot ?? ''}</td><td>${it.name ?? it.itemId}${it.refine ? ` <span class="rf">+${it.refine}</span>` : ''}</td><td class="bl-mono">${it.qty ?? 1}</td><td class="muted">${where}</td></tr>`;
  body.innerHTML = `<div class="bagwrap">
    <div>
      <div class="bag-h">inventory · ${inv.length} stacks · weight ${s.bag?.weight ?? '?'}/${s.bag?.weightLimit ?? '?'} · zeny ${fmt(s.zeny)}</div>
      <table class="bagt"><thead><tr><th>#</th><th>item</th><th>qty</th><th></th></tr></thead>
      <tbody>${inv.map((it) => rowFor(it, 'inventory')).join('') || '<tr><td colspan="4" class="muted">empty / waiting for next heartbeat snapshot</td></tr>'}</tbody></table>
    </div>
    <div>
      <div class="bag-h">storage ${st ? `· ${st.items?.length ?? 0} stacks · zeny ${fmt(st.zeny)}` : '· (opens once the bot uses storage)'}</div>
      <table class="bagt"><thead><tr><th>#</th><th>item</th><th>qty</th><th></th></tr></thead>
      <tbody>${(st?.items?.length ? st.items.map((it) => rowFor(it, 'storage')).join('') : '<tr><td colspan="4" class="muted">no storage snapshot</td></tr>')}</tbody></table>
    </div>
  </div>`;
  body.scrollTop = 0;
}

// ---------- earnings (per-bot hourly estimate) ----------
function earnCell(b) {
  const e = b?.earn;
  if (!e) return '<span class="muted">—</span>';
  const r = e.rate3 ?? e.rate24;
  if (r == null) return '<span class="muted">—</span>';
  const idle = e.rate3 == null;
  return `<span class="${idle ? 'muted' : 'earn-ok'}" data-tip="estimated zeny per hour from loot drops\n${idle ? 'idle now — showing the 24h average' : 'last 3h average while active'} · ≈${fmtC(r)} z/h">≈${fmtC(r)}/h</span>`;
}

function renderEarnings(bot, { force = false } = {}) {
  const body = $('log-body');
  if (!bot) { body.innerHTML = ''; return; }
  // first open: give the chart room — only until the user resizes the drawer themselves
  if (!state._earnGrew) { state._earnGrew = true; if (typeof window.ccDrawerGrow === 'function') window.ccDrawerGrow(); }
  const cfg = state.earnCfg;
  let cur = state.earnCache.get(bot.id);
  const need = !cur || !cur.data || cur.hours !== cfg.range || (!cur.inflight && Date.now() - cur.at > 30000);
  if (need && !cur?.inflight) {
    const entry = { at: cur?.at ?? 0, data: cur?.data ?? null, hours: cfg.range, inflight: true };
    state.earnCache.set(bot.id, entry);
    api(`/api/bots/${bot.id}/earnings?hours=${cfg.range}`)
      .then((data) => state.earnCache.set(bot.id, { at: Date.now(), data, hours: cfg.range, inflight: false }))
      .catch(() => state.earnCache.set(bot.id, { at: Date.now(), data: entry.data, hours: cfg.range, inflight: false }))
      .finally(() => { if (state.selectedLog === bot.id && state.drawerTab === 'earn') renderEarnings(bot, { force: true }); });
    cur = state.earnCache.get(bot.id);
  }
  if (!cur?.data) { body.innerHTML = '<div class="bag-h">loading earnings…</div>'; return; }
  const sig = `${bot.id}:${cfg.range}:${cfg.xtick}:${cfg.ytick}:${cur.at}`;
  if (!force && body.dataset.earnSig === sig) return;
  body.dataset.earnSig = sig;
  body.innerHTML = earningsHtml(bot, cur.data);
  body.scrollTop = 0;
  // a short drawer buries the chart below the fold — bring it into view once per open (baseline first)
  if (!state._earnScrolled) {
    state._earnScrolled = true;
    const c = body.querySelector('.earn-chart');
    if (c) {
      c.scrollIntoView({ block: 'start' });
      const over = c.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom;
      if (over > 0) body.scrollTop += over + 8;
    }
  }
}

function earningsHtml(bot, d) {
  const cfg = state.earnCfg;
  const hs = d.hours ?? [];
  const rl = `${cfg.range}h`;
  const chips = [
    d.rate3 != null ? `3h avg <b>≈${fmtC(d.rate3)}/h</b>` : null,
    d.rate24 != null ? `24h avg <b>≈${fmtC(d.rate24)}/h</b>` : null,
    `kills ${rl} <b>${fmt(d.totals?.k ?? 0)}</b>`,
    `drops ${rl} <b>${fmt(d.totals?.q ?? 0)}</b>`,
    `sales earned ${rl} <b>+${fmt(d.totals?.e ?? 0)}</b>`,
    (d.totals?.s ?? 0) > 0 ? `moved/spent ${rl} <b>−${fmt(d.totals.s)}</b>` : null,
    (d.totals?.c ?? 0) > 0 ? `cards ${rl} <b>${fmt(d.totals.c)}</b>` : null,
  ].filter(Boolean).join('<span class="earn-sep">·</span>');
  const ctl = `<div class="earn-ctl">
    <span class="earn-ctl-lab">range</span>
    ${[6, 12, 24, 48, 72].map((r) => `<button class="btn small ${cfg.range === r ? 'on' : ''}" data-earn-range="${r}">${r}h</button>`).join('')}
    <span class="earn-ctl-lab">x ticks</span>
    <select id="earn-xtick" class="earn-sel">${[['auto', 'auto'], ['1', 'every 1h'], ['2', 'every 2h'], ['3', 'every 3h'], ['6', 'every 6h'], ['12', 'every 12h']].map(([v, l]) => `<option value="${v}"${cfg.xtick === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
    <span class="earn-ctl-lab">y ticks</span>
    <select id="earn-ytick" class="earn-sel">${[['auto', 'auto'], ['100', '100k'], ['250', '250k'], ['500', '500k'], ['1000', '1M'], ['2000', '2M'], ['5000', '5M'], ['10000', '10M']].map(([v, l]) => `<option value="${v}"${cfg.ytick === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
  </div>`;
  const n = hs.length || 1;
  const niceStep = (raw) => { const p = Math.pow(10, Math.floor(Math.log10(raw || 1))); const f = raw / p; const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10; return m * p; };
  const maxRaw = Math.max(1000, ...hs.map((x) => Math.max(x.v, x.e)));
  const base = cfg.ytick === 'auto' ? niceStep(maxRaw / 5) : parseInt(cfg.ytick, 10) * 1000;
  let yStep = base;
  for (const k of [1, 2, 5, 10, 20, 50, 100, 200, 500]) { yStep = base * k; if (Math.ceil(maxRaw / yStep) <= 14) break; }
  const axisMax = Math.max(yStep, Math.ceil(maxRaw / yStep) * yStep);
  const yCount = Math.round(axisMax / yStep);
  const xEvery = cfg.xtick === 'auto'
    ? ([1, 2, 3, 4, 6, 8, 12, 24].find((k) => n / k <= 7) ?? 24)
    : Math.max(1, Math.min(n, parseInt(cfg.xtick, 10)));
  const W = 960, H = 250, padL = 58, padB = 22, padT = 10;
  const step = (W - padL - 12) / n;
  const y = (v) => padT + (H - padT - padB) * (1 - v / axisMax);
  let grid = '';
  for (let i = 0; i <= yCount; i++) {
    const v = i * yStep;
    grid += `<line x1="${padL}" x2="${W - 12}" y1="${y(v)}" y2="${y(v)}" class="eg" /><text x="${padL - 6}" y="${y(v) + 3}" class="el" text-anchor="end">${fmtC(v)}</text>`;
  }
  hs.forEach((x, i) => { if ((n - 1 - i) % xEvery === 0) grid += `<line x1="${padL + i * step + step / 2}" x2="${padL + i * step + step / 2}" y1="${padT}" y2="${H - padB}" class="egv" />`; });
  const bars = hs.map((x, i) => {
    const x0 = padL + i * step + step * 0.14;
    const bw = Math.max(2, step * 0.34);
    const tip = [
      `${x.h.slice(11)}:00–${String((+x.h.slice(11) + 1) % 24).padStart(2, '0')}:00  (local)`,
      `est ≈${fmt(x.v)}    earned +${fmt(x.e)}${x.s ? `    moved −${fmt(x.s)}` : ''}`,
      `kills ${fmt(x.k)} · drops ${fmt(x.q)}${x.c ? ` · cards ${x.c}` : ''}`,
      ...(x.top?.length ? [`top: ${x.top.slice(0, 3).map((t) => `${t.n} ×${t.q}`).join(' · ')}`] : []),
    ].join('\n');
    const cxm = padL + i * step + step / 2;
    const lbl = (n - 1 - i) % xEvery === 0 ? `<text x="${cxm}" y="${H - 6}" class="el" text-anchor="middle">${x.h.slice(11)}</text>` : '';
    return `<g class="egrp" data-tip="${esc(tip)}"><rect x="${x0}" y="${y(x.v)}" width="${bw}" height="${Math.max(0, y(0) - y(x.v))}" class="eb-est" rx="2" /><rect x="${x0 + bw + 1.5}" y="${y(x.e)}" width="${bw}" height="${Math.max(0, y(0) - y(x.e))}" class="eb-earn" rx="2" /><rect class="ehit" x="${padL + i * step}" y="${padT}" width="${step}" height="${H - padT - padB}" />${lbl}</g>`;
  }).join('');
  const topAgg = new Map();
  for (const x of hs) for (const t of (x.top ?? [])) topAgg.set(t.n, (topAgg.get(t.n) ?? 0) + t.q);
  const top = [...topAgg.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 10).map(([nm, q]) => `<span class="tr-chip wh-chip">${esc(nm)} ×${fmt(q)}</span>`).join(' ');
  return `<div class="earnwrap">
    ${ctl}
    <div class="earn-kpis">${chips}</div>
    <div class="bag-h">est. zeny per hour — last ${rl} (local) · <span class="earn-ok">▮</span> loot drops × NPC sell price · <span class="earn-sky">▮</span> realized zeny earned · hover a bar for details</div>
    <svg class="earn-chart" viewBox="0 0 ${W} ${H}">${grid}${bars}</svg>
    <div class="earn-note">estimate = every item gained × NPC sell price, excluding cards / kept items / buff items / potions the bot never sells (validated within ~3% of actual shop sales). “earned” = real zeny jumps (sales); “moved” = transfers out + fees.</div>
    ${top ? `<div class="bag-h">top drops ${rl}</div><div class="earn-top">${top}</div>` : ''}
  </div>`;
}

// ---------- collector tab ----------
function itemNameOf(id) {
  const all = [...(state.wiki.items ?? []), ...(state.wiki.roItems ?? [])];
  return all.find((x) => x.id === id)?.name ?? ('item#' + id);
}
// union of every bot's own whitelist (collector is excluded — its list is read-only/derived)
function allKeepIds() {
  const s = new Set();
  for (const b of state.bots) { if (b.mode === 'collector' || b.retired) continue; for (const id of (b.cfg?.keep ?? [])) s.add(id); }
  if (!s.size) for (const id of (state.settings?.tracked ?? [])) s.add(id);
  return s;
}
// every card item id (wiki type 'Card') — mirrors the server-side keep-all-cards merge
function cardIdSet() {
  const s = new Set();
  for (const it of [...(state.wiki.items ?? []), ...(state.wiki.roItems ?? [])]) {
    if (it.type === 'Card') s.add(+it.id);
    else if (!it.type && /\bcard$/i.test(String(it.name ?? '').trim())) s.add(+it.id); // fallback for older wiki slices without type
  }
  return s;
}
// whitelist views = union of every bot's whitelist + every card that currently exists in a character
// (bag / collector bag / collector storage) — so new cards never need manual whitelist edits to show up
function whitelistIds() {
  const keep = new Set([...allKeepIds()].map(Number));
  const ids = new Set(keep);
  const cardIds = cardIdSet();
  const store = state.fleet?.collectorStorage?.items ?? {};
  for (const b of state.bots) { if (b.retired) continue; for (const it of (b.status?.inventory ?? [])) { const id = +it.itemId; if (cardIds.has(id)) ids.add(id); } }
  for (const b of state.bots) { if (b.retired) continue; for (const it of (b.status?.storage?.items ?? [])) { const id = +it.itemId; if (cardIds.has(id)) ids.add(id); } }
  for (const sid of Object.keys(store)) { const id = +sid; if (cardIds.has(id)) ids.add(id); }
  return { keep, ids };
}
function renderCollector() {
  const ac = state.collect?.autoCollect ?? state.settings?.autoCollect;
  if (ac) {
    if (document.activeElement !== $('col-auto')) $('col-auto').checked = !!ac.enabled;
    if (document.activeElement !== $('col-auto-hrs')) $('col-auto-hrs').value = Math.max(1, Math.round((ac.everyMin ?? 360) / 60));
  }
  const wg = state.settings?.wings ?? { enabled: true, keep: 10 };
  if (document.activeElement !== $('col-wing')) $('col-wing').checked = wg.enabled !== false;
  if (document.activeElement !== $('col-wing-keep')) $('col-wing-keep').value = wg.keep ?? 10;
  // ---- collector POOL: caps + live holdings + per-collector bot controls (multi-collector, 2026-10-08) ----
  const colListEl = $('col-list');
  if (colListEl) {
    const cols = state.collect?.collectors ?? [];
    const nmOf = (id) => state.bots.find((b) => b.id === id)?.name ?? '#' + id;
    colListEl.innerHTML = cols.length ? `<table class="bagt wht"><thead><tr><th>#</th><th>collector</th><th>state</th><th>now trading</th><th title="who the planner would send next (dry-run reservation of the waiting queue)">queue (planned)</th><th>zeny held / cap</th><th>items held</th><th>top item</th><th>ch</th><th title="zeny cap · per-item cap (total count per item)">caps</th><th></th></tr></thead><tbody>${cols.map((c) => {
      const h = c.held ?? {};
      const top = h.topItem ? `${itemNameOf(h.topItem.itemId)} ×${fmt(h.topItem.qty)}` : '—';
      const pv = c.queuePreview ?? [];
      const pvTxt = pv.length ? `${pv.slice(0, 4).map((id) => esc(nmOf(id))).join(', ')}${pv.length > 4 ? ` +${pv.length - 4}` : ''}` : '—';
      const acct = (state.accounts ?? []).find((a) => (a.chars ?? []).some((ch) => ch.name === c.charName));
      const pwOpen = !!acct && state.pwShow.has(acct.id) && state.pw.has(acct.id);
      return `<tr>
        <td>${c.id}</td>
        <td><b>${esc(c.charName)}</b>${c.auto ? ' <span class="muted small">auto</span>' : ''} <span class="muted small">${c.botId != null ? '#' + c.botId : 'not enrolled'}</span>${acct ? ` <span class="muted small">· acct ${esc(acct.userId)}</span>` : ''}</td>
        <td>${c.live ? '<span class="chip ok">running</span>' : '<span class="chip bad">off</span>'}</td>
        <td>${c.active != null ? '⇪ ' + esc(nmOf(c.active)) : '—'}</td>
        <td class="muted small">${pvTxt}</td>
        <td class="bl-mono">${fmt(h.zeny ?? 0)} / ${fmt(c.zenyCap)}</td>
        <td class="bl-mono">${fmt(h.itemTotal ?? 0)}</td>
        <td class="muted small">${top}</td>
        <td class="muted">${c.channel ?? 1}</td>
        <td><input type="number" data-colz="${c.id}" value="${c.zenyCap}" style="width:130px" title="zeny cap" /> <input type="number" data-coli="${c.id}" value="${c.itemCapPerItem}" style="width:80px" title="per-item cap" /></td>
        <td>${c.botId != null ? `<button class="btn small ok" data-colact="start:${c.botId}" title="start this collector's bot">▶</button> <button class="btn small warn" data-colact="restart:${c.botId}" title="restart this collector's bot">↻</button> <button class="btn small bad" data-colact="stop:${c.botId}" title="stop this collector's bot">⏹</button> ` : ''}<button class="btn small" data-coldetect="${c.id}" title="adopt this collector's LIVE channel + position into its row (stand it where you want it first — it re-parks there within a minute)">⌖</button> <button class="btn small" data-colsave="${c.id}">save</button> <button class="btn small bad" data-coldel="${c.id}" title="remove from the pool (the account itself is untouched)">✕</button>${acct ? ` <button class="btn small" data-colpw="${acct.id}" title="reveal / hide this collector account's login password">🔑</button>${pwOpen ? `<span class="pw shown bl-mono small">${esc(state.pw.get(acct.id))}</span>` : ''}` : ''}</td>
      </tr>`;
    }).join('')}</tbody></table>
    <p class="muted small">held = storage snapshot + confirmed receipts (the ledger) · donors split each handover across the pool: every collector takes up to its remaining zeny / per-item capacity and the remainder flows to the next · when the whole pool is full a new collector is created automatically and walks itself into place (its Tor circuit is provisioned before it logs in) · ▶ / ↻ / ⏹ control that collector's own bot (they live outside the Accounts tab); 🔑 shows its login password · ▶ / ↻ force the seat back — they kick a session still holding it (auto-recovery only ever probes, so your manual logins are never booted automatically).</p>`
      : '<span class="muted small">no collectors in the pool yet — save a collector character below or hit + create collector</span>';
  }
  const q = state.collect?.queue ?? [];
  const held = state.collect?.held ?? [];
  const actives = state.collect?.actives ?? (state.collect?.active != null ? [{ collector: '—', botId: state.collect.active }] : []);
  const cap = state.collect?.capacity ?? null;
  const byId = new Map(state.bots.map((b) => [b.id, b]));
  const nameOf = (id) => byId.get(id)?.name ?? '#' + id;
  // pending handover per donor (bag + own storage whitelist) — shown on the swimlane cards
  const donorMeta = (id) => {
    const b = byId.get(id); const st = b?.status;
    if (!st) return '';
    const keep = new Set((b.cfg?.keep ?? []).map(Number));
    let items = 0;
    for (const it of (st.inventory ?? [])) if (keep.has(it.itemId) && it.itemId !== 90311) items += it.qty ?? 1;
    for (const it of (st.storage?.items ?? [])) if (keep.has(it.itemId) && it.itemId !== 90311) items += it.qty ?? 1;
    const z = Math.max(0, (st.zeny ?? 0) - 50000);
    return [z ? `${fmt(z)}z` : '', items ? `${fmt(items)} items` : ''].filter(Boolean).join(' · ');
  };
  const activeOf = new Map(actives.map((a) => [a.collector, a.botId]));
  const cardOf = (id, { active = false, hold = false } = {}) => `<div class="swim-card${active ? ' active' : ''}"><span class="t">${active ? '⇪ ' : ''}${esc(nameOf(id))}<div class="swim-sub">${esc(donorMeta(id) || 'idle')}</div></span>${active ? '' : hold ? `<button class="btn small" data-qrel="${id}" title="re-queue now">↺</button>` : `<button class="btn small" data-qdel="${id}" title="skip this bot for this round — it keeps farming, held until released">✕</button>`}</div>`;
  const lanes = (state.collect?.collectors ?? []).map((c) => ({
    name: c.charName, live: c.live,
    active: activeOf.get(c.charName) ?? (c.active ?? null),
    queue: (c.queuePreview ?? []).filter((x) => x != null),
    zeny: Number(c.held?.zeny ?? 0), zenyCap: Number(c.zenyCap ?? 0), items: c.held?.itemTotal ?? 0,
  }));
  const laneIds = new Set();
  for (const l of lanes) { if (l.active != null) laneIds.add(l.active); for (const id of l.queue) laneIds.add(id); }
  const unassigned = q.filter((id) => !laneIds.has(id));
  const previewOf = {};
  for (const l of lanes) for (const id of l.queue) if (previewOf[id] == null) previewOf[id] = l.name;
  void previewOf;
  $('col-queue').innerHTML = (lanes.length || q.length || held.length || cap)
    ? `<div class="muted small" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:2px">
         ${cap ? `<span>fleet pending <b>${fmt(cap.totals.zeny)}z</b> + <b>${fmt(cap.totals.items)}</b> items from ${cap.totals.bots} bot(s) · pool <b>${cap.have}</b>${cap.additionalNeeded ? ` <span style="color:var(--gold)">— ≈${cap.additionalNeeded} more needed to clear in one wave</span>` : ' — enough capacity'}</span>` : ''}
         <span style="flex:1"></span>
         <button class="btn small" id="col-qall" title="enqueue every bot that has whitelist items (bag or storage) or zeny to hand over">⇪ queue ALL</button>
         ${q.length ? `<button class="btn small" id="col-qclear" title="remove every waiting bot from this round — they keep farming; release them to re-queue">⏹ clear waiting (${q.length})</button>` : ''}
         ${held.length ? `<button class="btn small" id="col-qrel" title="let held bots auto-queue again">↺ release held (${held.length})</button>` : ''}
       </div>
       ${state.collect?.collectorLive === false ? `<div class="muted small" style="color:var(--gold);margin-bottom:2px">⏸ no collector bot is running — grants are held: traders keep farming and hand over as soon as one is up</div>` : ''}
       <div class="swim">
         ${lanes.map((l) => {
           const pct = l.zenyCap ? Math.min(100, Math.round((l.zeny / l.zenyCap) * 100)) : 0;
           return `<div class="swim-lane${l.live ? '' : ' off'}">
             <div class="swim-head">
               <div class="swim-name"><span>🧰 ${esc(l.name)}</span>${l.live ? '<span class="chip ok">on</span>' : '<span class="chip bad">off</span>'}</div>
               <div class="swim-bar" title="zeny held ${fmt(l.zeny)} / ${fmt(l.zenyCap)}"><i style="width:${pct}%"></i></div>
               <div class="swim-meta"><span>${fmt(l.zeny)}z</span><span>${fmt(l.items)} items</span></div>
             </div>
             ${l.active != null ? cardOf(l.active, { active: true }) : '<div class="swim-empty">— idle —</div>'}
             ${l.queue.map((id) => cardOf(id)).join('')}
           </div>`;
         }).join('')}
         ${unassigned.length ? `<div class="swim-lane off">
           <div class="swim-head">
             <div class="swim-name"><span>⏳ unassigned</span><span class="muted small">${unassigned.length}</span></div>
             <div class="swim-meta"><span>waiting for capacity / already empty — they drop as they reach the head</span></div>
           </div>
           ${unassigned.slice(0, 40).map((id) => cardOf(id)).join('')}
           ${unassigned.length > 40 ? `<div class="swim-empty">+${unassigned.length - 40} more</div>` : ''}
         </div>` : ''}
         ${held.length ? `<div class="swim-lane hold">
           <div class="swim-head">
             <div class="swim-name"><span>✕ held</span><span class="muted small">${held.length}</span></div>
             <div class="swim-meta"><span>skipped for this round — ↺ to re-queue</span></div>
           </div>
           ${held.map((id) => cardOf(id, { hold: true })).join('')}
         </div>` : ''}
       </div>`
    : 'queue empty';
  const tracked = [...whitelistIds().ids];
  $('tr-list').innerHTML = tracked.length
    ? tracked.map((id) => `<span class="tr-chip">${itemNameOf(id)}</span>`).join(' ')
      + '<div class="muted small" style="margin-top:6px">read-only · union of every bot\'s whitelist + all cards seen in characters — edit per bot in its ⚙ config</div>'
    : '<span class="muted small">nothing whitelisted yet — open a bot\'s ⚙ config and add items</span>';
  const rows = tracked.map((id) => ({ id, name: itemNameOf(id), inv: 0, store: 0, carriers: new Set(), storedBy: new Set() }));
  for (const b of state.bots) {
    for (const it of (b.status?.inventory ?? [])) { const r = rows.find((x) => x.id === it.itemId); if (r) { r.inv += it.qty ?? 1; r.carriers.add(b.name); } }
    for (const it of (b.status?.storage?.items ?? [])) { const r = rows.find((x) => x.id === it.itemId); if (r) { r.store += it.qty ?? 1; r.storedBy.add(b.name); } }
  }
  $('tr-totals').innerHTML = rows.length
    ? `<table class="bagt"><thead><tr><th>item</th><th>in inventories</th><th>in storage*</th><th>carried by</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${r.name}</td><td class="bl-mono">${fmt(r.inv)}</td><td class="bl-mono">${fmt(r.store)}</td><td class="muted">${r.carriers.size} char(s)</td></tr>`).join('')}</tbody></table><div class="muted small">* storage counts reflect the last time each bot had its storage window open</div>`
    : '<span class="muted small">no whitelist items</span>';
}

// ---------- config modal ----------
function renderCfgMobs() {
  const maps = state.wiki.maps ?? [];
  const sel = $('cfg-farmmap');
  if (!sel) return;
  if (!sel.childElementCount) sel.innerHTML = maps.map((m) => `<option value="${m.id}">${m.name} — ${m.id}</option>`).join('');
  const want = state.cfgFarmMap || state.cfgBotMap || '';
  if (want && [...sel.options].some((o) => o.value === want)) sel.value = want;
  if (sel.value) state.cfgFarmMap = sel.value;
  const mapId = sel.value;
  const label = $('cfg-mobsmap');
  if (label) label.textContent = mapId || '—';
  const mobs = (state.wiki.monsters ?? []).filter((m) => !mapId || (m.maps ?? []).includes(mapId));
  const list = mobs.length ? mobs : (state.wiki.monsters ?? []);
  $('cfg-mobs').innerHTML = list.length
    ? list.map((m) => `<label><input type="checkbox" data-mob="${m.id}" ${state.cfgMobSel.has(String(m.id)) ? 'checked' : ''} /> ${m.name}${m.level ? ` <span class="muted small">lv${m.level}</span>` : ''}</label>`).join('')
    : '<span class="muted small">no monster data for this map</span>';
  const note = $('cfg-mobnote');
  if (note) note.textContent = mobs.length ? `${mobs.length} spawn on ${mapId}` : `no spawn data for ${mapId || '?'} — showing all monsters`;
}
function skillNameOf(id) {
  const s = (state.wiki.skills ?? []).find((x) => x.id === id);
  return s?.name ?? id;
}
function renderCfgWeave() {
  const el = $('cfg-weave-list');
  if (el) el.innerHTML = state.cfgWeave.length
    ? state.cfgWeave.map((id, i) => `<div class="wrow"><span class="widx">${i + 1}</span><span class="wname">${skillNameOf(id)} <span class="wid">${id}</span></span><button class="btn small" data-wup="${i}" ${i === 0 ? 'disabled' : ''} title="cast earlier">↑</button><button class="btn small" data-wdown="${i}" ${i === state.cfgWeave.length - 1 ? 'disabled' : ''} title="cast later">↓</button><button class="btn small" data-wdel="${i}" title="remove">✕</button></div>`).join('')
    : '<span class="muted small" style="padding:4px">nothing selected — the bot keeps its default rotation (bash → bowling-bash)</span>';
  const add = $('cfg-skill-add');
  if (add && !add.childElementCount) {
    const byCls = new Map();
    for (const s of (state.wiki.skills ?? [])) { const k = s.cls ?? 'other'; if (!byCls.has(k)) byCls.set(k, []); byCls.get(k).push(s); }
    add.innerHTML = '<option value="">— pick a skill to add —</option>' + [...byCls.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([cls, list]) => `<optgroup label="${cls}">${list.slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).map((s) => `<option value="${s.id}">${s.name} — ${s.id}</option>`).join('')}</optgroup>`).join('');
  }
}
function renderCfgBuff() {
  const el = $('cfg-buff-list');
  if (!el) return;
  el.innerHTML = state.cfgBuff.length
    ? state.cfgBuff.map((id) => `<span class="tr-chip">${itemNameOf(id)} <button class="btn small" data-cfgbdel="${id}" title="remove">✕</button></span>`).join(' ')
    : '<span class="muted small">no buff items - the engine keeps buffs up with its own skills only</span>';
}
function renderCfgKeep() {
  const el = $('cfg-keep-list');
  if (!el) return;
  const all = [...(state.wiki.items ?? []), ...(state.wiki.roItems ?? [])];
  const dl = $('cfg-keep-items');
  if (dl && !dl.childElementCount) dl.innerHTML = all.slice(0, 600).map((it) => `<option value="${it.name}"></option>`).join('');
  el.innerHTML = state.cfgKeep.length
    ? state.cfgKeep.map((id) => `<span class="tr-chip">${itemNameOf(id)} <button class="btn small" data-cfgkdel="${id}" title="remove">✕</button></span>`).join(' ')
    : '<span class="muted small">no whitelist items — this bot sells/stores everything (its own potions are always kept)</span>';
}
function fillCfgForm(cfg, bot) {
  state.cfgKeep = [...(cfg.keep ?? [])];
  renderCfgKeep();
  state.cfgMobSel = new Set((cfg.auto?.monsters ?? []).map((v) => {
    if (typeof v === 'number') return String(v);
    const s = String(v);
    if (/^\d+$/.test(s)) return s;
    // legacy plans stored NAMES — convert to monster ids so the auto engine (templateIds) can match
    const mm = (state.wiki.monsters ?? []).find((x) => x.name === v);
    return mm ? String(mm.id) : s;
  }));
  state.cfgFarmMap = cfg.farm?.map ?? (bot?.status?.map ?? null);
  // seed with the runner's farm-mode default rotation so adding a skill extends it instead of replacing it
  state.cfgWeave = cfg.weave?.length ? [...cfg.weave] : (bot?.mode === 'collector' ? [] : ['bash', 'bowling-bash']);
  renderCfgMobs();
  renderCfgWeave();
  state.cfgBuff = [...(cfg.auto?.buffItems ?? [])].map((x) => parseInt(x, 10)).filter(Number.isFinite);
  renderCfgBuff();
  const rad = cfg.auto?.huntRadiusTiles;
  $('cfg-radius').value = rad == null ? '' : (rad === 'all' ? 'all' : String(rad));
  $('cfg-hp').value = cfg.auto?.hpPercent ?? 75;
  $('cfg-chan').checked = cfg.autoChannel !== false; // runner default is on
  $('cfg-collect').checked = cfg.collect?.enabled === true;
  $('cfg-collectpct').value = cfg.collect?.atWeightPct ?? 70;
  $('cfg-cards').checked = cfg.cards === true;
  $('cfg-storewl').checked = cfg.storeWhitelist === true;
  $('cfg-errand').checked = cfg.errand?.enabled === true;
  $('cfg-errandpct').value = cfg.errand?.atWeightPct ?? 70;
  $('cfg-mode').value = ['leveling', 'farming'].includes(cfg.mode) ? cfg.mode : '';
  if ($('cfg-autocollect')) $('cfg-autocollect').checked = cfg.autoCollect?.enabled === true;
  if ($('cfg-autocollect-min')) $('cfg-autocollect-min').value = cfg.autoCollect?.everyMin ?? 240;
  $('cfg-farm').checked = !!cfg.farm;
  if (cfg.farm?.map) $('cfg-farmmap').value = cfg.farm.map;
  else if (state.cfgFarmMap) $('cfg-farmmap').value = state.cfgFarmMap;
  if (cfg.farm?.restockQty != null) $('cfg-restock').value = cfg.farm.restockQty; // 0 is valid = stock none
  if (cfg.farm?.potItem) $('cfg-potitem').value = cfg.farm.potItem;
}
function openCfg(id) {
  state.cfgBot = id;
  state.cfgPlan = null;
  const bot = state.bots.find((b) => b.id === id);
  $('cfg-title').textContent = `Bot config — ${bot?.name ?? '#' + id}`;
  $('cfg-now').textContent = JSON.stringify(bot?.cfg ?? {}, null, 1);
  state.cfgBotMap = bot?.status?.map ?? null;
  // prefill form from the bot's live config (otherwise Apply would overwrite it with defaults)
  fillCfgForm(bot?.cfg ?? {}, bot);
  $('cfg-curmap').textContent = `current map: ${bot?.status?.map ?? '—'}`;
  $('cfg-restart').checked = false;
  $('cfg-selcount').textContent = state.sel.size;
  setCfgMode('bot');
  const plSel = $('cfg-plan-load');
  plSel.innerHTML = '<option value="">— load a plan —</option>' + (state.plans ?? []).map((pl) => `<option value="${pl.id}">${esc(pl.name)}</option>`).join('');
  $('cfg-plan-name').value = '';
  $('cfg-plan-msg').textContent = '';
  $('cfg-modal').classList.remove('hidden');
}
function closeCfg() { state.cfgBot = null; state.cfgPlan = null; $('cfg-modal').classList.add('hidden'); }
// plan editor (no bot attached): create/edit a plan's settings from scratch
function openCfgPlan(planId) {
  const pl = (state.plans ?? []).find((x) => x.id === planId);
  if (!pl) return;
  state.cfgBot = null;
  state.cfgPlan = pl.id;
  $('cfg-title').textContent = `Plan — ${pl.name}`;
  $('cfg-now').textContent = 'plan editor — not attached to a bot. Name it, configure anything, then save (and optionally apply to ticked bots).';
  $('cfg-plan-title').value = pl.name;
  state.cfgBotMap = null;
  fillCfgForm(pl.cfg ?? {}, null);
  $('cfg-curmap').textContent = 'plan editor — no bot attached';
  $('cfg-restart').checked = false;
  $('cfg-selcount').textContent = state.sel.size;
  setCfgMode('plan');
  $('cfg-modal').classList.remove('hidden');
}
function setCfgMode(mode) {
  const planMode = mode === 'plan';
  $('cfg-apply').classList.toggle('hidden', planMode);
  $('cfg-apply-sel').classList.toggle('hidden', planMode);
  $('cfg-apply-all').classList.toggle('hidden', planMode);
  $('cfg-planrow')?.classList.toggle('hidden', planMode);
  $('cfg-planrow-lab')?.classList.toggle('hidden', planMode);
  $('cfg-plan-name-row')?.classList.toggle('hidden', !planMode);
  $('cfg-plan-savebtn')?.classList.toggle('hidden', !planMode);
  $('cfg-plan-saveapply')?.classList.toggle('hidden', !planMode);
}
async function savePlanFromForm({ apply = false } = {}) {
  const pl = (state.plans ?? []).find((x) => x.id === state.cfgPlan);
  if (!pl) return;
  const newName = ($('cfg-plan-title')?.value ?? '').trim();
  if (!newName) { $('cfg-now').textContent = 'every plan needs a name — fill in "plan name" at the top first'; return; }
  if (newName !== pl.name) {
    const rr = await api('/api/plans/rename', 'POST', { id: pl.id, name: newName });
    if (rr.error) { $('cfg-now').textContent = `rename failed: ${rr.error}`; return; }
    $('cfg-title').textContent = `Plan — ${newName}`;
  }
  const cfg = collectCfgFromForm();
  const mode = $('cfg-mode').value; if (mode) cfg.mode = mode;
  await api('/api/plans/create', 'POST', { name: newName, cfg });
  $('cfg-now').textContent = `plan "${newName}" saved ✓ — apply it from 📋 Plans`;
  await refreshState();
  if (apply) {
    const ids = [...state.sel];
    if (!ids.length) { $('cfg-now').textContent += '\nno bots ticked on the dashboard — nothing applied'; return; }
    const restart = $('cfg-restart').checked === true;
    const r = await api('/api/plans/apply', 'POST', { id: pl.id, ids, restart });
    $('cfg-now').textContent += `\napplied to ${r.applied ?? 0} bot(s)${restart && r.restarted ? ` · restarting ${r.restarted.count}` : ''}`;
    await refreshState();
  }
}
function collectCfgFromForm() {
  const cfg = {};
  const radius = $('cfg-radius').value;
  const hp = parseInt($('cfg-hp').value, 10);
  cfg.auto = cfg.auto ?? {};
  if (radius) cfg.auto.huntRadiusTiles = radius === 'all' ? 'all' : parseInt(radius, 10);
  if (Number.isFinite(hp)) cfg.auto.hpPercent = hp;
  // the auto engine matches monster TEMPLATE IDS (numbers) — never names; [] = hunt everything
  cfg.auto.monsters = [...state.cfgMobSel].map((s) => Number(s)).filter(Number.isFinite);
  cfg.auto.buffItems = [...state.cfgBuff];
  if (state.cfgWeave.length) cfg.weave = [...state.cfgWeave];
  cfg.autoChannel = $('cfg-chan').checked;
  cfg.collect = { enabled: $('cfg-collect').checked, atWeightPct: parseInt($('cfg-collectpct').value, 10) || 70 };
  cfg.errand = { enabled: $('cfg-errand').checked, atWeightPct: parseInt($('cfg-errandpct').value, 10) || 70 };
  cfg.keep = [...state.cfgKeep];
  cfg.autoCollect = { enabled: $('cfg-autocollect')?.checked === true, everyMin: parseInt($('cfg-autocollect-min')?.value, 10) || 240 };
  cfg.cards = $('cfg-cards')?.checked === true; // keep-all-cards toggle rides with the whitelist
  cfg.storeWhitelist = $('cfg-storewl')?.checked === true; // per-plan: bank whitelist into the bot's own storage
  if ($('cfg-farm').checked) {
    const rq = parseInt($('cfg-restock').value, 10); // 0 is VALID (stock none) — must not falsy-default to 45
    cfg.farm = {
      map: ($('cfg-farmmap').value || state.cfgFarmMap || 'frost_pass'),
      keep: [...state.cfgKeep],
      hpPercent: Number.isFinite(hp) ? hp : 75,
      restockQty: Number.isFinite(rq) ? rq : 45,
      potItem: ($('cfg-potitem').value.trim() || 'Red Potion'),
    };
  }
  return cfg;
}
async function applyCfg(target) {
  const cfg = collectCfgFromForm();
  const mode = $('cfg-mode').value;
  const restart = $('cfg-restart').checked === true;
  if (target === 'all') {
    if (mode) cfg.mode = mode; // route applies it to every bot (restart needed to take effect)
    const r = await api('/api/bots/config-all', 'POST', cfg);
    $('cfg-now').textContent = `applied to ${r.applied ?? 0} bots${r.mode ? ` — mode set to ${r.mode}` : ''}`;
    if (mode || restart) {
      $('cfg-now').textContent += `\nrestarting the whole fleet (~4 min)…`;
      const rr = await api('/api/bots/restart-all', 'POST', { rampMs: 3000 });
      $('cfg-now').textContent += rr.ok ? ' restart-all started ✓' : ` restart failed: ${rr.error ?? '?'}`;
    }
  } else if (target === 'sel') {
    const ids = [...state.sel];
    if (!ids.length) { $('cfg-now').textContent = 'no bots selected — tick bots on the dashboard first (checkbox on each card, or the select-all box), then Apply to selected'; return; }
    if (mode) cfg.mode = mode;
    const r = await api('/api/bots/config-many', 'POST', { ids, ...cfg });
    $('cfg-now').textContent = `applied to ${r.applied ?? 0} of ${ids.length} selected bot(s)${r.mode ? ` — mode set to ${r.mode}` : ''}`;
    if (mode || restart) {
      $('cfg-now').textContent += `\nrestarting ${ids.length} selected bot(s)…`;
      const rr = await api('/api/bots/restart-many', 'POST', { ids });
      $('cfg-now').textContent += rr.ok ? ` restart started ✓ (${rr.count})` : ` restart failed: ${rr.error ?? '?'}`;
    }
  } else if (state.cfgBot != null) {
    const r = await api(`/api/bots/${state.cfgBot}/config`, 'POST', cfg);
    $('cfg-now').textContent = JSON.stringify(cfg, null, 1) + `\n→ ${JSON.stringify(r)}`;
    if (mode) await api(`/api/bots/${state.cfgBot}/mode`, 'POST', { mode });
    if (mode || restart) {
      $('cfg-now').textContent += `\n${mode ? `mode=${mode} · ` : ''}restarting bot…`;
      const rr = await api(`/api/bots/${state.cfgBot}/restart`, 'POST', {});
      $('cfg-now').textContent += rr.ok ? ' done ✓' : ` failed (restart manually): ${rr.error ?? '?'}`;
    }
  }
  $('cfg-restart').checked = false;
  refreshState();
}

// ---------- interactions ----------
document.addEventListener('change', async (ev) => {
  const t = ev.target;
  if (t.dataset.sel) { t.checked ? state.sel.add(+t.dataset.sel) : state.sel.delete(+t.dataset.sel); saveSel(); renderBots(); renderScopeViews(); const gm = $('gmsg'); if (gm) gm.textContent = state.sel.size ? `${state.sel.size} ticked` : ''; }
  if (t.dataset.accsel) { t.checked ? state.accSel.add(+t.dataset.accsel) : state.accSel.delete(+t.dataset.accsel); renderAccounts(); }
  if (t.dataset.inc) { await api(`/api/characters/${t.dataset.inc}`, 'PATCH', { included: t.checked }); refreshState(); }
  if (t.dataset?.mob) { t.checked ? state.cfgMobSel.add(t.dataset.mob) : state.cfgMobSel.delete(t.dataset.mob); }
  if (t.id === 'cfg-farmmap') {
    state.cfgFarmMap = t.value || null;
    $('cfg-farm').checked = true; // picking a map implies applying farming config
    $('cfg-restart').checked = true; // farm-map changes only take effect after a restart
    renderCfgMobs();
  }
  if (t.id === 'sel-all') { state.botSelIdx = -1; for (const b of groupedBots()) (t.checked ? state.sel.add(b.id) : state.sel.delete(b.id)); saveSel(); renderBots(); renderScopeViews(); }
});

// Accounts tab: shift+click selects the whole range between the last-clicked checkbox and this one
// (Explorer-style). Checkbox state flips BEFORE click listeners run, so t.checked is the click's intent —
// apply it to every row in between. The sidebar rows re-render on every tick, so the anchor is an INDEX.
document.addEventListener('click', (ev) => {
  const t = ev.target;
  if (!(t instanceof HTMLInputElement) || !t.dataset?.accsel) return;
  const list = [...$('accounts-table').querySelectorAll('input[data-accsel]')];
  const idx = list.indexOf(t);
  if (idx < 0) return;
  const last = state.accSelIdx ?? -1;
  if (ev.shiftKey && last >= 0 && last < list.length) {
    const [a, b] = last <= idx ? [last, idx] : [idx, last];
    for (let i = a; i <= b; i++) {
      const cb = list[i];
      cb.checked = t.checked; // keep the visuals consistent across the range
      const id = +cb.dataset.accsel;
      if (t.checked) state.accSel.add(id); else state.accSel.delete(id);
    }
    renderAccounts(); // the clicked box's own change may never bubble (its row was replaced) — bookkeeping done above
  }
  state.accSelIdx = idx;
});

// Dashboard: same shift+click range behavior as the Accounts tab, for the fleet checkboxes (grid AND list
// view — querySelectorAll follows document order == the rendered/filtered order). select-all and group
// pills replace the selection programmatically, so they reset the anchor (see their handlers).
document.addEventListener('click', (ev) => {
  const t = ev.target;
  if (!(t instanceof HTMLInputElement) || !t.dataset?.sel) return;
  const list = [...document.querySelectorAll('input[data-sel]')];
  const idx = list.indexOf(t);
  if (idx < 0) return;
  const last = state.botSelIdx ?? -1;
  if (ev.shiftKey && last >= 0 && last < list.length) {
    const [a, b] = last <= idx ? [last, idx] : [idx, last];
    for (let i = a; i <= b; i++) {
      const cb = list[i];
      cb.checked = t.checked; // keep the visuals consistent across the range
      const id = +cb.dataset.sel;
      if (t.checked) state.sel.add(id); else state.sel.delete(id);
    }
    saveSel();
    renderBots(); // the clicked box's own change may never bubble (its card/row was replaced) — bookkeeping done above
    renderScopeViews();
    const gm = $('gmsg'); if (gm) gm.textContent = state.sel.size ? `${state.sel.size} ticked` : '';
  }
  state.botSelIdx = idx;
});

document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('button, .card, tr.row-bot');
  if (!t) return;
  const act = t.dataset?.act;
  if (act) {
    ev.stopPropagation();
    await api(`/api/bots/${t.dataset.id}/${act}`, 'POST');
    setTimeout(refreshState, 400);
    return;
  }
  if (t.dataset?.cfg) { openCfg(parseInt(t.dataset.cfg, 10)); return; }
  if (t.dataset?.stat) { openBotModal(parseInt(t.dataset.stat, 10)); return; }
  if (t.dataset?.collect) { await api(`/api/bots/${t.dataset.collect}/collect`, 'POST'); refreshState(); return; }
  if (t.dataset?.kick) {
    const id = +t.dataset.kick;
    const b = state.bots.find((x) => x.id === id);
    const r = await api(`/api/bots/${id}/kick`, 'POST').catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
    alert(r.ok
      ? `kicked ${b?.name ?? '#' + id}'s previous session ✓\n\nThe character seat is free — restart or play the bot to log in now.`
      : `kick failed for ${b?.name ?? '#' + id}: ${r.error ?? ('HTTP ' + (r.status ?? '?'))}`);
    refreshState();
    return;
  }
  if (t.dataset?.cfgkdel) { state.cfgKeep = state.cfgKeep.filter((x) => x !== parseInt(t.dataset.cfgkdel, 10)); renderCfgKeep(); return; }
  if (t.dataset?.cfgbdel) { state.cfgBuff = state.cfgBuff.filter((x) => x !== parseInt(t.dataset.cfgbdel, 10)); renderCfgBuff(); return; }
  if (t.dataset?.wup) { const i = parseInt(t.dataset.wup, 10); if (i > 0) { const a = state.cfgWeave; [a[i - 1], a[i]] = [a[i], a[i - 1]]; renderCfgWeave(); } return; }
  if (t.dataset?.wdown) { const i = parseInt(t.dataset.wdown, 10); const a = state.cfgWeave; if (i < a.length - 1) { [a[i + 1], a[i]] = [a[i], a[i + 1]]; renderCfgWeave(); } return; }
  if (t.dataset?.wdel) { state.cfgWeave.splice(parseInt(t.dataset.wdel, 10), 1); renderCfgWeave(); return; }
  if (t.id === 'cfg-skill-addbtn') { const v = $('cfg-skill-add').value; if (v && !state.cfgWeave.includes(v)) { state.cfgWeave.push(v); renderCfgWeave(); $('cfg-skill-add').value = ''; } return; }
  if (t.dataset?.pw) {
    const id = +t.dataset.pw;
    if (!state.pw.has(id)) { const r = await api(`/api/accounts/${id}/password`); state.pw.set(id, r.password ?? '—'); }
    if (state.pwShow.has(id)) state.pwShow.delete(id); else state.pwShow.add(id);
    renderAccounts();
    return;
  }
  if (t.dataset?.pwcopy) {
    const v = state.pw.get(+t.dataset.pwcopy);
    if (v) { try { await navigator.clipboard.writeText(v); t.textContent = 'copied ✓'; setTimeout(() => { t.textContent = 'copy'; }, 1200); } catch {} }
    return;
  }
  if (t.dataset?.colsave) {
    const id = +t.dataset.colsave;
    const z = $('col-list').querySelector(`[data-colz="${id}"]`)?.value;
    const i = $('col-list').querySelector(`[data-coli="${id}"]`)?.value;
    const r = await api('/api/settings/collectors', 'POST', { id, zenyCap: z, itemCapPerItem: i });
    $('col-msg').textContent = r.ok ? `collector #${id} caps saved` : ('err: ' + (r.error ?? '?'));
    refreshState();
    return;
  }
  if (t.dataset?.coldetect) {
    const id = +t.dataset.coldetect;
    const row = (state.collect?.collectors ?? []).find((x) => x.id === id);
    const cb = row?.botId != null ? state.bots.find((b) => b.id === row.botId) : null;
    if (!cb) { $('col-msg').textContent = 'this pool row has no enrolled bot yet'; return; }
    const st = cb.status ?? {};
    if (st.map !== 'capital') { $('col-msg').textContent = `${cb.name} is on ${st.map ?? 'unknown'} — bring it to the capital first`; return; }
    const tm = st.lastMoveTile;
    if (!tm) { $('col-msg').textContent = `${cb.name} has not reported a position yet`; return; }
    const px = Math.round(tm[0] * 32), py = Math.round(tm[1] * 32);
    const r = await api('/api/settings/collectors', 'POST', { id, channel: st.channel ?? row.channel ?? 1, spotX: px, spotY: py });
    $('col-msg').textContent = r?.ok ? `⌖ ${cb.name}: channel ${st.channel ?? '?'} @ (${px}, ${py}) saved — it keeps parking there` : `detect failed: ${r?.error ?? '?'}`;
    refreshState();
    return;
  }
  if (t.dataset?.coldel) {
    const id = +t.dataset.coldel;
    if (confirm(`Remove collector #${id} from the pool?\n\nThe account and its bot stay — it just stops receiving transfers.`)) {
      await api('/api/settings/collectors', 'POST', { remove: id });
      $('col-msg').textContent = `collector #${id} removed from the pool`;
      refreshState();
    }
    return;
  }
  if (t.dataset?.colact) {
    const [act, idStr] = String(t.dataset.colact).split(':');
    const id = +idStr; if (!id) return;
    if (act === 'start') await api('/api/bots/start-many', 'POST', { ids: [id], rampMs: 0 });
    else if (act === 'stop') await api('/api/bots/stop-many', 'POST', { ids: [id] });
    else if (act === 'restart') await api('/api/bots/restart-many', 'POST', { ids: [id] });
    $('col-msg').textContent = `${act} sent for bot #${id}`;
    refreshState();
    return;
  }
  if (t.dataset?.colpw) {
    const id = +t.dataset.colpw;
    if (!state.pw.has(id)) { const r = await api(`/api/accounts/${id}/password`); state.pw.set(id, r.password ?? '—'); }
    if (state.pwShow.has(id)) state.pwShow.delete(id); else state.pwShow.add(id);
    renderCollector();
    return;
  }
  if (t.dataset?.mkchar) { await api(`/api/accounts/${t.dataset.mkchar}/characters`, 'POST'); refreshState(); return; }
  if (t.dataset?.pull) { await openCharPick(+t.dataset.pull); return; }
  if (t.dataset?.pullpick) { await doPullPick(+t.dataset.pullpick, t.dataset.pullname); return; }
  if (t.dataset?.refresh) { await api(`/api/characters/${t.dataset.refresh}/refresh`, 'POST'); refreshState(); return; }
  if (t.classList?.contains('card') || t.classList?.contains('row-bot')) {
    if (['INPUT', 'BUTTON'].includes(ev.target.tagName) && ev.target.closest('.foot, .top, .botlist')) return;
    state.selectedLog = +t.dataset.bot;
    if (!state.logs.has(state.selectedLog)) {
      const r = await api(`/api/bots/${state.selectedLog}/events?limit=400`);
      state.logs.set(state.selectedLog, (r.events ?? []).map((e) => ({ t: e.t, evt: e.evt, data: e.data })));
    }
    renderBots(); renderLog();
  }
});

const bulk = async (action, ids) => { for (const id of ids) await api(`/api/bots/${id}/${action}`, 'POST'); setTimeout(refreshState, 500); };
$('play-sel').onclick = () => bulk('play', [...state.sel]);
$('pause-sel').onclick = () => bulk('pause', [...state.sel]);
$('stop-sel').onclick = () => bulk('stop', [...state.sel]);
$('stop-all').onclick = async () => { if (confirm('STOP ALL bots?')) { await api('/api/bots/stop-all', 'POST'); setTimeout(refreshState, 800); } };
$('dc-all').onclick = async () => {
  if (confirm('EMERGENCY: instantly disconnect ALL bots from the game?\n\nHard-kills their sessions with NO graceful leave. Bots stay OFF until you start them again.')) {
    const r = await api('/api/bots/disconnect-all', 'POST');
    const note = document.getElementById('dash-note');
    if (note) note.textContent = `🔥 disconnected ${r.killed ?? 0} runner(s) — bots are OFF`;
    setTimeout(refreshState, 800);
  }
};

$('reg-go').onclick = async () => {
  const count = parseInt($('reg-count').value, 10) || 1;
  await api('/api/accounts/register', 'POST', { count, createChars: $('reg-chars').checked, autoInclude: $('reg-include').checked });
  refreshState();
};
$('chars-go').onclick = async () => {
  await api('/api/jobs/create-characters', 'POST', {});
  refreshState();
};
$('imp-go').onclick = async () => {
  const lines = $('imp-lines').value;
  const r = await api('/api/accounts/import', 'POST', { lines });
  $('imp-msg').textContent = `importing ${r.imported ?? 0}…${r.results?.length ? ' (' + r.results.map((x) => x.error).join('; ') + ')' : ''}`;
  refreshState();
};
// Accounts tab: select accounts → delete. First confirm removes them from the Command Center; the second
// confirm asks whether to ALSO wipe them from the program entirely (account + characters + bots + logs).
$('acc-del').onclick = async () => {
  const ids = [...state.accSel];
  if (!ids.length) { $('acc-del-msg').textContent = 'tick accounts first'; return; }
  if (!confirm(`Remove ${ids.length} account(s) from the Command Center?\n\nTheir bots are stopped and hidden, characters are excluded from the roster.`)) return;
  const purge = confirm(`ALSO delete them entirely from the program?\n\nOK = permanently delete the account, its characters, bots and logs (cannot be undone).\nCancel = remove from the Command Center only (rows kept).`);
  const r = await api('/api/accounts/delete', 'POST', { ids, purge });
  if (r && r.ok) {
    $('acc-del-msg').textContent = purge
      ? `✓ purged ${r.purged} account(s) — ${r.bots} bot(s), ${r.chars} character(s) deleted`
      : `✓ removed ${r.removed} account(s) from the Command Center`;
    state.accSel.clear();
    state.accSelIdx = -1;
    const all = $('accsel-all'); if (all) all.checked = false;
  } else {
    $('acc-del-msg').textContent = `delete failed: ${r?.error ?? 'unknown error'}`;
  }
  refreshState();
};
$('accsel-all').onchange = (e) => {
  const colNames = new Set((state.bots ?? []).filter((b) => b.mode === 'collector').map((b) => b.name));
  const visible = (state.accounts ?? []).filter((a) => !a.retired && !(a.chars ?? []).some((c) => colNames.has(c.name)));
  for (const a of visible) { if (e.target.checked) state.accSel.add(a.id); else state.accSel.delete(a.id); }
  state.accSelIdx = -1; // select-all breaks the shift anchor
  renderAccounts();
};
$('st-go').onclick = async () => {
  const rampMs = parseInt($('st-ramp').value, 10) || 5000;
  const r = await api('/api/bots/start', 'POST', { rampMs });
  alert(`starting ${r.started?.length ?? 0} bots (ramp ${rampMs}ms)`);
  refreshState();
};
$('st-stop').onclick = async () => { if (confirm('STOP ALL BOTS?')) { await api('/api/bots/stop-all', 'POST'); setTimeout(refreshState, 800); } };
$('log-close').onclick = () => { state.selectedLog = null; renderLog(); renderBots(); };
$('log-clear').onclick = () => { if (state.selectedLog) state.logs.set(state.selectedLog, []); renderLog(); };

// deselect-all (view toggle removed 2026-10-08 — the dashboard is list-only now)
$('sel-none').onclick = () => {
  state.sel.clear();
  state.botSelIdx = -1;
  saveSel();
  renderBots();
  renderScopeViews();
  const gm = $('gmsg'); if (gm) gm.textContent = 'selection cleared';
};

// ---------- shopping (gear-up) tab ----------
function renderShopping() {
  const el = $('shop-queue');
  if (!el) return;
  // completed jobs are auto-removed server-side; filter defensively so a stale 'done' row never shows
  const jobs = (state.shop?.jobs ?? []).filter((j) => j.status !== 'done');
  const cols = state.collect?.collectors ?? [];
  if (!jobs.length) {
    el.innerHTML = '<div class="swim"><div class="swim-lane off"><div class="swim-head"><div class="swim-name"><span>🛒 shopping</span></div><div class="swim-meta"><span>tick knights with red gear dots on the dashboard, then hit 🛒 gear up</span></div></div><div class="swim-empty">— empty —</div></div></div>';
    return;
  }
  const ST = { queued: ['chip', 'in queue'], sent: ['chip', '⇪ grant sent'], traveling: ['chip', '🚶 to collector'], trading: ['chip', '🤝 trading'], buying: ['chip', '🛒 buying'], refining: ['chip', '🔨 refining'], delivering: ['chip', '📦 delivering'], done: ['chip ok', '✓ done'], failed: ['chip bad', '✗ failed'], timeout: ['chip bad', '⏱ timeout'] };
  const needTxt = (n) => {
    const p = [];
    if (n?.gems?.length) p.push(`gems: ${n.gems.map((g) => esc(g)).join(', ')}`);
    if (n?.weapon?.mode === 'refine') p.push(`weapon +${n.weapon.current ?? 0} → +7`);
    else if (n?.weapon?.mode === 'buy') p.push('weapon: +7 Dawnbreaker');
    return p.join(' · ') || 'nothing missing';
  };
  const cardOf = (j) => {
    const [cls, label] = ST[j.status] ?? ['chip', j.status];
    const active = ['sent', 'traveling', 'trading', 'buying', 'refining', 'delivering'].includes(j.status);
    const retryable = j.status === 'failed' || j.status === 'timeout';
    return `<div class="swim-card${active ? ' active' : ''}"><span class="t">${esc(j.botName)} <span class="muted">#${j.botId}</span><div class="swim-sub">${needTxt(j.need)}</div>${j.note ? `<div class="swim-sub">${esc(j.note)}</div>` : ''}</span><span class="${cls}">${label}</span>${active ? '' : `${retryable ? `<button class="btn small ok" data-shopretry="${j.id}" title="re-queue this job with fresh attempts">↻</button> ` : ''}<button class="btn small" data-shopdel="${j.id}" title="remove from the shopping queue">✕</button>`}</div>`;
  };
  const lanes = cols.filter((c) => jobs.some((j) => j.collector === c.charName));
  const known = new Set(lanes.map((c) => c.charName));
  const other = jobs.filter((j) => !known.has(j.collector));
  el.innerHTML = `<div class="muted small" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:2px">
      <span>${jobs.length} job(s) — assigned to the collector with the most zeny · that collector pauses collection while shopping</span>
      <span style="flex:1"></span>
      ${jobs.some((j) => j.status === 'failed' || j.status === 'timeout') ? '<button class="btn small ok" id="shop-retryall" title="re-queue every failed job with fresh attempts">↻ retry failed</button> ' : ''}<button class="btn small" id="shop-clear" title="remove every job that hasn't started yet">⏹ clear waiting</button>
    </div>
    <div class="swim">
      ${lanes.map((c) => {
        const js = jobs.filter((j) => j.collector === c.charName);
        return `<div class="swim-lane${c.live ? '' : ' off'}">
          <div class="swim-head">
            <div class="swim-name"><span>🧰 ${esc(c.charName)}</span>${c.live ? '<span class="chip ok">on</span>' : '<span class="chip bad">off</span>'}</div>
            <div class="swim-meta"><span>${js.length} job(s)</span></div>
          </div>
          ${js.map(cardOf).join('')}
        </div>`;
      }).join('')}
      ${other.length ? `<div class="swim-lane off"><div class="swim-head"><div class="swim-name"><span>⏳ other</span></div></div>${other.map(cardOf).join('')}</div>` : ''}
    </div>`;
}

// drawer tabs
$('drawer-tab-log').onclick = () => { state.drawerTab = 'log'; renderLog(); };
$('drawer-tab-bag').onclick = () => { state.drawerTab = 'bag'; renderLog(); };
$('drawer-tab-earn').onclick = () => { state.drawerTab = 'earn'; $('log-body').dataset.earnSig = ''; state._earnScrolled = false; renderLog(); };

// ---------- custom tooltips (fast + reliable; native title tooltips are slow/flaky) ----------
(() => {
  const tipEl = $('cc-tip');
  let last = null;
  const hide = () => { if (last !== null) { last = null; tipEl.classList.add('hidden'); } };
  document.addEventListener('mousemove', (e) => {
    const t = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
    if (!t) { hide(); return; }
    if (t !== last) { last = t; tipEl.textContent = t.getAttribute('data-tip') ?? ''; }
    tipEl.classList.remove('hidden');
    const r = tipEl.getBoundingClientRect();
    let x = e.clientX + 14;
    let y = e.clientY + 16;
    if (x + r.width > innerWidth - 10) x = Math.max(8, e.clientX - r.width - 14);
    if (y + r.height > innerHeight - 10) y = Math.max(8, e.clientY - r.height - 16);
    tipEl.style.left = x + 'px';
    tipEl.style.top = y + 'px';
  });
  document.addEventListener('wheel', hide, { passive: true });
  // NB: do NOT hide on document mouseleave — Chromium fires a phantom mouseleave on <html> when the
  // chart repaints under the cursor, which made tooltips vanish right after showing ("hover is broken")
  window.addEventListener('blur', hide);
})();

// ---------- drawer resize: drag the grip or header; double-click toggles expand/collapse ----------
(() => {
  const drawer = $('logdrawer');
  const grip = $('drawer-grip');
  const head = drawer.querySelector('.loghead');
  const MIN = 150;
  const DEF = 265;
  const maxH = () => Math.max(240, innerHeight - 90);
  const setH = (px) => {
    const h = Math.max(MIN, Math.min(maxH(), Math.round(px)));
    drawer.style.height = h + 'px';
    document.body.style.setProperty('--drawer-h-px', h + 'px');
    return h;
  };
  const savedH = parseInt(localStorage.getItem('cc.drawerH') || '0', 10);
  if (savedH > 0) setH(savedH);
  let drag = null;
  let drawerPrev = 0; // height before a double-click expand — collapse returns here
  const down = (e) => {
    if (e.target.closest('button, input, label, a')) return;
    if (e.button !== 0) return;
    drag = { y: e.clientY, h: drawer.getBoundingClientRect().height, moved: false };
    drawer.classList.add('resizing');
    e.preventDefault();
  };
  const move = (e) => {
    if (!drag) return;
    if (Math.abs(e.clientY - drag.y) > 3) drag.moved = true;
    if (drag.moved) setH(drag.h + (drag.y - e.clientY));
  };
  const up = () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    drawer.classList.remove('resizing');
    // only a real drag persists a height — plain clicks (e.g. the halves of a double-click) must not
    if (moved) localStorage.setItem('cc.drawerH', String(Math.round(drawer.getBoundingClientRect().height)));
  };
  grip.addEventListener('pointerdown', down);
  head.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  const dbl = (e) => {
    if (e.target.closest('button, input, label, a')) return;
    const cur = drawer.getBoundingClientRect().height;
    if (cur < maxH() - 100) { drawerPrev = Math.round(cur); setH(maxH()); }
    else setH(drawerPrev || parseInt(localStorage.getItem('cc.drawerH') || '0', 10) || DEF);
  };
  grip.addEventListener('dblclick', dbl);
  head.addEventListener('dblclick', dbl);
  window.addEventListener('resize', () => { if (drawer.style.height) setH(drawer.getBoundingClientRect().height); });
  // first-open auto grow for the earnings chart — only until the user resizes the drawer themselves
  window.ccDrawerGrow = () => { if (!localStorage.getItem('cc.drawerH') && drawer.getBoundingClientRect().height < 400) setH(Math.min(520, maxH())); };
})();

// ---------- earnings controls (range + axis ticks) — delegated: the drawer re-renders often ----------
(() => {
  const save = () => { try { localStorage.setItem('cc.earnCfg', JSON.stringify(state.earnCfg)); } catch {} };
  document.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('[data-earn-range]') : null;
    if (!b) return;
    const r = parseInt(b.dataset.earnRange, 10);
    if (!r || r === state.earnCfg.range) return;
    state.earnCfg.range = r;
    save();
    renderLog();
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || (t.id !== 'earn-xtick' && t.id !== 'earn-ytick')) return;
    if (t.id === 'earn-xtick') state.earnCfg.xtick = t.value;
    else state.earnCfg.ytick = t.value;
    save();
    renderLog();
  });
})();

// collector tab
$('col-add').onclick = async () => {
  const r = await api('/api/collectors/ensure', 'POST', {}).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
  $('col-msg').textContent = r?.ok ? `collector created: ${r.charName} (bot #${r.botId}) — walking to its spot` : `create collector: ${r?.busy ? 'already in progress' : (r?.throttled ? 'throttled — try again in a minute' : (r?.error ?? 'unknown'))}`;
  refreshState();
};
async function pushAutoCollect() {
  const enabled = $('col-auto').checked;
  const hrs = Math.max(1, parseInt($('col-auto-hrs').value, 10) || 6);
  const r = await api('/api/settings/collector', 'POST', { autoCollect: { enabled, everyMin: hrs * 60 } });
  $('col-auto-msg').textContent = r.ok
    ? (enabled ? `auto-collect ON — a pass runs every ~${hrs}h (only bots with something to hand over)` : 'auto-collect off')
    : ('err: ' + (r.error ?? '?'));
  refreshState();
}
$('col-auto').onchange = pushAutoCollect;
$('col-auto-hrs').onchange = pushAutoCollect;
async function pushWings() {
  const enabled = $('col-wing').checked;
  const keep = Math.max(0, Math.min(99, parseInt($('col-wing-keep').value, 10) || 0));
  const r = await api('/api/settings/wings', 'POST', { enabled, keep });
  $('col-wing-msg').textContent = r.ok
    ? `wings ${enabled ? 'ON' : 'off'} — bots keep ${r.wings.keep} in the bag and restock at Bor while in town`
    : ('err: ' + (r.error ?? '?'));
  refreshState();
}
$('col-wing-save').onclick = pushWings;
// treasury panel: collapse/expand the collector section (remembered across reloads)
(() => {
  const sec = $('collector-sec');
  if (!sec) return;
  const saved = (() => { try { return localStorage.getItem('cc.colCollapsed'); } catch { return null; } })();
  if (saved === '1') sec.classList.add('collapsed');
  $('collector-hd').onclick = () => {
    sec.classList.toggle('collapsed');
    try { localStorage.setItem('cc.colCollapsed', sec.classList.contains('collapsed') ? '1' : '0'); } catch {}
  };
})();

// (the old "⇪ Collect now — queue all" button moved to the dashboard group bar as "⇪ collect ticked" — 2026-10-09)

// queue controls: per-bot ✕ (skip round + hold), ⏹ clear waiting, ↺ release held — delegated (rows re-render on the 4s refresh)
$('col-queue').addEventListener('click', async (e) => {
  const t = e.target; if (!t) return;
  const del = t.dataset?.qdel; const rel = t.dataset?.qrel;
  try {
    if (del) { const r = await api('/api/collect/dequeue', 'POST', { id: +del }); if (r && r.ok === false) $('col-msg').textContent = r.error ?? 'dequeue failed'; }
    else if (rel) await api('/api/collect/release', 'POST', { id: +rel });
    else if (t.id === 'col-qall') { const r = await api('/api/collect/queue-all', 'POST', {}).catch((e) => ({ error: String((e && e.message) || e) })); if (r && r.queued != null) $('col-msg').textContent = `queued ${r.queued} bot(s) for parallel collection`; else $('col-msg').textContent = `queue-all failed: ${r?.error ?? '?'}`; }
    else if (t.id === 'col-qclear') { const r = await api('/api/collect/clear-waiting', 'POST', {}); if (r && r.removed != null) $('col-msg').textContent = `cleared ${r.removed} waiting bot(s) — they keep farming and stay held`; }
    else if (t.id === 'col-qrel') await api('/api/collect/release', 'POST', {});
    else return;
    refreshState();
  } catch {}
});
// shopping queue controls: ✕ per job + ⏹ clear waiting (delegated — lanes re-render on refresh)
$('shop-queue').addEventListener('click', async (e) => {
  const t = e.target; if (!t) return;
  const del = t.dataset?.shopdel;
  const ret = t.dataset?.shopretry;
  try {
    if (del) await api('/api/shop/dequeue', 'POST', { id: +del });
    else if (ret) await api('/api/shop/retry', 'POST', { id: +ret });
    else if (t.id === 'shop-retryall') await api('/api/shop/retry', 'POST', {});
    else if (t.id === 'shop-clear') await api('/api/shop/clear', 'POST', {});
    else return;
    refreshState();
  } catch {}
});
$('cfg-keep-add').onclick = () => {
  const name = $('cfg-keep-input').value.trim();
  if (!name) return;
  const all = [...(state.wiki.items ?? []), ...(state.wiki.roItems ?? [])];
  const hit = all.find((x) => x.name.toLowerCase() === name.toLowerCase()) ?? all.find((x) => x.name.toLowerCase().includes(name.toLowerCase()));
  if (!hit) { $('cfg-keep-input').value = ''; $('cfg-keep-input').placeholder = 'not found — try another name'; return; }
  if (!state.cfgKeep.includes(hit.id)) state.cfgKeep.push(hit.id);
  $('cfg-keep-input').value = '';
  renderCfgKeep();
};
$('cfg-buff-add').onclick = () => {
  const name = $('cfg-buff-input').value.trim();
  if (!name) return;
  const all = [...(state.wiki.items ?? []), ...(state.wiki.roItems ?? [])];
  const hit = all.find((x) => x.name.toLowerCase() === name.toLowerCase()) ?? all.find((x) => x.name.toLowerCase().includes(name.toLowerCase()));
  if (!hit) { $('cfg-buff-input').value = ''; $('cfg-buff-input').placeholder = 'not found - try another name'; return; }
  if (!state.cfgBuff.includes(hit.id)) state.cfgBuff.push(hit.id);
  $('cfg-buff-input').value = '';
  renderCfgBuff();
};

// config modal
$('cfg-close').onclick = closeCfg;
$('cfg-apply').onclick = () => applyCfg('one');
$('cfg-apply-sel').onclick = () => applyCfg('sel');
$('cfg-apply-all').onclick = () => applyCfg('all');
// saved plans
$('plans-btn').onclick = openPlansModal;
$('plans-close').onclick = () => $('plans-modal').classList.add('hidden');
$('cp-close').onclick = () => $('cp-modal').classList.add('hidden');
$('pl-create').onclick = async () => {
  const name = $('pl-name').value.trim();
  if (!name) { $('pl-msg').textContent = 'enter a plan name'; return; }
  const srcVal = $('pl-from').value;
  if (srcVal === 'blank') {
    if ((state.plans ?? []).some((p) => p.name === name)) { $('pl-msg').textContent = `a plan named "${name}" already exists — open it with ✎ edit, or pick another name`; return; }
    const r = await api('/api/plans/create', 'POST', { name, cfg: {} });
    $('pl-name').value = '';
    await refreshState();
    $('plans-modal').classList.add('hidden');
    openCfgPlan(r.plan.id); // jump straight into the editor — configure the blank plan from scratch
    return;
  }
  const srcBot = state.bots.find((b) => b.id === +srcVal);
  if (!srcBot) { $('pl-msg').textContent = 'no source bot'; return; }
  const r = await api('/api/plans/create', 'POST', { name, cfg: planCfgFromBot(srcBot) });
  $('pl-msg').textContent = r.overwritten ? `plan "${name}" updated ✓ — tweak it with ✎ edit` : `plan "${name}" created ✓ — tweak it with ✎ edit`;
  $('pl-name').value = '';
  await refreshState(); renderPlans();
};
$('pl-list').addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const planOf = (id) => (state.plans ?? []).find((x) => x.id === +id);
  if (t.dataset?.pledit) {
    const pl = planOf(t.dataset.pledit);
    if (!pl) return;
    $('plans-modal').classList.add('hidden');
    openCfgPlan(pl.id);
    return;
  }
  if (t.dataset?.plapply) {
    const ids = [...state.sel];
    if (!ids.length) { $('pl-msg').textContent = 'tick bots on the dashboard first'; return; }
    const pl = planOf(t.dataset.plapply);
    const restart = $('pl-restart')?.checked === true;
    $('pl-msg').textContent = `applying "${pl?.name}" to ${ids.length} bot(s)…`;
    const r = await api('/api/plans/apply', 'POST', { id: +t.dataset.plapply, ids, restart });
    $('pl-msg').textContent = `applied "${pl?.name}" to ${r.applied ?? 0} bot(s)${restart && r.restarted ? ` · restarting ${r.restarted.count}` : ''}`;
    await refreshState(); renderPlans();
    return;
  }
  if (t.dataset?.plupdate) {
    const pl = planOf(t.dataset.plupdate);
    const srcBot = state.bots.find((b) => b.id === +$('pl-from').value);
    if (!pl || !srcBot) { $('pl-msg').textContent = 'pick a source bot first'; return; }
    await api('/api/plans/create', 'POST', { name: pl.name, cfg: planCfgFromBot(srcBot) });
    $('pl-msg').textContent = `plan "${pl.name}" re-captured from ${srcBot.name} ✓`;
    await refreshState(); renderPlans();
    return;
  }
  if (t.dataset?.pldel) {
    const pl = planOf(t.dataset.pldel);
    if (!pl || !confirm(`Delete plan "${pl.name}"?\nBots ALREADY RUNNING its settings keep them — this only removes the saved plan.`)) return;
    await api('/api/plans/delete', 'POST', { id: pl.id });
    $('pl-msg').textContent = `plan "${pl.name}" deleted`;
    await refreshState(); renderPlans();
  }
});
$('cfg-plan-save').onclick = async () => {
  const name = $('cfg-plan-name').value.trim();
  if (!name) { $('cfg-plan-msg').textContent = 'enter a plan name first'; return; }
  const cfg = collectCfgFromForm();
  const mode = $('cfg-mode').value; if (mode) cfg.mode = mode;
  const r = await api('/api/plans/create', 'POST', { name, cfg });
  $('cfg-plan-msg').textContent = r.overwritten ? `plan "${name}" updated ✓` : `plan "${name}" saved ✓`;
  refreshState();
};
$('cfg-plan-load').onchange = (e) => {
  const pl = (state.plans ?? []).find((x) => x.id === parseInt(e.target.value, 10));
  if (!pl) return;
  const bot = state.bots.find((b) => b.id === state.cfgBot);
  fillCfgForm(pl.cfg ?? {}, bot);
  $('cfg-plan-name').value = pl.name;
  $('cfg-plan-msg').textContent = 'loaded — tweak, then Apply (or 💾 save to overwrite the plan)';
};
$('cfg-plan-savebtn').onclick = () => savePlanFromForm({});
$('cfg-plan-saveapply').onclick = () => savePlanFromForm({ apply: true });
$('wh-close').onclick = () => $('wh-modal').classList.add('hidden');
$('kill-close').onclick = () => { $('kill-modal').classList.add('hidden'); clearInterval(state.killWatch); state.killWatch = null; state.killArm = false; };
$('botm-close').onclick = () => { $('bot-modal').classList.add('hidden'); clearInterval(state.botWatch); state.botWatch = null; };
// whitelist modal: item rows expand into a per-character breakdown (delegated — body is re-rendered per open)
$('wh-body').addEventListener('click', (e) => {
  if (e.target.closest('#wh-refresh')) { refreshCollectorStorage(e.target.closest('#wh-refresh')); return; }
  const tr = e.target.closest('tr.wh-item');
  if (!tr) return;
  const det = $('wh-body').querySelector(`tr[data-whdet="${tr.dataset.whrow}"]`);
  if (!det) return;
  det.classList.toggle('hidden');
  const open = !det.classList.contains('hidden');
  if (open) state.whOpen.add(tr.dataset.whrow); else state.whOpen.delete(tr.dataset.whrow);
  const chev = tr.querySelector('.wh-chev');
  if (chev) chev.textContent = open ? '▾' : '▸';
});
// kill modal: chart bar click = toggles that day as the filter
$('kl-chart').addEventListener('click', (e) => {
  const g = e.target.closest('.klbar'); if (!g) return;
  const f = state.killF; const day = g.dataset.day;
  if (f.from === day && f.to === day) { f.from = ''; f.to = ''; } else { f.from = day; f.to = day; }
  const a = document.getElementById('kl-from'), b = document.getElementById('kl-to');
  if (a) a.value = f.from; if (b) b.value = f.to;
  renderKillAll();
});
// kill modal: expandable result rows (state kept across the 8s live re-render)
$('kl-results').addEventListener('click', (e) => {
  const tr = e.target.closest('tr.wh-item'); if (!tr) return;
  const key = tr.dataset.krow;
  const det = [...$('kl-results').querySelectorAll('[data-kdet]')].find((el) => el.dataset.kdet === key);
  if (!det) return;
  det.classList.toggle('hidden');
  const open = !det.classList.contains('hidden');
  if (open) state.killOpen.add(key); else state.killOpen.delete(key);
  const chev = tr.querySelector('.wh-chev');
  if (chev) chev.textContent = open ? '▾' : '▸';
});

connect();
refreshState();
api('/api/wiki').then((w) => { if (w) { state.wiki = { ...state.wiki, ...w }; renderCfgMobs(); renderCfgWeave(); renderCollector(); } }).catch(() => {});
// the server's live stream carries bot status but not the collect queue view — keep it fresh
setInterval(async () => {
  if (document.hidden) return;
  try {
    const s = await api('/api/state');
    state.settings = s.settings ?? state.settings;
    state.collect = s.collect ?? state.collect;
    state.fleet = s.fleet ?? state.fleet;
    renderCollector();
    if (!$('wh-modal').classList.contains('hidden')) openWhModal(); // live numbers while the modal is open
  } catch {}
}, 4000);
setInterval(() => { if (!ws || ws.readyState !== 1) refreshState(); }, 5000);
