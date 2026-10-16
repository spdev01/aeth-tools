// app.js — ROVA Command Center dashboard. Twin of the aetheria CC: KPI strip, bot list table,
// action bar, groups, collector pool, collect/shop queues, whitelist union, fleet totals, plans.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));

const state = {
  view: null,
  sel: new Set(JSON.parse(localStorage.getItem('rova.sel.v1') || '[]')),
  tab: 'dash',
  drawerTab: 'log',
  selectedLog: null,
  logs: new Map(),   // botId -> [{t, evt, data}]
  allLogs: [],       // newest last, capped
  cfgBotId: null,
  cfgKeep: [],
  plansSel: null,
  collectorCollapsed: localStorage.getItem('rova.colcol') === '1',
  wsLive: false,
  groupDraft: '',
  hiddenEvts: new Set(JSON.parse(localStorage.getItem('rova.loghide.v1') || '[]')),
  seenEvts: new Set(),
};
const saveSel = () => localStorage.setItem('rova.sel.v1', JSON.stringify([...state.sel]));

function toast(msg, err) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = 'toast'; }, 3500);
}
async function api(p, method = 'GET', body) {
  try {
    const r = await fetch(p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return await r.json();
  } catch (e) { toast('API unreachable: ' + e.message, true); return {}; }
}
const fleetBots = () => (state.view?.bots ?? []).filter((b) => b.mode !== 'collector');
const selectedIds = () => fleetBots().map((b) => b.id).filter((id) => state.sel.has(id));

// ================================================================= render
function renderAll() {
  renderKpis();
  renderBotsList();
  renderAccounts();
  renderStress();
  renderCollectorTab();
  renderShopping();
  renderPlansList();
  renderLog();
  const n = $('cfg-selcount');
  if (n) n.textContent = state.sel.size;
  $('cc-ver').textContent = state.view ? 'v' + (state.view.meta?.version || '?') : '';
}

function kpi(ic, v, l, cls = '') { return `<div class="kpi ${cls}"><span class="k-ic">${ic}</span><div><div class="k-v">${v}</div><div class="k-l">${l}</div></div></div>`; }

function renderKpis() {
  const v = state.view;
  $('conn').className = 'conn' + (state.wsLive ? '' : ' off');
  if (!v) return;
  const bots = v.bots ?? [];
  const by = {};
  for (const b of bots) { const s = b.runtime?.state || 'stopped'; by[s] = (by[s] || 0) + 1; }
  const running = (by.running || 0) + (by.starting || 0) + (by.restarting || 0);
  const ips = new Set(bots.map((b) => b.status?.exitIp).filter(Boolean));
  const d1 = v.tor?.daemons?.[1]?.listening, d2 = v.tor?.daemons?.[2]?.listening;
  $('kpis').innerHTML =
    kpi('⬢', fmt(bots.length), 'bots', 'k-acc') +
    kpi('▶', fmt(running), 'running', 'k-ok') +
    kpi('⏸', fmt(by.paused || 0), 'paused', 'k-sky') +
    kpi('✖', fmt((by['tor-fail'] || 0) + (by.error || 0)), 'problems', 'k-bad') +
    kpi('👥', fmt((v.accounts ?? []).length), 'accounts', 'k-sky') +
    kpi('⇪', fmt(v.collect?.queue?.length ?? 0), 'collect queue', 'k-wh') +
    kpi('💼', fmt((v.collectors ?? []).length), 'collectors', 'k-gold') +
    kpi('z', fmt(v.fleet?.zeny ?? 0), 'fleet zeny', 'k-gold') +
    kpi('🧅', `${d1 ? '✓' : '✕'}/${d2 ? '✓' : '✕'}`, 'tor d1/d2', d1 && d2 ? 'k-ok' : 'k-bad') +
    kpi('🌐', fmt(ips.size), 'exit IPs', 'k-cyan');
}

function activityBadge(b) {
  const e = b.runtime?.lastEvt;
  if (!e) return '<span class="muted">—</span>';
  const detail = Object.entries(e).filter(([k]) => k !== 'evt').map(([k, x]) => `${k}:${x}`).join(' ');
  return `<span class="act-badge"><span class="lam">${esc(e.evt)}</span> ${esc(String(detail).slice(0, 60))}</span>`;
}

function botListRow(b) {
  const s = b.status ?? {};
  const rt = b.runtime ?? {};
  const st = rt.state || 'stopped';
  const exits = `${rt.lastExit ? `exit ${rt.lastExit.code ?? rt.lastExit}` : ''}${rt.restarts ? `${rt.lastExit ? ' · ' : ''}↻${rt.restarts}` : ''}`;
  const queued = (state.view?.collect?.queue ?? []).includes(b.id);
  const active = (state.view?.collect?.actives ?? []).some((a) => a.botId === b.id);
  return `<tr class="row-bot ${state.selectedLog === b.id ? 'sel' : ''}" data-row="${b.id}">
    <td><input type="checkbox" data-sel="${b.id}" ${state.sel.has(b.id) ? 'checked' : ''} /></td>
    <td class="bl-name"><b>${esc(b.name)}</b> <span class="sdot st-${st}" title="${esc(st)}"></span> <span class="idtag">#${b.id}</span>${b.group ? ` <span class="ms" title="group">📁 ${esc(b.group)}</span>` : ''}${exits ? ` <span class="muted small">${esc(exits)}</span>` : ''}${queued ? ' <span class="ms" title="waiting in collect queue — one-at-a-time">⇪ queued</span>' : ''}${active ? ' <span class="ms pet" title="currently on a collector trip">💼 collecting</span>' : ''}</td>
    <td>${activityBadge(b)}</td>
    <td><span class="badge">${esc(b.mode || 'smoke')}</span></td>
    <td class="bl-mono">${s.port ?? '—'}</td>
    <td class="bl-mono torcell" title="Tor exit IP of this session">🧅 ${esc(s.exitIp || '—')} ${s.isTor === true ? '<span class="tor-ok">✓</span>' : s.isTor === false ? '<span class="tor-bad">✗</span>' : ''}</td>
    <td class="bl-mono">z ${fmt(s.zeny ?? 0)}</td>
    <td class="bl-mono">${s.base ?? '—'}</td>
    <td style="max-width:210px;overflow:hidden;text-overflow:ellipsis" title="${esc(s.note || '')}">${esc(s.note || '—')}</td>
    <td class="bl-acts">
      <button class="btn small" data-cfg="${b.id}" title="config">⚙</button>
      ${b.mode !== 'collector' ? `<button class="btn small" data-qcollect="${b.id}" title="queue for a collector trip">⇪</button>` : ''}
      ${!['running', 'starting', 'restarting', 'queued', 'pausing'].includes(st) ? `<button class="btn ok small" data-act="start" data-id="${b.id}" title="start">▶</button>` : ''}
      ${st === 'running' ? `<button class="btn warn small" data-act="pause" data-id="${b.id}" title="pause">⏸</button>` : ''}
      ${st === 'paused' ? `<button class="btn ok small" data-act="resume" data-id="${b.id}" title="resume">⏵</button>` : ''}
      <button class="btn bad small" data-act="stop" data-id="${b.id}" title="stop">⏹</button>
      <button class="btn bad small" data-act="disconnect" data-id="${b.id}" title="hard disconnect (instant kill)">🔥</button>
    </td>
  </tr>`;
}

function botListTable(bots) {
  return `<div class="botlistwrap"><table class="botlist">
    <thead><tr><th></th><th>bot</th><th>activity</th><th>mode</th><th>port</th><th>exit IP</th><th>zeny</th><th>lvl</th><th>step / note</th><th></th></tr></thead>
    <tbody>${bots.map(botListRow).join('')}</tbody></table></div>`;
}

function renderBotsList() {
  const v = state.view; if (!v) return;
  renderGroupBar();
  const bots = v.bots ?? [];
  const fleet = bots.filter((b) => b.mode !== 'collector');
  const colBots = bots.filter((b) => b.mode === 'collector');
  const sec = $('collector-sec');
  sec.classList.toggle('hidden', colBots.length === 0);
  if (colBots.length) {
    $('collector-bot').innerHTML = botListTable(colBots);
    $('collector-bot').classList.toggle('hidden', state.collectorCollapsed);
    $('collector-chev').textContent = state.collectorCollapsed ? '▸' : '▾';
    const z = colBots.reduce((a, b) => a + (b.status?.zeny ?? 0), 0);
    $('collector-sum').textContent = `${colBots.length} collector${colBots.length > 1 ? 's' : ''} · z ${fmt(z)}`;
  }
  const scrolls = [...document.querySelectorAll('.botlistwrap')].map((el) => el.scrollLeft);
  $('bots').innerHTML = botListTable(fleet);
  document.querySelectorAll('.botlistwrap').forEach((el, i) => { if (scrolls[i] != null) el.scrollLeft = scrolls[i]; });
  $('empty-bots').classList.toggle('hidden', bots.length > 0);
  const selAll = $('sel-all');
  const ids = fleet.map((b) => b.id);
  const ticked = ids.filter((id) => state.sel.has(id)).length;
  selAll.checked = ids.length > 0 && ticked === ids.length;
  selAll.indeterminate = ticked > 0 && ticked < ids.length;
  $('dash-note').textContent = state.sel.size ? `${state.sel.size} ticked` : '';
}

function renderGroupBar() {
  const v = state.view; if (!v) return;
  if (document.activeElement?.id === 'gp-input') return; // don't wipe while typing
  const groups = new Map();
  for (const b of v.bots ?? []) if (b.group) groups.set(b.group, (groups.get(b.group) ?? 0) + 1);
  const pills = [...groups.entries()].map(([g, n]) => `<span class="gpill" data-group="${esc(g)}" title="tick every bot in this group">📁 ${esc(g)} <span class="gcount">×${n}</span></span>`).join('');
  $('group-bar').innerHTML = `${pills}
    <span class="sep"></span>
    <input type="text" id="gp-input" placeholder="group name for ticked" style="width:170px" value="${esc(state.groupDraft)}" />
    <button class="btn small" id="gp-set">set group</button>
    <button class="btn small" id="gp-clear">clear group</button>`;
}

function renderAccounts() {
  const v = state.view; if (!v) return;
  if ([...document.querySelectorAll('.pwdcell')].some((el) => el.dataset.shown === '1')) return; // keep revealed passwords readable
  const accs = v.accounts ?? [];
  const chars = new Map((v.characters ?? []).map((c) => [c.accountId, c]));
  $('accounts-table').querySelector('tbody').innerHTML = accs.map((a) => {
    const ch = chars.get(a.id);
    return `<tr data-acc="${a.id}">
      <td><input type="checkbox" data-accsel="${a.id}" /></td>
      <td>${esc(a.label || '')}</td>
      <td class="bl-mono">${esc(a.userId)}</td>
      <td class="pwdcell" data-reveal="${a.id}" title="click to reveal">●●●●●●</td>
      <td class="st-${esc(a.status || '')}">${esc(a.status || '')}</td>
      <td>${ch ? esc(ch.name) : '<span class="muted">—</span>'}</td>
      <td class="muted small">${a.createdAt ? new Date(a.createdAt).toLocaleDateString() : '—'}</td>
      <td><button class="btn bad small" data-accdel="${a.id}" title="delete">🗑</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" class="muted" style="padding:14px">no accounts yet — import some or create placeholders above</td></tr>';
}

function renderStress() {
  const v = state.view; if (!v) return;
  const bots = v.bots ?? [];
  const running = bots.filter((b) => ['running', 'starting', 'restarting'].includes(b.runtime?.state)).length;
  $('st-summary').innerHTML = `<p class="muted small">bots tracked: <b>${bots.length}</b> · currently active: <b>${running}</b> · each bot rides its own Tor circuit (daemon 1 odd ids / daemon 2 even ids)</p>`;
}

function renderCollectorTab() {
  const v = state.view; if (!v) return;
  const ac = document.activeElement;
  if (ac && ac.closest && ac.closest('#tab-collector') && (ac.tagName === 'INPUT' || ac.tagName === 'TEXTAREA')) return; // don't wipe while editing caps
  // pool
  const cols = v.collectors ?? [];
  $('col-list').innerHTML = cols.map((c) => {
    const b = (v.bots ?? []).find((x) => x.id === c.botId) ?? {};
    return `<div class="col-item">
      <b>${esc(c.name)}</b> <span class="muted small">#${c.botId}</span>
      <span class="state st-${esc(b.runtime?.state || 'stopped')}">${esc(b.runtime?.state || 'stopped')}</span>
      <span class="muted small">zeny z ${fmt(b.status?.zeny ?? 0)}</span>
      <span class="sep"></span>
      <label>zeny cap <input type="number" data-cap="zenyCap" data-bot="${c.botId}" value="${c.zenyCap ?? 0}" title="stop receiving zeny beyond this cap (0 = uncapped)" /></label>
      <label>per-item cap <input type="number" data-cap="itemCapPerItem" data-bot="${c.botId}" value="${c.itemCapPerItem ?? 0}" title="max quantity kept per item (0 = uncapped)" /></label>
      <button class="btn small" data-capsave="${c.botId}">save</button>
    </div>`;
  }).join('') || '<span class="muted small">no collectors in the pool yet</span>';
  // queue
  const q = v.collect ?? { queue: [], actives: [], holds: [], auto: {} };
  const name = (id) => { const b = (v.bots ?? []).find((x) => x.id === id); return b ? `<b>${esc(b.name)}</b> <span class="muted small">#${id}</span>` : `#${id}`; };
  const parts = [];
  if (q.actives.length) {
    parts.push('<div class="muted small" style="margin:4px 0 2px">collecting now</div>');
    for (const a of q.actives) parts.push(`<div class="qline"><span class="qpos">💼</span> ${name(a.botId)} <span class="qcol">→ ${esc(a.collector ?? '')}</span> <span class="muted small">${a.at ? new Date(a.at).toLocaleTimeString() : ''}</span> <span class="spacer"></span><button class="btn small" data-qrelease="${a.botId}">release</button></div>`);
  }
  if (q.queue.length) {
    parts.push(`<div class="muted small" style="margin:6px 0 2px">waiting (${q.queue.length}) — one at a time</div>`);
    q.queue.forEach((id, i) => parts.push(`<div class="qline"><span class="qpos">${i + 1}.</span> ${name(id)} ${(q.holds ?? []).includes(id) ? '<span class="muted small">(hold)</span>' : ''} <span class="spacer"></span><button class="btn small" data-qremove="${id}" title="remove from queue">✕</button></div>`));
  }
  $('col-queue').innerHTML = parts.join('') || 'queue empty — tick bots on the dashboard and press ⇪ Queue collect';
  $('col-auto').checked = !!q.auto?.enabled;
  $('col-auto-min').value = q.auto?.everyMin ?? 240;
  // whitelist union
  const wl = v.fleet?.whitelist ?? [];
  $('tr-list').innerHTML = wl.length
    ? `<div class="wl-list">${wl.map((w) => `<span class="wl-chip" title="requested by ${w.bots} bot(s)">${esc(w.name)} <span>×${w.bots}</span></span>`).join('')}</div>`
    : '<span class="muted small">no items whitelisted yet — add them per bot in ⚙ config (or save a plan and apply to all)</span>';
  // totals
  const f = v.fleet ?? { zeny: 0, perBot: [], items: [] };
  $('tr-totals').innerHTML = `
    <div class="totline">
      <div class="t"><b>z ${fmt(f.zeny)}</b><span>fleet zeny</span></div>
      <div class="t"><b>${fmt((f.perBot ?? []).reduce((a, b) => a + (b.stacks ?? 0), 0))}</b><span>item stacks</span></div>
      <div class="t"><b>${fmt((f.items ?? []).length)}</b><span>distinct items</span></div>
    </div>
    <table class="tr-table"><thead><tr><th>bot</th><th>mode</th><th class="num">zeny</th><th class="num">stacks</th></tr></thead>
    <tbody>${(f.perBot ?? []).map((b) => `<tr><td><b>${esc(b.name)}</b> <span class="muted small">#${b.botId}</span></td><td><span class="badge">${esc(b.mode || '')}</span></td><td class="num">${fmt(b.zeny)}</td><td class="num">${fmt(b.stacks)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">no data yet — workers report zeny/inventory once the game client lands</td></tr>'}</tbody></table>
    ${(f.items ?? []).length ? `<div class="muted small" style="margin:10px 0 4px">items across the fleet</div>
    <table class="tr-table"><thead><tr><th>item</th><th class="num">qty</th></tr></thead><tbody>${(f.items ?? []).slice(0, 60).map(([n, qn]) => `<tr><td>${esc(n)}</td><td class="num">${fmt(qn)}</td></tr>`).join('')}</tbody></table>` : ''}`;
}

function renderShopping() {
  const v = state.view; if (!v) return;
  const jobs = v.shop?.jobs ?? [];
  $('shop-queue').innerHTML = jobs.map((j) => `<div class="qline"><span class="qpos">🛒</span> <b>${esc(j.name)}</b> <span class="muted small">#${j.botId}</span> <span class="badge">${esc(j.status)}</span> <span class="muted small">${esc(j.note || '')}</span> <span class="spacer"></span><button class="btn small" data-shopdel="${j.botId}" title="remove">✕</button></div>`).join('') || 'queue empty';
}

function renderPlansList() {
  const v = state.view; if (!v) return;
  const plans = v.plans ?? [];
  $('plans-list').innerHTML = plans.map((p) => `<div class="plan-item ${state.plansSel === p.name ? 'sel' : ''}" data-plan="${esc(p.name)}">
    <b>📋 ${esc(p.name)}</b><span class="muted small">keep-listed: ${(p.cfg?.keepList ?? []).length} · mode: ${esc(p.cfg?.mode || '—')}${p.cfg?.group ? ` · group: ${esc(p.cfg.group)}` : ''}</span>
    <span class="spacer"></span><button class="btn bad small" data-plandel="${esc(p.name)}">✕</button></div>`).join('') || '<span class="muted small">no plans saved yet — open a bot\'s ⚙ config and "save form as plan"</span>';
}

function renderLog() {
  renderLogFilters();
  if ($('logdrawer').classList.contains('hidden')) return;
  const body = $('log-body');
  if (state.drawerTab === 'bag') return renderBag();
  $('log-title').textContent = state.selectedLog ? `live log — bot #${state.selectedLog}` : 'live log — all bots';
  const arr = (state.selectedLog ? (state.logs.get(state.selectedLog) ?? []) : state.allLogs).filter((e) => !state.hiddenEvts.has(e.evt));
  body.innerHTML = arr.map((e) => {
    const t = String(e.t ?? '').slice(11, 19);
    let d = '';
    try { d = JSON.stringify(e.data ?? {}); } catch { d = ''; }
    return `<div class="ln e-${esc(e.evt)}"><span class="t">${t}</span> <b>#${e.botId}</b> <span class="t2">${esc(e.evt)}</span> <span class="d">${esc(d.length > 200 ? d.slice(0, 200) + '…' : d)}</span></div>`;
  }).join('');
  if ($('log-follow').checked) body.scrollTop = body.scrollHeight;
}

// ---- message-type filter chips ----
const EVT_TYPES = ['boot', 'ready', 'proxy_exit', 'tor_probe_fail', 'control', 'error', 'stopped'];
function logTypes() {
  const extra = new Set();
  for (const e of state.allLogs) if (e.evt && !EVT_TYPES.includes(e.evt)) extra.add(e.evt);
  for (const t of state.seenEvts) if (!EVT_TYPES.includes(t)) extra.add(t);
  return [...EVT_TYPES, ...[...extra].sort()];
}
function renderLogFilters() {
  const bar = $('log-filters');
  if (state.drawerTab !== 'log') { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const sig = logTypes().join(',') + '|' + [...state.hiddenEvts].sort().join(',');
  if (bar.dataset.sig === sig) return;
  bar.dataset.sig = sig;
  const chips = logTypes().map((t) => {
    const off = state.hiddenEvts.has(t);
    return `<button class="fchip e-${esc(t)} ${off ? 'off' : 'on'}" data-fevt="${esc(t)}" title="click to ${off ? 'show' : 'hide'} ${esc(t)} events">${esc(t)}</button>`;
  }).join('');
  bar.innerHTML = `<span class="muted small">show:</span>${chips}<button class="btn small" id="fevt-all" title="show every type again">all</button>`;
}

function renderBag() {
  const body = $('log-body');
  const bot = (state.view?.bots ?? []).find((b) => b.id === state.selectedLog);
  $('log-title').textContent = 'bag' + (bot ? ` — ${bot.name}` : '');
  if (!bot) { body.innerHTML = '<div class="bag-h">click a bot row first</div>'; return; }
  const s = bot.status ?? {};
  const inv = s.inventory ?? [];
  const st = s.storage;
  const rowFor = (it) => `<tr><td class="muted">${it.slot ?? ''}</td><td>${esc(it.name ?? ('#' + it.itemId))}${it.refine ? ` <span class="rf">+${it.refine}</span>` : ''}</td><td class="bl-mono">${it.qty ?? 1}</td></tr>`;
  body.innerHTML = `<div class="bagwrap">
    <div>
      <div class="bag-h">inventory · ${inv.length} stacks · zeny z ${fmt(s.zeny)}</div>
      <table class="bagt"><thead><tr><th>#</th><th>item</th><th>qty</th></tr></thead>
      <tbody>${inv.map(rowFor).join('') || '<tr><td colspan="3" class="muted">empty / waiting for the client snapshot</td></tr>'}</tbody></table>
    </div>
    <div>
      <div class="bag-h">storage ${st ? `· ${(st.items ?? []).length} stacks · zeny z ${fmt(st.zeny)}` : '· (opens once the client lands)'}</div>
      <table class="bagt"><thead><tr><th>#</th><th>item</th><th>qty</th></tr></thead>
      <tbody>${((st?.items ?? []).length ? st.items.map(rowFor).join('') : '<tr><td colspan="3" class="muted">no storage snapshot</td></tr>')}</tbody></table>
    </div>
  </div>`;
}

// ================================================================= cfg modal
function openCfg(botId) {
  const bot = (state.view?.bots ?? []).find((b) => b.id === botId);
  if (!bot) return;
  state.cfgBotId = botId;
  state.cfgKeep = [...(bot.cfg?.keepList ?? [])];
  $('cfg-title').textContent = `Bot config — ${bot.name} #${botId}`;
  $('cfg-mode').value = bot.mode || 'smoke';
  $('cfg-group').value = bot.group || '';
  $('cfg-cards').checked = !!bot.cfg?.cards;
  $('cfg-storewl').checked = !!bot.cfg?.storeWhitelist;
  $('cfg-collect').checked = true;
  $('cfg-collectpct').value = bot.cfg?.collectAtPct ?? 70;
  $('cfg-plan-name').value = '';
  $('cfg-plan-msg').textContent = '';
  $('cfg-restart').checked = false;
  renderCfgKeep();
  $('cfg-modal').classList.remove('hidden');
}
function renderCfgKeep() {
  $('cfg-keep-list').innerHTML = state.cfgKeep.length
    ? state.cfgKeep.map((k, i) => `<span class="pick-chip">${esc(k)} <button data-keepdel="${i}" title="remove">✕</button></span>`).join('')
    : '<span class="muted small">no items yet — empty list = bots sell everything except cards (if keep-all-cards is on)</span>';
}
function cfgPayload() {
  return {
    mode: $('cfg-mode').value,
    group: $('cfg-group').value.trim(),
    keepList: state.cfgKeep,
    cards: $('cfg-cards').checked,
    storeWhitelist: $('cfg-storewl').checked,
    collectAtPct: parseInt($('cfg-collectpct').value, 10) || 70,
  };
}
function addKeepItem() {
  const inp = $('cfg-keep-input');
  const v = inp.value.trim();
  if (v && !state.cfgKeep.includes(v)) state.cfgKeep.push(v);
  inp.value = '';
  renderCfgKeep();
}
async function applyCfg(ids) {
  if (!ids.length) { toast('no bots ticked', true); return; }
  const p = cfgPayload();
  const cfg = { mode: p.mode, keepList: p.keepList, cards: p.cards, storeWhitelist: p.storeWhitelist, collectAtPct: p.collectAtPct };
  const r1 = await api('/api/bots/config-many', 'POST', { ids, cfg });
  await api('/api/bots/group', 'POST', { ids, group: p.group });
  if ($('cfg-restart').checked) {
    for (const id of ids) await api(`/api/bots/${id}/stop`, 'POST');
    await new Promise((r) => setTimeout(r, 1500));
    for (const id of ids) await api(`/api/bots/${id}/start`, 'POST');
  }
  toast(`applied to ${r1.applied ?? ids.length} bot(s)${p.group ? ` · group ${p.group}` : ''}`);
  $('cfg-modal').classList.add('hidden');
}

// ================================================================= events
function pushEvent(m) {
  const e = { t: m.evt?.t, botId: m.botId, evt: m.evt?.evt, data: m.evt?.data ?? {} };
  if (e.evt && !state.seenEvts.has(e.evt)) { state.seenEvts.add(e.evt); renderLogFilters(); }
  if (!state.logs.has(m.botId)) state.logs.set(m.botId, []);
  const arr = state.logs.get(m.botId);
  arr.push(e); if (arr.length > 300) arr.shift();
  state.allLogs.push(e); if (state.allLogs.length > 600) state.allLogs.shift();
  scheduleLogRender();
}
let logTimer = null;
function scheduleLogRender() {
  if (logTimer) return;
  logTimer = setTimeout(() => { logTimer = null; renderLog(); }, 400);
}

function connectWS() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { state.wsLive = true; renderKpis(); };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'state') { state.view = m.state; renderAll(); }
    else if (m.type === 'event') pushEvent(m);
  };
  ws.onclose = () => { state.wsLive = false; renderKpis(); setTimeout(connectWS, 2500); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

// ================================================================= click handling
document.addEventListener('click', async (e) => {
  const t = e.target;
  // ---- tabs ----
  const tabBtn = t.closest('[data-tab]');
  if (tabBtn) {
    document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b === tabBtn));
    state.tab = tabBtn.dataset.tab;
    for (const s of ['dash', 'accounts', 'stress', 'collector', 'shopping']) $(`tab-${s}`).classList.toggle('hidden', s !== state.tab);
    renderAll();
    return;
  }
  // ---- drawer ----
  if (t.closest('#drawer-tab-log')) { state.drawerTab = 'log'; $('drawer-tab-log').classList.add('on'); $('drawer-tab-bag').classList.remove('on'); renderLog(); return; }
  if (t.closest('#drawer-tab-bag')) { state.drawerTab = 'bag'; $('drawer-tab-bag').classList.add('on'); $('drawer-tab-log').classList.remove('on'); renderLog(); return; }
  if (t.closest('#log-clear')) { state.allLogs = []; state.logs.clear(); renderLog(); return; }
  if (t.closest('#log-close')) { $('logdrawer').classList.add('hidden'); return; }
  const fevt = t.closest('[data-fevt]');
  if (fevt) {
    const k = fevt.dataset.fevt;
    state.hiddenEvts.has(k) ? state.hiddenEvts.delete(k) : state.hiddenEvts.add(k);
    localStorage.setItem('rova.loghide.v1', JSON.stringify([...state.hiddenEvts]));
    renderLogFilters(); renderLog();
    return;
  }
  if (t.closest('#fevt-all')) {
    state.hiddenEvts.clear();
    localStorage.setItem('rova.loghide.v1', '[]');
    renderLogFilters(); renderLog();
    return;
  }
  // ---- bot row select (log focus) ----
  const row = t.closest('[data-row]');
  if (row && !t.closest('button') && !t.closest('input')) {
    const id = +row.dataset.row;
    state.selectedLog = state.selectedLog === id ? null : id;
    $('logdrawer').classList.remove('hidden');
    renderBotsList(); renderLog();
    return;
  }
  // ---- per-row actions ----
  const act = t.closest('[data-act]');
  if (act) {
    const id = act.dataset.id, op = act.dataset.act;
    if (op === 'disconnect' && !confirm(`Hard-disconnect bot #${id}? Kills the worker instantly.`)) return;
    const r = await api(`/api/bots/${id}/${op}`, 'POST');
    if (r && r.ok === false && r.error) toast(r.error, true);
    return;
  }
  const cfgBtn = t.closest('[data-cfg]'); if (cfgBtn) { openCfg(+cfgBtn.dataset.cfg); return; }
  const qc = t.closest('[data-qcollect]');
  if (qc) { const r = await api('/api/collect/queue-all', 'POST', { ids: [+qc.dataset.qcollect] }); toast(r.added ? `#${qc.dataset.qcollect} queued for collection` : 'already queued or not eligible', !r.added); return; }
  const qr = t.closest('[data-qrelease]'); if (qr) { const r = await api('/api/collect/release', 'POST', { ids: [+qr.dataset.qrelease] }); toast(`released ${r.released ?? 0}`); return; }
  const qx = t.closest('[data-qremove]'); if (qx) { await api('/api/collect/dequeue', 'POST', { ids: [+qx.dataset.qremove] }); return; }
  const sds = t.closest('[data-shopdel]'); if (sds) { await api('/api/shop/dequeue', 'POST', { ids: [+sds.dataset.shopdel] }); return; }
  // ---- group bar ----
  const gp = t.closest('[data-group]');
  if (gp) {
    let n = 0;
    for (const b of fleetBots()) if (b.group === gp.dataset.group) { state.sel.add(b.id); n++; }
    saveSel(); renderBotsList(); toast(`ticked ${n} bot(s) in ${gp.dataset.group}`);
    return;
  }
  if (t.closest('#gp-set')) {
    const ids = selectedIds();
    if (!ids.length) { toast('tick some bots first', true); return; }
    const group = (document.getElementById('gp-input')?.value || '').trim();
    const r = await api('/api/bots/group', 'POST', { ids, group });
    toast(`group set on ${r.updated ?? 0} bot(s)`);
    return;
  }
  if (t.closest('#gp-clear')) {
    const ids = selectedIds();
    if (!ids.length) { toast('tick some bots first', true); return; }
    await api('/api/bots/group', 'POST', { ids, group: '' });
    toast('group cleared');
    return;
  }
  // ---- collector section collapse ----
  if (t.closest('#collector-hd')) {
    state.collectorCollapsed = !state.collectorCollapsed;
    localStorage.setItem('rova.colcol', state.collectorCollapsed ? '1' : '0');
    renderBotsList();
    return;
  }
  // ---- collector tab ----
  const capsave = t.closest('[data-capsave]');
  if (capsave) {
    const id = +capsave.dataset.capsave;
    const zc = document.querySelector(`[data-cap="zenyCap"][data-bot="${id}"]`)?.value;
    const ic = document.querySelector(`[data-cap="itemCapPerItem"][data-bot="${id}"]`)?.value;
    const r = await api('/api/settings/collectors', 'POST', { botId: id, zenyCap: zc, itemCapPerItem: ic });
    toast(r.ok ? 'caps saved' : (r.error || 'failed'), !r.ok);
    return;
  }
  if (t.closest('#col-add')) { const r = await api('/api/collectors/ensure', 'POST'); toast(r.ok ? `collector created: ${r.bot?.name} #${r.bot?.id}` : (r.error || 'failed'), !r.ok); return; }
  if (t.closest('#q-grant')) { const r = await api('/api/collect/grant', 'POST'); toast(r.ok ? `granted #${r.granted} → ${r.collector}` : (r.error || 'failed'), !r.ok); return; }
  if (t.closest('#q-release')) { const r = await api('/api/collect/release', 'POST'); toast(`released ${r.released ?? 0} active trip(s)`); return; }
  if (t.closest('#q-clear')) { await api('/api/collect/clear-waiting', 'POST'); toast('collect queue cleared'); return; }
  if (t.closest('#col-auto-save')) {
    const r = await api('/api/collect/settings', 'POST', { enabled: $('col-auto').checked, everyMin: parseInt($('col-auto-min').value, 10) || 240 });
    toast(r.ok ? `auto-collect ${r.auto?.enabled ? 'ON' : 'OFF'} every ${r.auto?.everyMin}m` : 'failed', !r.ok);
    return;
  }
  // ---- shopping ----
  if (t.closest('#shop-add')) { const ids = selectedIds(); const r = await api('/api/shop/queue', 'POST', { ids }); toast(`queued ${r.added ?? 0} gear-up job(s)`); return; }
  if (t.closest('#shop-del')) { const ids = selectedIds(); const r = await api('/api/shop/dequeue', 'POST', { ids }); toast(`removed ${r.removed ?? 0}`); return; }
  if (t.closest('#shop-clear')) { await api('/api/shop/clear', 'POST'); toast('gear-up queue cleared'); return; }
  // ---- accounts ----
  const reveal = t.closest('[data-reveal]');
  if (reveal) {
    const r = await api(`/api/accounts/${reveal.dataset.reveal}/password`);
    if (r.ok) { reveal.textContent = r.password || '(empty)'; reveal.dataset.shown = '1'; }
    return;
  }
  const accdel = t.closest('[data-accdel]');
  if (accdel) {
    if (confirm('Delete this account record? (bots of its characters are removed too)')) {
      const r = await api('/api/accounts/delete', 'POST', { id: +accdel.dataset.accdel });
      toast(r.ok ? 'account deleted' : (r.error || 'failed'), !r.ok);
    }
    return;
  }
  // ---- plans modal ----
  const plandel = t.closest('[data-plandel]');
  if (plandel) {
    if (confirm(`Delete plan "${plandel.dataset.plandel}"?`)) { await api('/api/plans/delete', 'POST', { name: plandel.dataset.plandel }); if (state.plansSel === plandel.dataset.plandel) state.plansSel = null; renderPlansList(); }
    return;
  }
  const planItem = t.closest('[data-plan]');
  if (planItem) { state.plansSel = planItem.dataset.plan; renderPlansList(); return; }
  if (t.closest('#plans-apply-sel')) {
    if (!state.plansSel) { toast('pick a plan first', true); return; }
    const ids = selectedIds();
    const r = await api('/api/plans/apply', 'POST', { name: state.plansSel, ids });
    toast(r.ok ? `plan "${state.plansSel}" applied to ${r.applied} bot(s)` : (r.error || 'failed'), !r.ok);
    if (r.ok) $('plans-modal').classList.add('hidden');
    return;
  }
  if (t.closest('#plans-apply-all')) {
    if (!state.plansSel) { toast('pick a plan first', true); return; }
    const r = await api('/api/plans/apply', 'POST', { name: state.plansSel, all: true });
    toast(r.ok ? `plan "${state.plansSel}" applied to ${r.applied} bot(s)` : (r.error || 'failed'), !r.ok);
    if (r.ok) $('plans-modal').classList.add('hidden');
    return;
  }
  // ---- cfg modal ----
  if (t.closest('#cfg-close')) { $('cfg-modal').classList.add('hidden'); return; }
  if (t.closest('#cfg-keep-add')) { addKeepItem(); return; }
  const keepdel = t.closest('[data-keepdel]');
  if (keepdel) { state.cfgKeep.splice(+keepdel.dataset.keepdel, 1); renderCfgKeep(); return; }
  if (t.closest('#cfg-apply')) { await applyCfg([state.cfgBotId]); return; }
  if (t.closest('#cfg-apply-sel')) { await applyCfg(selectedIds()); return; }
  if (t.closest('#cfg-apply-all')) { await applyCfg(fleetBots().map((b) => b.id)); return; }
  if (t.closest('#cfg-plan-save')) {
    const name = $('cfg-plan-name').value.trim();
    const r = await api('/api/plans/save', 'POST', { name, cfg: cfgPayload() });
    $('cfg-plan-msg').textContent = r.ok ? `saved "${name}"` : (r.error || 'failed');
    if (r.ok) toast(`plan "${name}" saved`);
    return;
  }
  if (t.closest('#plans-close')) { $('plans-modal').classList.add('hidden'); return; }
  if (t.closest('#plans-btn')) { renderPlansList(); $('plans-modal').classList.remove('hidden'); return; }
});

// ---- checkboxes ----
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset?.sel) {
    t.checked ? state.sel.add(+t.dataset.sel) : state.sel.delete(+t.dataset.sel);
    saveSel(); renderBotsList();
    return;
  }
  if (t.id === 'gp-input') state.groupDraft = t.value;
});

// ================================================================= wiring (static controls)
function wire() {
  $('sel-all').addEventListener('change', () => {
    for (const b of fleetBots()) { $('sel-all').checked ? state.sel.add(b.id) : state.sel.delete(b.id); }
    saveSel(); renderBotsList();
  });
  $('sel-none').addEventListener('click', () => { state.sel.clear(); saveSel(); renderBotsList(); });
  $('play-sel').addEventListener('click', async () => {
    const ids = selectedIds(); if (!ids.length) { toast('tick some bots first', true); return; }
    toast(`starting ${ids.length} bot(s)…`);
    await api('/api/bots/start-many', 'POST', { ids, rampMs: 1500 });
  });
  $('pause-sel').addEventListener('click', async () => {
    const ids = selectedIds(); if (!ids.length) { toast('tick some bots first', true); return; }
    for (const id of ids) await api(`/api/bots/${id}/pause`, 'POST');
    toast(`paused ${ids.length} bot(s)`);
  });
  $('stop-sel').addEventListener('click', async () => {
    const ids = selectedIds(); if (!ids.length) { toast('tick some bots first', true); return; }
    await api('/api/bots/stop-many', 'POST', { ids });
    toast(`stopping ${ids.length} bot(s)`);
  });
  $('collect-sel').addEventListener('click', async () => {
    const ids = selectedIds(); if (!ids.length) { toast('tick some bots first', true); return; }
    const r = await api('/api/collect/queue-all', 'POST', { ids });
    toast(`queued ${r.added ?? 0} bot(s) for the collector (one at a time)`);
  });
  $('stop-all').addEventListener('click', async () => {
    if (!confirm('Stop ALL bots across the fleet?')) return;
    await api('/api/bots/stop-all', 'POST');
    toast('stopping all bots');
  });
  $('dc-all').addEventListener('click', async () => {
    if (!confirm('EMERGENCY DISCONNECT: instantly kill every worker? Bots stay OFF until you start them again.')) return;
    const r = await api('/api/bots/disconnect-all', 'POST');
    toast(`disconnected ${r.disconnected ?? 'all'} worker(s)`);
  });
  $('add-go').addEventListener('click', async () => {
    const count = Math.max(1, Math.min(50, parseInt($('add-count').value, 10) || 1));
    const r = await api('/api/bots/create', 'POST', { count, mode: 'smoke' });
    toast(r.ok ? `created ${r.bots?.length ?? 0} bot(s)` : (r.error || 'failed'), !r.ok);
  });
  $('reg-go').addEventListener('click', async () => {
    const count = Math.max(1, Math.min(50, parseInt($('reg-count').value, 10) || 1));
    const r = await api('/api/accounts/register', 'POST', { count });
    $('jobbox').innerHTML = `<div class="muted small" style="margin-top:6px">${esc(r.error || 'started')}</div>`;
    toast(r.ok ? `registered ${r.added}` : (r.error || 'not implemented'), !r.ok);
  });
  $('ph-go').addEventListener('click', async () => {
    const count = Math.max(1, Math.min(50, parseInt($('reg-count').value, 10) || 1));
    const r = await api('/api/accounts/placeholder', 'POST', { count });
    toast(r.ok ? `added ${r.added} placeholder account(s)` : (r.error || 'failed'), !r.ok);
  });
  $('imp-go').addEventListener('click', async () => {
    const lines = $('imp-lines').value;
    if (!lines.trim()) { toast('paste some userId:password lines first', true); return; }
    const r = await api('/api/accounts/import', 'POST', { lines });
    $('imp-msg').textContent = r.ok ? `imported ${r.added}` : (r.error || 'failed');
    if (r.ok) { $('imp-lines').value = ''; toast(`imported ${r.added} account(s)`); }
  });
  $('accsel-all').addEventListener('change', () => {
    const on = $('accsel-all').checked;
    document.querySelectorAll('[data-accsel]').forEach((c) => { c.checked = on; });
  });
  $('acc-del').addEventListener('click', async () => {
    const ids = [...document.querySelectorAll('[data-accsel]')].filter((c) => c.checked).map((c) => +c.dataset.accsel);
    if (!ids.length) { toast('tick accounts first', true); return; }
    if (!confirm(`Delete ${ids.length} account record(s)?`)) return;
    for (const id of ids) await api('/api/accounts/delete', 'POST', { id });
    toast(`deleted ${ids.length} account(s)`);
  });
  $('st-go').addEventListener('click', async () => {
    const n = Math.max(1, Math.min(100, parseInt($('st-count').value, 10) || 1));
    const rampMs = Math.max(0, Math.min(60000, parseInt($('st-ramp').value, 10) || 0));
    const ids = fleetBots().slice(0, n).map((b) => b.id);
    if (!ids.length) { toast('no bots yet', true); return; }
    toast(`starting ${ids.length} bot(s), ramp ${rampMs}ms…`);
    await api('/api/bots/start-many', 'POST', { ids, rampMs });
  });
  $('st-stop').addEventListener('click', async () => {
    if (!confirm('Stop ALL bots?')) return;
    await api('/api/bots/stop-all', 'POST');
    toast('stopping all bots');
  });
  $('log-follow').addEventListener('change', () => renderLog());
  $('cfg-keep-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addKeepItem(); } });
}

// ================================================================= boot
async function boot() {
  wire();
  const s = await api('/api/state');
  if (s && s.bots) { state.view = s; }
  renderAll();
  connectWS();
  setInterval(async () => { // safety refresh (covers queue actions between WS pushes)
    const s2 = await api('/api/state');
    if (s2 && s2.bots) { state.view = s2; renderAll(); }
  }, 10000);
}
boot();
