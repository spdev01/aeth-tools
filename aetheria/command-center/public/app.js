/* Command Center dashboard — vanilla JS, WS-driven. */
const $ = (id) => document.getElementById(id);
const api = async (path, method = 'GET', body) => {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return res.json().catch(() => ({}));
};

const state = {
  bots: [], jobs: null, accounts: [], characters: [],
  logs: new Map(), // botId -> [events]
  selectedLog: null, sel: new Set(),
  lv: new Map(), // botId -> { at, lv } — level-up celebration window
  act: new Map(), // botId -> { evt, b, at } — client-side activity feed (WS log stream)
  pw: new Map(), // accountId -> password (fetched on demand)
  pwShow: new Set(), // accountIds currently revealed
  view: localStorage.getItem('cc.view') || 'grid',
  drawerTab: 'log',
  cfgKeep: [],
  cfgMobSel: new Set(),
  cfgBotMap: null,
  cfgFarmMap: null,
  cfgWeave: [],
  wiki: { items: [], roItems: [], monsters: [], skills: [], maps: [] },
  cfgBot: null,
  settings: null, collect: null, fleet: null,
  whOpen: new Set(), whRefreshing: false, whWatch: null,
  killData: null, killF: { view: 'monster', from: '', to: '', bot: 'all', mob: '' },
  killOpen: new Set(), killWatch: null, killArm: false,
};

// ---------- tabs ----------
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('on', x === b));
  for (const t of ['dash', 'accounts', 'stress', 'collector']) $('tab-' + t).classList.toggle('hidden', t !== b.dataset.tab);
  if (b.dataset.tab === 'collector') refreshState();
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
    } else if (msg.type === 'bots') { state.bots = msg.bots; state.jobs = msg.jobs; renderBots(); renderKpis(); renderCollector(); }
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
  state.settings = s.settings ?? state.settings; state.collect = s.collect ?? state.collect; state.fleet = s.fleet ?? state.fleet;
  renderAll();
}

// ---------- render ----------
const fmt = (n) => n == null ? '?' : Number(n).toLocaleString();
function renderAll() { renderKpis(); renderBots(); renderAccounts(); renderJobs(); renderStress(); renderCollector(); renderLog(); }

// ---------- per-bot activity badge (what is this bot doing right now) ----------
const ACTS = {
  combat: ['⚔', 'In combat', 'a-combat'],
  dead: ['☠', 'Dead', 'a-dead'],
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
    if (!kind && b.state === 'running') kind = s.auto ? 'farming' : 'idle';
    const lv = state.lv.get(b.id);
    if (lv && Date.now() - lv.at < 45000 && kind !== 'dead' && kind !== 'recovering') { kind = 'levelup'; info = lv.lv ? 'lv ' + lv.lv : ''; }
  }
  if (!kind) return '';
  const [ic, label, cls] = ACTS[kind] ?? ACTS.idle;
  return `<span class="act ${cls}">${ic} ${label}${info ? ` · ${info}` : ''}</span>`;
}

function whitelistTotals() {
  const tracked = [...allKeepIds()];
  const rows = tracked.map((id) => ({ id, name: itemNameOf(id), bots: 0, botCount: 0, cBag: 0, cStore: 0, per: [] }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const store = state.fleet?.collectorStorage?.items ?? {};
  const per = new Map(); // botId -> { name, id, isCol, bag: {itemId: qty} }
  for (const b of state.bots) {
    const isCol = b.mode === 'collector';
    const e = { name: b.name, id: b.id, isCol, bag: {} };
    for (const it of (b.status?.inventory ?? [])) {
      if (!byId.has(it.itemId)) continue;
      e.bag[it.itemId] = (e.bag[it.itemId] ?? 0) + (it.qty ?? 1);
    }
    const held = Object.keys(e.bag);
    if (held.length) per.set(b.id, e);
    for (const sid of held) {
      const r = byId.get(+sid); const n = e.bag[sid];
      if (isCol) r.cBag += n; else { r.bots += n; r.botCount++; }
    }
  }
  for (const r of rows) {
    r.cStore = store[r.id] ?? 0;
    r.per = [...per.values()]
      .map((e) => ({ name: e.name, id: e.id, isCol: e.isCol, bag: e.bag[r.id] ?? 0 }))
      .filter((x) => x.bag > 0)
      .sort((a, b2) => b2.bag - a.bag);
  }
  const totals = { bots: 0, cBag: 0, cStore: 0 };
  for (const r of rows) { totals.bots += r.bots; totals.cBag += r.cBag; totals.cStore += r.cStore; }
  return { rows, totals };
}
function openWhModal() {
  const tracked = [...allKeepIds()];
  const { rows, totals } = whitelistTotals();
  const cs = state.fleet?.collectorStorage ?? null;
  const colCount = state.bots.filter((b) => b.mode === 'collector').length;
  const atTxt = cs?.at ? new Date(cs.at).toLocaleTimeString() : 'never';
  const ago = cs?.at ? `${Math.max(0, Math.round((Date.now() - cs.at) / 60000))}m ago` : '';
  const refreshing = !!state.whRefreshing;
  const grand = totals.bots + totals.cBag + (cs ? totals.cStore : 0);
  $('wh-body').innerHTML = tracked.length
    ? `<div class="wh-tools">
        <span class="muted small">grand total <b>${fmt(grand)}</b> · bot bags <b>${fmt(totals.bots)}</b> · collector bag <b>${fmt(totals.cBag)}</b> · collector storage <b>${cs ? fmt(totals.cStore) : '—'}</b></span>
        <span class="wh-store"><span class="muted small">🏦 storage as of <b>${atTxt}</b>${ago ? ` <span class="muted">(${ago})</span>` : ''}</span><button id="wh-refresh" class="btn small" ${refreshing || !colCount ? 'disabled' : ''} title="ask the collector to open its storage and re-read it">${refreshing ? '⟳ refreshing…' : '⟳ refresh storage'}</button></span>
      </div>
      <table class="bagt wht"><thead><tr><th>item</th><th>🎒 bot bags</th><th title="number of farming bots holding this item">bots</th><th class="wh-sep">🧰 collector bag</th><th title="last snapshot the collector read from the storage NPC">🏦 collector storage</th><th>total</th></tr></thead><tbody>${rows.map((r) => `
        <tr class="wh-item" data-whrow="${String(r.id)}" title="click for the per-character breakdown"><td><span class="wh-chev">${state.whOpen.has(String(r.id)) ? '▾' : '▸'}</span> ${r.name}</td><td class="bl-mono">${fmt(r.bots)}</td><td class="muted">${r.botCount}</td><td class="bl-mono wh-sep">${fmt(r.cBag)}</td><td class="bl-mono" title="${cs?.at ? 'last read ' + new Date(cs.at).toLocaleString() : 'collector has not read its storage yet'}">${cs ? fmt(r.cStore) : '—'}</td><td class="bl-mono"><b>${fmt(r.bots + r.cBag + (cs ? r.cStore : 0))}</b></td></tr>
        <tr class="wh-det hidden" data-whdet="${String(r.id)}"><td colspan="6">${r.per.length ? r.per.map((p) => `<span class="tr-chip wh-chip">${p.isCol ? '🧰 ' : ''}${p.name} <span class="muted">#${p.id}</span> · bag <b>${fmt(p.bag)}</b></span>`).join(' ') : '<span class="muted small">no character holds this item right now</span>'}</td></tr>`).join('')}</tbody></table>
      <p class="muted small">bot bags = live sum across all farming bots (≤20s heartbeat lag) · collector bag = live · <b>collector storage</b> = last snapshot the collector read from the storage NPC (persisted — survives restarts; if it looks stale hit ⟳ refresh storage) · bots never store — the collector is the only storer · click an item for the per-character breakdown · union of every bot's own whitelist — edit per bot in its ⚙ config (Apply-to-all there sets every bot)</p>`
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

function renderKpis() {
  const b = state.bots;
  const by = (s) => b.filter((x) => x.state === s).length;
  const alive = b.filter((x) => ['running', 'starting', 'paused', 'pausing', 'stalled', 'restarting'].includes(x.state));
  const kills = alive.reduce((a, x) => a + (x.status?.killsTotal ?? 0), 0);
  const zeny = alive.reduce((a, x) => a + (x.status?.zeny ?? 0), 0);
  const base = alive.filter((x) => x.status?.base).map((x) => x.status.base);
  const wt = (state.settings?.tracked?.length ?? 0) ? whitelistTotals().totals : null;
  const wh = wt ? wt.bots + wt.cBag + wt.cStore : null;
  const tiles = [
    ['k-ok', '●', by('running'), 'running'],
    ['k-sky', '⏸', by('paused'), 'paused'],
    ['k-bad', '✖', by('error'), 'error'],
    ['k-acc', '⚔', fmt(kills), 'kills', 'kpi-kills', 'click for the kill log — breakdowns by monster / bot / day'],
    ['k-gold', 'z', fmt(zeny), 'zeny'],
    ['k-cyan', '▲', base.length ? `${Math.min(...base)}–${Math.max(...base)}` : '—', 'base level'],
  ];
  $('kpis').innerHTML = tiles.map(([cls, ic, v, l, id, title]) =>
    `<div class="kpi ${cls}${id ? ' clickable' : ''}"${id ? ` id="${id}"` : ''}${title ? ` title="${title}"` : ''}><div class="k-ic">${ic}</div><div class="k-tx"><div class="k-v">${v}</div><div class="k-l">${l}</div></div></div>`
  ).join('') + `<div class="kpi k-wh clickable" id="kpi-wh" title="whitelist items — farming bot bags + collector bag + collector storage (last seen) — click for details"><div class="k-ic">🧺</div><div class="k-tx"><div class="k-v">${wh == null ? '—' : fmt(wh)}</div><div class="k-l">whitelist total</div></div></div>`;
  const kw = document.getElementById('kpi-wh');
  if (kw) kw.onclick = openWhModal;
  const kk = document.getElementById('kpi-kills');
  if (kk) kk.onclick = openKillModal;
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
        <span class="lv">base <b>${s.base ?? '?'}</b></span>
        <span class="lv">job <b>${s.job ?? '?'}</b></span>
        <span class="map">${s.map ?? '—'}</span>
        <span class="ms">⚔ ${fmt(s.killsTotal)}</span>
        <span class="ms">z ${fmt(s.zeny)}</span>
        ${s.pets?.owned ? `<span class="ms pet">pet ${s.pets.active ? '✓' : s.pets.owned}</span>` : ''}
      </div>
      <div class="vitals">
        <div class="barpair"><span class="bl">HP</span><div class="vbar hpb"><i style="width:${hpPct}%"></i></div><span class="val">${s.dead ? '0' : (s.hp > 0 ? Math.round(s.hp) : '~')}/${s.maxHp ?? '?'}</span></div>
        <div class="barpair"><span class="bl">SP</span><div class="vbar spb"><i style="width:${spPct}%"></i></div><span class="val">${Math.round(s.sp ?? 0)}/${s.maxSp ?? '?'}</span></div>
      </div>
      <div class="step"><span class="st-lab">STEP</span> <span class="st-meta">${s.step ?? '—'} · bag ${s.bag?.used ?? '?'} · pots ${s.pots ?? '?'}${s.dead ? ' · ' : ''}</span>${s.dead ? '<span class="dead">☠ dead</span>' : ''}</div>
      <div class="foot">
        <button class="btn ok small" data-act="play" data-id="${b.id}" title="play">▶</button>
        <button class="btn warn small" data-act="pause" data-id="${b.id}" title="pause">⏸</button>
        <button class="btn bad small" data-act="stop" data-id="${b.id}" title="stop">⏹</button>
        <button class="btn small" data-cfg="${b.id}" title="config (auto-combat, weave, channel, collect)">⚙</button>
        ${b.mode !== 'collector' ? `<button class="btn small" data-collect="${b.id}" title="queue collection to collector">⇪</button>` : ''}
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
  const q = (state.collect?.queue?.length ?? 0) + (state.collect?.active != null ? 1 : 0);
  sum.textContent = `${b.name} · ${b.state} · bag ${s.bag?.used ?? '?'} · z ${fmt(s.zeny)}${q ? ` · queue ${q}` : ''}`;
}

// fleet grid + collector pinned in its own section above
function renderBots() {
  if (state.view === 'list') return renderBotsList();
  $('empty-bots').classList.toggle('hidden', state.bots.length > 0);
  const fleet = state.bots.filter((b) => b.mode !== 'collector');
  const colBots = state.bots.filter((b) => b.mode === 'collector');
  const sec = $('collector-sec');
  if (sec) sec.classList.toggle('hidden', colBots.length === 0);
  renderCollectorSum(colBots);
  if (colBots.length) $('collector-bot').innerHTML = colBots.map(botCard).join('');
  $('bots').innerHTML = fleet.map(botCard).join('');
}

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
  for (const a of state.accounts) {
    const chars = a.chars ?? [];
    if (!chars.length) {
      rows.push(`<tr><td>${a.label ?? ''}</td><td class="muted">${a.userId}</td>${pwCell(a)}<td>${a.type ?? ''}</td><td class="muted">— none —</td><td></td><td></td><td></td><td><button class="btn small" data-mkchar="${a.id}">+ char</button></td></tr>`);
      continue;
    }
    for (const c of chars) {
      rows.push(`<tr>
        <td>${a.label ?? ''}</td><td class="muted">${a.userId}</td>${pwCell(a)}<td>${a.type ?? ''}</td>
        <td><b>${c.name}</b></td>
        <td>${c.classId ?? '?'} · ${c.baseLevel ?? '?'}/${c.jobLevel ?? '?'}</td>
        <td class="muted">${c.mapName ?? '—'}</td>
        <td><input type="checkbox" data-inc="${c.id}" ${c.included ? 'checked' : ''} /></td>
        <td><button class="btn small" data-refresh="${c.id}">refresh</button></td>
      </tr>`);
    }
  }
  tb.innerHTML = rows.join('') || '<tr><td colspan="9" class="muted">no accounts yet — create some above</td></tr>';
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
  if (state.drawerTab === 'bag') { $('log-title').textContent = `bag — ${bot?.name ?? 'bot #' + id}`; renderBag(bot); return; }
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
      <td class="bl-name"><span class="dot"></span> <b>${b.name}</b> <span class="state st-${b.state}">${b.state}</span> <span class="idtag">#${b.id}</span>${exits ? ` <span class="muted small">${exits}</span>` : ''}</td>
      <td>${activityBadge(b, s)}</td>
      <td><span class="badge">${s.classId ?? '?'}</span></td>
      <td class="bl-mono">${s.base ?? '?'}/${s.job ?? '?'}</td>
      <td class="bl-mono">${s.map ?? '—'}</td>
      <td class="bl-hp">
        <div class="vbar hpb" title="HP ${s.dead ? '0' : Math.round(s.hp ?? 0)}/${s.maxHp ?? '?'}"><i style="width:${hpPct}%"></i></div>
        <div class="vbar spb" title="SP ${Math.round(s.sp ?? 0)}/${s.maxSp ?? '?'}"><i style="width:${spPct}%"></i></div>
      </td>
      <td class="bl-mono" title="bag slots used · pots carried">${s.bag?.used ?? '?'} · pots ${s.pots ?? '?'}</td>
      <td>${s.pets?.owned ? `<span class="ms pet">pet ${s.pets.active ? '✓' : s.pets.owned}</span>` : '<span class="muted">—</span>'}</td>
      <td class="bl-mono">z ${fmt(s.zeny)}</td>
      <td class="bl-mono">⚔ ${fmt(s.killsTotal)}</td>
      <td class="bl-step">${s.step ?? '—'}${s.dead ? ' <span class="dead">☠ dead</span>' : ''}</td>
      <td class="bl-acts">
        <button class="btn small" data-cfg="${b.id}" title="config">⚙</button>
        ${b.mode !== 'collector' ? `<button class="btn small" data-collect="${b.id}" title="collect">⇪</button>` : ''}
        <button class="btn ok small" data-act="play" data-id="${b.id}" title="play">▶</button>
        <button class="btn warn small" data-act="pause" data-id="${b.id}" title="pause">⏸</button>
        <button class="btn bad small" data-act="stop" data-id="${b.id}" title="stop">⏹</button>
      </td>
    </tr>`;
}

function botListTable(bots) {
  return `<div class="botlistwrap"><table class="botlist">
    <thead><tr><th></th><th>bot</th><th>activity</th><th>class</th><th>base/job</th><th>map</th><th>hp / sp</th><th>bag · pots</th><th>pet</th><th>zeny</th><th>kills</th><th>step</th><th></th></tr></thead>
    <tbody>${bots.map(botListRow).join('')}</tbody></table></div>`;
}

function renderBotsList() {
  $('empty-bots').classList.toggle('hidden', state.bots.length > 0);
  const fleet = state.bots.filter((b) => b.mode !== 'collector');
  const colBots = state.bots.filter((b) => b.mode === 'collector');
  const sec = $('collector-sec');
  if (sec) sec.classList.toggle('hidden', colBots.length === 0);
  renderCollectorSum(colBots);
  if (colBots.length) $('collector-bot').innerHTML = botListTable(colBots);
  $('bots').innerHTML = botListTable(fleet);
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

// ---------- collector tab ----------
function itemNameOf(id) {
  const all = [...(state.wiki.items ?? []), ...(state.wiki.roItems ?? [])];
  return all.find((x) => x.id === id)?.name ?? ('item#' + id);
}
// union of every bot's own whitelist (collector is excluded — its list is read-only/derived)
function allKeepIds() {
  const s = new Set();
  for (const b of state.bots) { if (b.mode === 'collector') continue; for (const id of (b.cfg?.keep ?? [])) s.add(id); }
  if (!s.size) for (const id of (state.settings?.tracked ?? [])) s.add(id);
  return s;
}
function renderCollector() {
  const col = state.collect?.collector ?? state.settings?.collector;
  if (col) {
    if (document.activeElement !== $('col-name')) $('col-name').value = col.charName ?? '';
    if (document.activeElement !== $('col-channel')) $('col-channel').value = col.channel ?? 1;
    if (document.activeElement !== $('col-x')) $('col-x').value = col.spot?.x ?? 880;
    if (document.activeElement !== $('col-y')) $('col-y').value = col.spot?.y ?? 1520;
  }
  const ac = state.collect?.autoCollect ?? state.settings?.autoCollect;
  if (ac) {
    if (document.activeElement !== $('col-auto')) $('col-auto').checked = !!ac.enabled;
    if (document.activeElement !== $('col-auto-hrs')) $('col-auto-hrs').value = Math.max(1, Math.round((ac.everyMin ?? 360) / 60));
  }
  const q = state.collect?.queue ?? [];
  const held = state.collect?.held ?? [];
  const active = state.collect?.active;
  const byId = new Map(state.bots.map((b) => [b.id, b]));
  const actB = active != null ? byId.get(active) : null;
  const nameOf = (id) => byId.get(id)?.name ?? '#' + id;
  $('col-queue').innerHTML = (active || q.length || held.length)
    ? `${active ? `<div>⇪ trading now: <b>${nameOf(active)}</b>${actB?.status?.map ? ` <span class="muted small">· ${actB.status.map}</span>` : ''}</div>` : ''}
       <div class="muted small" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">${q.length} waiting in line · live${q.length ? ` <button class="btn small" id="col-qclear" title="remove every waiting bot from this round — they keep farming; release them to re-queue">⏹ clear waiting</button>` : ''}${held.length ? ` <button class="btn small" id="col-qrel" title="let held bots auto-queue again">↺ release held (${held.length})</button>` : ''}</div>
       ${q.map((id, i) => `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px"><span>${i + 1}. ${nameOf(id)}</span><button class="btn small" data-qdel="${id}" title="skip this bot for this round — it keeps farming and stays held until you release it or its bag refills into a new round">✕ remove</button></div>`).join('')}
       ${held.length ? `<div class="muted small" style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">held: ${held.map((id) => `<button class="btn small" data-qrel="${id}" title="re-queue now">${nameOf(id)} ↺</button>`).join(' ')}</div>` : ''}`
    : 'queue empty';
  const tracked = [...allKeepIds()];
  $('tr-list').innerHTML = tracked.length
    ? tracked.map((id) => `<span class="tr-chip">${itemNameOf(id)}</span>`).join(' ')
      + '<div class="muted small" style="margin-top:6px">read-only · union of every bot\'s own whitelist — edit per bot in its ⚙ config</div>'
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
    ? list.map((m) => `<label><input type="checkbox" data-mob="${m.name}" ${state.cfgMobSel.has(m.name) ? 'checked' : ''} /> ${m.name}${m.level ? ` <span class="muted small">lv${m.level}</span>` : ''}</label>`).join('')
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
function openCfg(id) {
  state.cfgBot = id;
  const bot = state.bots.find((b) => b.id === id);
  $('cfg-title').textContent = `Bot config — ${bot?.name ?? '#' + id}`;
  $('cfg-now').textContent = JSON.stringify(bot?.cfg ?? {}, null, 1);
  // prefill form from the bot's live config (otherwise Apply would overwrite it with defaults)
  const cfg = bot?.cfg ?? {};
  state.cfgKeep = [...(cfg.keep ?? [])];
  renderCfgKeep();
  state.cfgMobSel = new Set(cfg.auto?.monsters ?? []);
  state.cfgBotMap = bot?.status?.map ?? null;
  state.cfgFarmMap = cfg.farm?.map ?? bot?.status?.map ?? null;
  // seed with the runner's farm-mode default rotation so adding a skill extends it instead of replacing it
  state.cfgWeave = cfg.weave?.length ? [...cfg.weave] : (bot?.mode === 'collector' ? [] : ['bash', 'bowling-bash']);
  $('cfg-curmap').textContent = `current map: ${bot?.status?.map ?? '—'}`;
  $('cfg-restart').checked = false;
  renderCfgMobs();
  renderCfgWeave();
  const rad = cfg.auto?.huntRadiusTiles;
  $('cfg-radius').value = rad == null ? '' : (rad === 'all' ? 'all' : String(rad));
  $('cfg-hp').value = cfg.auto?.hpPercent ?? 75;
  $('cfg-chan').checked = cfg.autoChannel !== false; // runner default is on
  $('cfg-collect').checked = cfg.collect?.enabled === true;
  $('cfg-collectpct').value = cfg.collect?.atWeightPct ?? 70;
  $('cfg-cards').checked = cfg.cards === true;
  $('cfg-errand').checked = cfg.errand?.enabled === true;
  $('cfg-errandpct').value = cfg.errand?.atWeightPct ?? 70;
  $('cfg-mode').value = '';
  $('cfg-farm').checked = !!cfg.farm;
  if (cfg.farm?.map) $('cfg-farmmap').value = cfg.farm.map;
  if (cfg.farm?.restockQty) $('cfg-restock').value = cfg.farm.restockQty;
  if (cfg.farm?.potItem) $('cfg-potitem').value = cfg.farm.potItem;
  $('cfg-modal').classList.remove('hidden');
}
function closeCfg() { state.cfgBot = null; $('cfg-modal').classList.add('hidden'); }
function collectCfgFromForm() {
  const cfg = {};
  const radius = $('cfg-radius').value;
  const hp = parseInt($('cfg-hp').value, 10);
  cfg.auto = cfg.auto ?? {};
  if (radius) cfg.auto.huntRadiusTiles = radius === 'all' ? 'all' : parseInt(radius, 10);
  if (Number.isFinite(hp)) cfg.auto.hpPercent = hp;
  cfg.auto.monsters = [...state.cfgMobSel]; // empty array = hunt all monsters
  if (state.cfgWeave.length) cfg.weave = [...state.cfgWeave];
  cfg.autoChannel = $('cfg-chan').checked;
  cfg.collect = { enabled: $('cfg-collect').checked, atWeightPct: parseInt($('cfg-collectpct').value, 10) || 70 };
  cfg.errand = { enabled: $('cfg-errand').checked, atWeightPct: parseInt($('cfg-errandpct').value, 10) || 70 };
  cfg.keep = [...state.cfgKeep];
  cfg.cards = $('cfg-cards')?.checked === true; // keep-all-cards toggle rides with the whitelist
  if ($('cfg-farm').checked) cfg.farm = {
    map: ($('cfg-farmmap').value || state.cfgFarmMap || 'frost_pass'),
    keep: [...state.cfgKeep],
    hpPercent: Number.isFinite(hp) ? hp : 75,
    restockQty: parseInt($('cfg-restock').value, 10) || 45,
    potItem: ($('cfg-potitem').value.trim() || 'Red Potion'),
  };
  return cfg;
}
async function applyCfg(all) {
  const cfg = collectCfgFromForm();
  const mode = $('cfg-mode').value;
  const restart = $('cfg-restart').checked === true;
  if (all) {
    if (mode) cfg.mode = mode; // route applies it to every bot (restart needed to take effect)
    const r = await api('/api/bots/config-all', 'POST', cfg);
    $('cfg-now').textContent = `applied to ${r.applied ?? 0} bots${r.mode ? ` — mode set to ${r.mode}` : ''}`;
    if (mode || restart) {
      $('cfg-now').textContent += `\nrestarting the whole fleet (~4 min)…`;
      const rr = await api('/api/bots/restart-all', 'POST', { rampMs: 3000 });
      $('cfg-now').textContent += rr.ok ? ' restart-all started ✓' : ` restart failed: ${rr.error ?? '?'}`;
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
  if (t.dataset.sel) { t.checked ? state.sel.add(+t.dataset.sel) : state.sel.delete(+t.dataset.sel); renderBots(); }
  if (t.dataset.inc) { await api(`/api/characters/${t.dataset.inc}`, 'PATCH', { included: t.checked }); refreshState(); }
  if (t.dataset?.mob) { t.checked ? state.cfgMobSel.add(t.dataset.mob) : state.cfgMobSel.delete(t.dataset.mob); }
  if (t.id === 'cfg-farmmap') {
    state.cfgFarmMap = t.value || null;
    $('cfg-farm').checked = true; // picking a map implies applying farming config
    $('cfg-restart').checked = true; // farm-map changes only take effect after a restart
    renderCfgMobs();
  }
  if (t.id === 'sel-all') { for (const b of state.bots) (t.checked ? state.sel.add(b.id) : state.sel.delete(b.id)); renderBots(); }
});

document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('button, .card');
  if (!t) return;
  const act = t.dataset?.act;
  if (act) {
    ev.stopPropagation();
    await api(`/api/bots/${t.dataset.id}/${act}`, 'POST');
    setTimeout(refreshState, 400);
    return;
  }
  if (t.dataset?.cfg) { openCfg(parseInt(t.dataset.cfg, 10)); return; }
  if (t.dataset?.collect) { await api(`/api/bots/${t.dataset.collect}/collect`, 'POST'); refreshState(); return; }
  if (t.dataset?.cfgkdel) { state.cfgKeep = state.cfgKeep.filter((x) => x !== parseInt(t.dataset.cfgkdel, 10)); renderCfgKeep(); return; }
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
  if (t.dataset?.mkchar) { await api(`/api/accounts/${t.dataset.mkchar}/characters`, 'POST'); refreshState(); return; }
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
$('st-go').onclick = async () => {
  const rampMs = parseInt($('st-ramp').value, 10) || 5000;
  const r = await api('/api/bots/start', 'POST', { rampMs });
  alert(`starting ${r.started?.length ?? 0} bots (ramp ${rampMs}ms)`);
  refreshState();
};
$('st-stop').onclick = async () => { if (confirm('STOP ALL BOTS?')) { await api('/api/bots/stop-all', 'POST'); setTimeout(refreshState, 800); } };
$('log-close').onclick = () => { state.selectedLog = null; renderLog(); renderBots(); };
$('log-clear').onclick = () => { if (state.selectedLog) state.logs.set(state.selectedLog, []); renderLog(); };

// view toggle
const syncViewButtons = () => { $('view-grid').classList.toggle('on', state.view === 'grid'); $('view-list').classList.toggle('on', state.view === 'list'); };
$('view-grid').onclick = () => { state.view = 'grid'; localStorage.setItem('cc.view', 'grid'); syncViewButtons(); renderBots(); };
$('view-list').onclick = () => { state.view = 'list'; localStorage.setItem('cc.view', 'list'); syncViewButtons(); renderBots(); };
syncViewButtons();

// drawer tabs
$('drawer-tab-log').onclick = () => { state.drawerTab = 'log'; renderLog(); };
$('drawer-tab-bag').onclick = () => { state.drawerTab = 'bag'; renderLog(); };

// collector tab
$('col-save').onclick = async () => {
  const r = await api('/api/settings/collector', 'POST', { charName: $('col-name').value, channel: $('col-channel').value, spotX: $('col-x').value, spotY: $('col-y').value });
  $('col-msg').textContent = r.ok ? 'saved ✓' : ('err: ' + (r.error ?? '?'));
  refreshState();
};
$('col-clean').onclick = async () => {
  const keep = [...allKeepIds()];
  const colBot = state.bots.find((x) => x.mode === 'collector');
  if (!colBot) { $('col-msg').textContent = 'collector bot not found'; return; }
  const r = await api(`/api/bots/${colBot.id}/config`, 'POST', { cleanup: { at: Date.now(), keep } });
  $('col-msg').textContent = r.ok ? `cleanup armed on ${colBot.name} — ${keep.length} whitelist items protected, everything else gets withdrawn & sold` : ('err: ' + (r.error ?? '?'));
};
$('col-detect').onclick = async () => {
  const colBot = state.bots.find((x) => x.mode === 'collector');
  if (!colBot) { $('col-msg').textContent = 'collector bot not found'; return; }
  const st = colBot.status ?? {};
  if (st.map !== 'capital') { $('col-msg').textContent = `collector is on ${st.map ?? 'unknown'} — bring it to capital first`; return; }
  const t = st.lastMoveTile;
  if (!t) { $('col-msg').textContent = 'collector has not reported a position yet'; return; }
  const px = Math.round(t[0] * 32);
  const py = Math.round(t[1] * 32);
  $('col-name').value = colBot.name;
  if (st.channel) $('col-channel').value = st.channel;
  $('col-x').value = px;
  $('col-y').value = py;
  await api('/api/settings/collector', 'POST', { charName: $('col-name').value, channel: $('col-channel').value, spotX: px, spotY: py });
  $('col-msg').textContent = `detected & saved — ${colBot.name} @ channel ${st.channel ?? '?'} (${px}, ${py})`;
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

$('col-all').onclick = async () => { for (const b of state.bots) { if (b.mode !== 'collector') await api(`/api/bots/${b.id}/collect`, 'POST'); } refreshState(); };

// queue controls: per-bot ✕ (skip round + hold), ⏹ clear waiting, ↺ release held — delegated (rows re-render on the 4s refresh)
$('col-queue').addEventListener('click', async (e) => {
  const t = e.target; if (!t) return;
  const del = t.dataset?.qdel; const rel = t.dataset?.qrel;
  try {
    if (del) { const r = await api('/api/collect/dequeue', 'POST', { id: +del }); if (r && r.ok === false) $('col-msg').textContent = r.error ?? 'dequeue failed'; }
    else if (rel) await api('/api/collect/release', 'POST', { id: +rel });
    else if (t.id === 'col-qclear') { const r = await api('/api/collect/clear-waiting', 'POST', {}); if (r && r.removed != null) $('col-msg').textContent = `cleared ${r.removed} waiting bot(s) — they keep farming and stay held`; }
    else if (t.id === 'col-qrel') await api('/api/collect/release', 'POST', {});
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

// config modal
$('cfg-close').onclick = closeCfg;
$('cfg-apply').onclick = () => applyCfg(false);
$('cfg-apply-all').onclick = () => applyCfg(true);
$('wh-close').onclick = () => $('wh-modal').classList.add('hidden');
$('kill-close').onclick = () => { $('kill-modal').classList.add('hidden'); clearInterval(state.killWatch); state.killWatch = null; state.killArm = false; };
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
