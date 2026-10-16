// ui.js — tabs, filters, tables, search for the ROVA wiki tool.
import {
  state, TYPES, QUICK_SETS, CLASSES, loadCfg, saveCfg, loadDb,
  evOfMob, applyFilters, mapSpawnPass, sortMobs, sortItems, sortMaps,
  buildSrcIndex, srcIndex,
  fmtZ, fmtPct, fmtWeight, itemIconUrl, mobImgUrl, esc,
} from './engine.js';
import { openMob, openItem, openMap, closeDetail } from './details.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

let activeTab = 'monsters';
let itemList = [];         // cached all items
let mapList = [];          // cached computed maps

// ---------- init ----------
init();

async function init() {
  loadCfg();
  let db;
  try {
    db = await loadDb();
  } catch (e) {
    $('#meta').innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`;
    return;
  }
  renderMeta(db);
  buildSrcIndex();
  itemList = Object.values(db.items);
  renderTypeToggles();
  renderClassToggles();
  renderItemTypeChips();
  fillDatalist('#maps-list', Object.values(db.maps).map((m) => m.n));
  fillDatalist('#mobs-list', db.mobs.map((m) => m.n));
  wireEvents();
  applyCfgToInputs();
  $('#search').value = state.cfg.search[activeTab] ?? '';
  renderAll();
}

function renderMeta(db) {
  const c = db.meta.counts;
  const when = new Date(db.meta.builtAt);
  $('#meta').innerHTML = `content <b>${esc(db.meta.contentVersion)}</b> &middot; built ${when.toLocaleDateString()} &middot; ` +
    `<b>${c.mobs}</b> monsters &middot; <b>${c.items}</b> items &middot; <b>${c.maps}</b> maps`;
  $('#pill-mobs').textContent = c.mobs;
  $('#pill-items').textContent = c.items;
  $('#pill-maps').textContent = c.maps;
  $('#about-meta').textContent = `Database built ${when.toLocaleString()} · content version ${db.meta.contentVersion}${db.meta.contentHash ? ' (' + db.meta.contentHash + ')' : ''}.`;
  document.title = 'ROVA Wiki - Drop EV Calculator';
}

// ---------- indexes ----------
function buildItemsList(db) {
  itemList = Object.values(db.items);
}

// ---------- toggles ----------
function renderTypeToggles() {
  const box = $('#type-toggles');
  const counts = {};
  for (const it of itemList) counts[it.t] = (counts[it.t] || 0) + 1;
  box.innerHTML = TYPES.map(([t, label]) =>
    `<label><input type="checkbox" data-type="${t}" ${state.cfg.types.has(t) ? 'checked' : ''}> ${label}<span class="n">${counts[t] || 0}</span></label>`
  ).join('');
  box.addEventListener('change', (e) => {
    const t = e.target.dataset.type;
    if (!t) return;
    if (e.target.checked) state.cfg.types.add(t); else state.cfg.types.delete(t);
    saveCfg();
    renderAll();
  });
}

function renderClassToggles() {
  const box = $('#class-toggles');
  for (const [cls] of CLASSES) {
    $(`input[data-cls="${cls}"]`, box).checked = state.cfg.classes[cls];
  }
  box.addEventListener('change', (e) => {
    const cls = e.target.dataset.cls;
    if (!cls) return;
    state.cfg.classes[cls] = e.target.checked;
    saveCfg();
    renderAll();
  });
}

function renderItemTypeChips() {
  const box = $('#item-type-chips');
  box.innerHTML = `<button data-it="" class="${state.cfg.itemTypes.size ? '' : 'on'}">All types</button>` +
    TYPES.map(([t, label]) => `<button data-it="${t}" class="${state.cfg.itemTypes.has(t) ? 'on' : ''}">${label}</button>`).join('');
  box.onclick = (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const t = btn.dataset.it;
    if (!t) state.cfg.itemTypes.clear();
    else if (state.cfg.itemTypes.has(t)) state.cfg.itemTypes.delete(t);
    else state.cfg.itemTypes.add(t);
    saveCfg();
    renderItemTypeChips();
    renderItems();
  };
}

function applyCfgToInputs() {
  syncFiltersUI();
  $('#scale').value = String(state.cfg.scale);
}

/** Mirror cfg.filters into every [data-bind] control (both tabs stay in sync). */
function syncFiltersUI() {
  const f = state.cfg.filters;
  $$('[data-bind]').forEach((el) => {
    const k = el.dataset.bind;
    const v = f[k];
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.type === 'number') el.value = v == null ? '' : String(v);
    else el.value = v ?? '';
  });
}

function readBind(el) {
  const k = el.dataset.bind;
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'number') return el.value === '' ? null : Math.max(0, Math.floor(Number(el.value)) || 0);
  return el.value;
}

let filterTimer = 0;
function onFilterInput(el) {
  state.cfg.filters[el.dataset.bind] = readBind(el);
  saveCfg();
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    syncFiltersUI();
    rebuildMapsList();
    renderActive();
  }, 150);
}

// ---------- events ----------
function wireEvents() {
  $$('#tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $$('#type-quick button').forEach((b) => b.addEventListener('click', () => {
    const set = QUICK_SETS[b.dataset.quick];
    if (!set) return;
    state.cfg.types = new Set(set);
    saveCfg();
    $$('#type-toggles input').forEach((i) => { i.checked = state.cfg.types.has(i.dataset.type); });
    renderAll();
  }));

  let tid = 0;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(tid);
    tid = setTimeout(() => {
      if (activeTab === 'monsters' || activeTab === 'items' || activeTab === 'maps') {
        state.cfg.search[activeTab] = e.target.value;
        saveCfg();
        renderActive();
      }
    }, 140);
  });

  // shared monster filters (level, aggro, DEF/MDEF/HIT/FLEE) via data-bind; wired on both tabs
  document.addEventListener('input', (e) => {
    const el = e.target.closest?.('[data-bind]');
    if (el && el.type !== 'checkbox') onFilterInput(el);
  });
  document.addEventListener('change', (e) => {
    const el = e.target.closest?.('[data-bind]');
    if (el && (el.type === 'checkbox' || el.tagName === 'SELECT')) onFilterInput(el);
  });

  $('#scale').addEventListener('change', (e) => { state.cfg.scale = Number(e.target.value) || 1; saveCfg(); renderAll(); });
  $('#export-csv').addEventListener('click', exportCsv);
  $('#detail-close').addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

  // sortable headers
  wireSort('#mob-table', state.cfg.mobSort, renderMobs);
  wireSort('#item-table', state.cfg.itemSort, renderItems);
  wireSort('#map-table', state.cfg.mapSort, renderMaps);

  // image fallback (delegated; works for lazy images too)
  window.addEventListener('error', (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG' && t.dataset.fb !== undefined) {
      const span = document.createElement('span');
      span.className = 'icn-fb';
      span.textContent = (t.dataset.fb || '?').slice(0, 2);
      t.replaceWith(span);
    }
  }, true);
}

function wireSort(sel, sortState, rerender) {
  $$(`${sel} thead th[data-sort]`).forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (sortState.key === k) sortState.dir = -sortState.dir;
    else { sortState.key = k; sortState.dir = k === 'name' || k === 'top' || k === 'best' ? 1 : -1; }
    saveCfg();
    markSort(sel, sortState);
    rerender();
  }));
  markSort(sel, sortState);
}

function markSort(sel, sortState) {
  $$(`${sel} thead th`).forEach((th) => {
    th.classList.remove('on', 'asc', 'desc');
    if (th.dataset.sort === sortState.key) {
      th.classList.add('on', sortState.dir > 0 ? 'asc' : 'desc');
      th.textContent = th.textContent.replace(/ [\u25B2\u25BC]$/, '') + (sortState.dir > 0 ? ' \u25B2' : ' \u25BC');
    } else {
      th.textContent = th.textContent.replace(/ [\u25B2\u25BC]$/, '');
    }
  });
}

// ---------- tabs ----------
export function setTab(tab) {
  activeTab = tab;
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $$('.view').forEach((v) => v.classList.toggle('off', v.id !== 'view-' + tab));
  const ph = {
    monsters: 'Search monsters, or type a map name\u2026',
    items: 'Search items\u2026',
    maps: 'Search maps\u2026',
    about: 'Search\u2026',
  }[tab];
  $('#search').placeholder = ph;
  $('#search').disabled = tab === 'about';
  $('#search').value = state.cfg.search[tab] ?? '';
  renderActive();
}

function renderActive() {
  if (activeTab === 'monsters') renderMobs();
  else if (activeTab === 'items') renderItems();
  else if (activeTab === 'maps') renderMaps();
}

export function renderAll() {
  renderMobs();
  rebuildMapsList();   // EV depends on toggles
  renderItems();
  renderMaps();
}

function rebuildMapsList() {
  const db = state.db;
  mapList = [];
  for (const [id, mp] of Object.entries(db.maps)) {
    const rows = [];
    let sum = 0, cnt = 0, best = null;
    for (const [mobId, count, lo, hi] of mp.spawns) {
      const m = db.mobs.find((x) => x.id === mobId);
      if (!m) continue;
      if (!mapSpawnPass(m)) continue;   // level / aggro / stat filters + optional boss exclusion
      const ev = evOfMob(m);
      rows.push({ m, count, lo, hi, ev });
      sum += ev.total * (count || 1);
      cnt += count || 1;
      if (!best || ev.total > best.ev.total) best = { m, ev };
    }
    if (!rows.length) continue;          // no spawn currently qualifies -> hide the map
    rows.sort((a, b) => b.ev.total - a.ev.total);
    mapList.push({ id, n: mp.n, rows, mobCount: rows.length, spawnTotal: cnt, avg: cnt ? sum / cnt : 0, best });
  }
}

// ---------- monsters view ----------
function renderMobs() {
  const all = applyFilters(state.cfg.search.monsters);
  const sorted = sortMobs(all);
  state.mobs = sorted;
  const scale = state.cfg.scale;
  const scaleLbl = scale === 1 ? 'per kill' : `per ${scale.toLocaleString('en-US')} kills`;
  const tbody = $('#mob-rows');
  const frag = document.createDocumentFragment();

  for (const m of sorted) {
    const ev = evOfMob(m);
    let top = null;
    for (const r of ev.rows) if (r.included && (!top || r.ev > top.ev)) top = r;
    const tr = document.createElement('tr');
    tr.dataset.mob = m.id;
    const mobUrl = mobImgUrl(m);
    tr.innerHTML = `
      <td class="left mobname"><span class="mobcell">${mobUrl ? `<img class="mobimg" src="${esc(mobUrl)}" data-fb="${esc(m.n)}" alt="" loading="lazy">` : ''}${esc(m.n)}${m.boss ? '<span class="boss">&#9733;</span>' : ''}</span></td>
      <td>${m.lv}</td>
      <td>${m.hp.toLocaleString('en-US')}</td>
      <td class="left"><span class="badge el-${esc(m.el)}">${esc(m.el)}</span></td>
      <td>${m.boss ? '<span class="badge" style="color:var(--gold);border-color:var(--gold)">boss</span>' : '<span class="dim">-</span>'}</td>
      <td class="ev">${fmtZ(ev.total * scale, { compact: scale > 1 })}${scale > 1 ? `<br><small>${fmtZ(ev.total)}/kill</small>` : ''}</td>
      <td>${ev.included}<span class="dim">/${ev.rows.length}</span></td>
      <td class="left">${top ? topCell(top, scale) : '<span class="dim">-</span>'}</td>
      <td class="left" title="${esc(m.spawns.map((s) => `${state.db.maps[s.map]?.n ?? s.map} x${s.count}`).join(String.fromCharCode(10)))}"><span class="dim">${m.spawns.length || ''}</span></td>`;
    tr.addEventListener('click', () => { selectRow(tr); openMob(m.id); });
    frag.appendChild(tr);
  }
  tbody.replaceChildren(frag);

  $('#mob-count').textContent = `${sorted.length} monsters`;
  $('#ev-note').textContent = `EV ${scaleLbl} \u00b7 ${state.cfg.types.size}/${TYPES.length} categories on`;
  syncEvHeader(scaleLbl);
}

function syncEvHeader(scaleLbl) {
  const th = document.querySelector('#mob-table thead th[data-sort="ev"]');
  if (!th) return;
  const st = state.cfg.mobSort;
  const arrow = st.key === 'ev' ? (st.dir > 0 ? ' \u25b2' : ' \u25bc') : '';
  th.textContent = `EV \u00b7 ${scaleLbl}${arrow}`;
}

function topCell(r, scale) {
  const url = itemIconUrl(r.item);
  const icn = url
    ? `<img class="icn" src="${esc(url)}" data-fb="${esc(r.item.n)}" alt="" loading="lazy">`
    : `<span class="icn-fb">${esc(r.item.n.slice(0, 2))}</span>`;
  const val = fmtZ(r.ev * scale, { compact: true });
  return `<span class="itemcell" title="biggest EV contributor: drop chance x sell price (${fmtPct(r.chance)}, sells ${fmtZ(r.item.s)}z)">${icn}${esc(r.item.n)} <span class="dim">${val}z</span></span>`;
}

function selectRow(tr) {
  $$('#mob-rows tr.sel').forEach((t) => t.classList.remove('sel'));
  tr.classList.add('sel');
}

// ---------- items view ----------
function renderItems() {
  const q = (state.cfg.search.items || '').trim().toLowerCase();
  let list = itemList;
  if (q) list = list.filter((it) => it._lname.includes(q) || String(it._id) === q);
  if (state.cfg.itemTypes.size) list = list.filter((it) => state.cfg.itemTypes.has(it.t));
  list = sortItems(list);

  const tbody = $('#item-rows');
  const frag = document.createDocumentFragment();
  for (const it of list.slice(0, 800)) {
    const src = srcIndex()[it._id];
    const bits = [];
    if (src?.droppedBy.length) bits.push(`drop: ${src.droppedBy.length}`);
    if (src?.shops.length) bits.push(`shop ${fmtZ(Math.min(...src.shops.map((s) => s.price)), { compact: true })}z`);
    if (src?.quests.length) bits.push('quest');
    if (src?.boxes.length) bits.push('box');
    if (src?.src.length) bits.push('other');
    const tr = document.createElement('tr');
    tr.dataset.item = it._id;
    const url = itemIconUrl(it);
    tr.innerHTML = `
      <td>${url ? `<img class="icn" src="${esc(url)}" data-fb="${esc(it.n)}" alt="" loading="lazy">` : `<span class="icn-fb">${esc(it.n.slice(0, 2))}</span>`}</td>
      <td class="left mobname">${esc(it.n)}</td>
      <td class="left dim">${esc(it.t)}${it.sb ? ' / ' + esc(it.sb) : ''}</td>
      <td class="ev">${it.s ? fmtZ(it.s) : '<span class="dim">-</span>'}</td>
      <td class="dim">${it.b ? fmtZ(it.b) : '-'}</td>
      <td class="dim">${fmtWeight(it.w)}</td>
      <td class="left dim">${bits.join(' \u00b7 ')}</td>`;
    tr.addEventListener('click', () => { selectRow(tr); openItem(it._id); });
    frag.appendChild(tr);
  }
  tbody.replaceChildren(frag);
  $('#item-count').textContent = `${list.length} items${list.length > 800 ? ' (first 800 shown)' : ''}`;
}

// ---------- maps view ----------
function renderMaps() {
  const q = (state.cfg.search.maps || '').trim().toLowerCase();
  let list = mapList;
  if (q) list = list.filter((mp) => mp.n.toLowerCase().includes(q) || mp.id.toLowerCase().includes(q));
  list = sortMaps(list);

  const tbody = $('#map-rows');
  const frag = document.createDocumentFragment();
  for (const mp of list) {
    const tr = document.createElement('tr');
    tr.dataset.map = mp.id;
    tr.innerHTML = `
      <td class="left mobname">${esc(mp.n)} <span class="dim">${esc(mp.id)}</span></td>
      <td>${mp.mobCount}</td>
      <td class="ev">${fmtZ(mp.avg)}</td>
      <td class="left">${mp.best ? esc(mp.best.m.n) : '-'}</td>
      <td class="dim">${mp.best ? fmtZ(mp.best.ev.total, { compact: true }) : '-'}</td>`;
    tr.addEventListener('click', () => { selectRow(tr); openMap(mp.id); });
    frag.appendChild(tr);
  }
  tbody.replaceChildren(frag);
  $('#map-count').textContent = `${list.length} maps`;
  const f = state.cfg.filters;
  const cond = [];
  if (f.lvMin != null || f.lvMax != null) cond.push(`lv ${f.lvMin ?? 1}-${f.lvMax ?? 99}`);
  if (f.aggro) cond.push(f.aggro === 'agg' ? 'aggressive' : 'passive');
  if (f.defMin != null || f.defMax != null) cond.push(`DEF ${f.defMin ?? 0}-${f.defMax ?? '∞'}`);
  if (f.mdefMin != null || f.mdefMax != null) cond.push(`MDEF ${f.mdefMin ?? 0}-${f.mdefMax ?? '∞'}`);
  if (f.hitMin != null || f.hitMax != null) cond.push(`HIT ${f.hitMin ?? 0}-${f.hitMax ?? '∞'}`);
  if (f.fleeMin != null || f.fleeMax != null) cond.push(`FLEE ${f.fleeMin ?? 0}-${f.fleeMax ?? '∞'}`);
  if (f.mapExBoss) cond.push('bosses excluded');
  $('#map-note').textContent = 'avg EV/kill = spawn-weighted across qualifying spawns' + (cond.length ? ' · ' + cond.join(' · ') : '');
}

// ---------- csv ----------
function exportCsv() {
  const rows = [['id', 'name', 'lv', 'hp', 'boss', 'ev_per_kill', 'ev_regular', 'ev_mvp', 'ev_special', 'top_drop', 'top_drop_ev', 'maps']];
  for (const m of state.mobs) {
    const ev = evOfMob(m);
    const clsSum = (cls) => m[cls].reduce((s, r) => s + (state.cfg.types.has(state.db.items[r[0]]?.t) ? (r[1] / 10000) * (state.db.items[r[0]]?.s || 0) : 0), 0);
    let top = null;
    for (const r of ev.rows) if (r.included && (!top || r.ev > top.ev)) top = r;
    rows.push([
      m.id, m.n, m.lv, m.hp, m.boss ? 1 : 0,
      ev.total.toFixed(3),
      clsSum('drops').toFixed(3), clsSum('mvp').toFixed(3), clsSum('spc').toFixed(3),
      top ? top.item.n : '', top ? top.ev.toFixed(3) : '',
      m.spawns.map((s) => s.map).join(' '),
    ]);
  }
  const csv = rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? '"' + String(c).replace(/"/g, '""') + '"' : c)).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `rova-mob-ev-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- helpers ----------
function fillDatalist(sel, values) {
  const dl = $(sel);
  dl.innerHTML = values.slice(0, 2000).map((v) => `<option value="${esc(v)}"></option>`).join('');
}
