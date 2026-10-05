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
};

// ---------- tabs ----------
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('on', x === b));
  for (const t of ['dash', 'accounts', 'stress']) $('tab-' + t).classList.toggle('hidden', t !== b.dataset.tab);
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
    } else if (msg.type === 'bots') { state.bots = msg.bots; state.jobs = msg.jobs; renderBots(); renderKpis(); }
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
  renderAll();
}

// ---------- render ----------
const fmt = (n) => n == null ? '?' : Number(n).toLocaleString();
function renderAll() { renderKpis(); renderBots(); renderAccounts(); renderJobs(); renderStress(); renderLog(); }

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

function renderKpis() {
  const b = state.bots;
  const by = (s) => b.filter((x) => x.state === s).length;
  const alive = b.filter((x) => ['running', 'starting', 'paused', 'pausing', 'stalled', 'restarting'].includes(x.state));
  const kills = alive.reduce((a, x) => a + (x.status?.killsTotal ?? 0), 0);
  const zeny = alive.reduce((a, x) => a + (x.status?.zeny ?? 0), 0);
  const base = alive.filter((x) => x.status?.base).map((x) => x.status.base);
  const tiles = [
    ['k-ok', '●', by('running'), 'running'],
    ['k-sky', '⏸', by('paused'), 'paused'],
    ['k-bad', '✖', by('error'), 'error'],
    ['k-acc', '⚔', fmt(kills), 'kills'],
    ['k-gold', 'z', fmt(zeny), 'zeny'],
    ['k-cyan', '▲', base.length ? `${Math.min(...base)}–${Math.max(...base)}` : '—', 'base level'],
  ];
  $('kpis').innerHTML = tiles.map(([cls, ic, v, l]) =>
    `<div class="kpi ${cls}"><div class="k-ic">${ic}</div><div class="k-tx"><div class="k-v">${v}</div><div class="k-l">${l}</div></div></div>`
  ).join('');
}

function renderBots() {
  const el = $('bots');
  $('empty-bots').classList.toggle('hidden', state.bots.length > 0);
  el.innerHTML = state.bots.map((b) => {
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
        <span class="exits">${b.lastExit ? `exit ${b.lastExit.code}` : ''}${b.restarts ? `${b.lastExit ? ' · ' : ''}↻${b.restarts}` : ''}</span>
      </div>
    </div>`;
  }).join('');
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

// ---------- interactions ----------
document.addEventListener('change', async (ev) => {
  const t = ev.target;
  if (t.dataset.sel) { t.checked ? state.sel.add(+t.dataset.sel) : state.sel.delete(+t.dataset.sel); renderBots(); }
  if (t.dataset.inc) { await api(`/api/characters/${t.dataset.inc}`, 'PATCH', { included: t.checked }); refreshState(); }
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
  if (t.classList?.contains('card')) {
    if (['INPUT', 'BUTTON'].includes(ev.target.tagName) && ev.target.closest('.foot, .top')) return;
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

connect();
refreshState();
setInterval(() => { if (!ws || ws.readyState !== 1) refreshState(); }, 5000);
