// Aetheria Earnings Overlay — content script (MV3).
// A tiny draggable panel on the game page; every number comes from the local Command Center via the
// background service worker (bg.js). No dependencies, no MutationObservers, no timers while collapsed.
(() => {
  'use strict';
  if (window.__axEarnLoaded) return;
  window.__axEarnLoaded = true;
  const HOST_ID = 'ax-earn-host';
  if (document.getElementById(HOST_ID)) return;

  // ---------- helpers ----------
  const fmtC = (n) => {
    n = Math.round(Number(n) || 0);
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e8 ? 0 : 2) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'k';
    return String(n);
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const send = (msg) =>
    new Promise((res) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          const err = chrome.runtime.lastError;
          res(err ? { ok: false, error: err.message } : r || { ok: false, error: 'no response' });
        });
      } catch (e) {
        res({ ok: false, error: String(e) });
      }
    });
  const niceStep = (x) => {
    const p = Math.pow(10, Math.floor(Math.log10(Math.max(x, 1))));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= x) return m * p;
    return 10 * p;
  };

  // ---------- UI ----------
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;top:64px;right:14px;z-index:2147483647;';
  const sr = host.attachShadow({ mode: 'open' });
  sr.innerHTML = `
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; font: 12px/1.35 system-ui, "Segoe UI", sans-serif; }
      .panel { width: 272px; background: rgba(13,16,22,.93); border: 1px solid #2b3342; border-radius: 10px;
               padding: 7px 9px 5px; color: #d7dee8; box-shadow: 0 6px 22px rgba(0,0,0,.45); user-select: none; }
      .hd { display: flex; align-items: center; gap: 4px; cursor: move; margin-bottom: 6px; touch-action: none; }
      .ttl { font-weight: 600; color: #e8eef6; }
      .grip { color: #67748a; cursor: grab; font-size: 13px; line-height: 1; }
      .hd .grow { flex: 1; }
      .ico { border: 0; background: #1c2330; color: #9fb0c5; border-radius: 6px; width: 20px; height: 18px;
             line-height: 18px; cursor: pointer; font-size: 12px; padding: 0; }
      .ico:hover { background: #2a3548; color: #e8eef6; }
      .kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 8px; margin-bottom: 6px; }
      .kpi { display: flex; justify-content: space-between; background: #161c27; border-radius: 6px; padding: 2px 6px; }
      .kpi i { color: #7c8ba1; font-style: normal; }
      .kpi b { color: #cfe3ff; font-weight: 600; }
      .row { display: flex; align-items: center; gap: 5px; margin-bottom: 4px; }
      select { flex: 1; min-width: 0; background: #1c2330; color: #d7dee8; border: 1px solid #2b3342; border-radius: 6px;
               font-size: 11px; padding: 2px 4px; outline: none; }
      .rg { border: 1px solid #2b3342; background: #1c2330; color: #9fb0c5; border-radius: 6px; padding: 2px 6px;
            cursor: pointer; font-size: 11px; }
      .rg.on { background: #24405e; color: #cfe3ff; border-color: #35608f; }
      .chart { padding: 2px 0; }
      .ft { display: flex; justify-content: space-between; align-items: center; margin-top: 3px; color: #67748a; font-size: 10px; }
      .ft a { color: #7fa8e0; text-decoration: none; font-size: 10px; }
      .ft .bad { color: #ff9f6e; }
      .ico2 { border: 0; background: #1c2330; color: #9fb0c5; border-radius: 5px; padding: 1px 6px; margin-left: 4px; cursor: pointer; font-size: 11px; }
      .ico2:hover { background: #2a3548; color: #e8eef6; }
      .ico2.warn { background: #5a2418; color: #ffc9a8; }
      .pill { display: inline-block; background: rgba(13,16,22,.93); border: 1px solid #2b3342;
              border-radius: 999px; padding: 4px 12px; color: #cfe3ff; cursor: move; box-shadow: 0 4px 14px rgba(0,0,0,.4); touch-action: none; }
      .pill b { color: #9fe3b8; font-weight: 600; }
    </style>
    <div class="pill" data-act="expand" hidden>💰 <b class="pill-rate">—</b>/h</div>
    <div class="panel">
      <div class="hd" id="hd" title="Drag to move">
        <span class="grip">⠿</span><span class="ttl">💰 Earnings</span><span class="grow"></span>
        <button class="ico" data-act="ref" title="Refresh now">↻</button>
        <button class="ico" data-act="min" title="Collapse">–</button>
      </div>
      <div class="kpis">
        <div class="kpi"><i>3h ≈/h</i><b id="k3">—</b></div>
        <div class="kpi"><i>24h ≈/h</i><b id="k24">—</b></div>
        <div class="kpi"><i>last h</i><b id="kL">—</b></div>
        <div class="kpi"><i>kills/h</i><b id="kK">—</b></div>
      </div>
      <div class="row">
        <select id="botsel" title="Bot to chart"><option value="">loading…</option></select>
        <button class="rg" data-hours="6">6h</button>
        <button class="rg" data-hours="12">12h</button>
        <button class="rg" data-hours="24">24h</button>
      </div>
      <div class="chart" id="chart"></div>
      <div class="ft"><span id="upd">starting…</span><span class="sctls" id="sctls" hidden><button class="ico2" id="btnPause" title="Pause / resume capture">⏸</button><button class="ico2" id="btnClear" title="Clear captured history">🗑</button></span><a id="cclink" href="http://127.0.0.1:4310" target="_blank" rel="noreferrer">dashboard ↗</a></div>
    </div>`;

  const srGet = (id) => sr.getElementById(id);
  const panel = sr.querySelector('.panel');
  const pill = sr.querySelector('.pill');
  const elK3 = srGet('k3');
  const elK24 = srGet('k24');
  const elKL = srGet('kL');
  const elKK = srGet('kK');
  const elUpd = srGet('upd');
  const elChart = srGet('chart');
  const elSel = srGet('botsel');
  const elHd = srGet('hd');
  const elPillRate = sr.querySelector('.pill-rate');
  const elSctls = srGet('sctls');
  const elPause = srGet('btnPause');
  const elClear = srGet('btnClear');
  const elCclink = srGet('cclink');

  // ---------- state ----------
  let bots = [];
  let sel = null;
  let hours = 12;
  let ccOk = false;
  let collapsed = false;
  let userSet = false;
  let trackTries = 0;
  let ticks = 0;
  let timer = null;
  let lastDragEnd = 0;

  (document.body || document.documentElement).appendChild(host);

  // capture-phase click handling so the game never sees our interactions
  sr.addEventListener(
    'click',
    (e) => {
      // a click right after a drag is the drag's tail — swallow it (stops the pill from expanding on drop)
      if (Date.now() - lastDragEnd < 300) { e.stopPropagation(); e.preventDefault(); return; }
      const t = e.composedPath().find((n) => n instanceof Element && n.dataset && (n.dataset.act || n.dataset.hours));
      if (!t) return;
      e.stopPropagation();
      e.preventDefault();
      const act = t.dataset.act;
      if (act === 'expand') setCollapsed(false, true);
      else if (act === 'min') setCollapsed(true, true);
      else if (act === 'ref') tick();
      else if (t.dataset.hours) {
        hours = parseInt(t.dataset.hours, 10) || 12;
        try { chrome.storage.local.set({ axHours: hours }); } catch {}
        for (const b of sr.querySelectorAll('[data-hours]')) b.classList.toggle('on', parseInt(b.dataset.hours, 10) === hours);
        refresh();
      }
    },
    true,
  );

  elSel.addEventListener('change', () => {
    sel = elSel.value === 'session' ? 'session' : parseInt(elSel.value, 10) || null;
    userSet = true;
    try { chrome.storage.local.set({ axSel: sel, axUserSet: true }); } catch {}
    refresh();
  });

  // ---- session-mode controls (pause / clear) + live refresh ----
  elPause.addEventListener('click', () => {
    const S = window.__axSession;
    if (!S) return;
    const p = !S.isPaused();
    S.setPaused(p);
    elPause.textContent = p ? '▶' : '⏸';
    elPause.classList.toggle('warn', p);
    note(p ? 'capture paused — resume with ▶' : 'capture resumed');
    if (!p) refresh();
  });
  let clearArm = 0;
  elClear.addEventListener('click', () => {
    const S = window.__axSession;
    if (!S) return;
    if (Date.now() - clearArm > 2500) {
      clearArm = Date.now();
      elClear.textContent = 'sure?';
      elClear.classList.add('warn');
      setTimeout(() => {
        if (Date.now() - clearArm >= 2400) {
          elClear.textContent = '🗑';
          elClear.classList.remove('warn');
        }
      }, 2700);
      return;
    }
    clearArm = 0;
    elClear.textContent = '🗑';
    elClear.classList.remove('warn');
    S.clear();
    note('history cleared');
    refresh();
  });
  let lastAutoRefresh = 0;
  window.addEventListener('ax-session-changed', () => {
    if (!userSet && sel !== 'session') {
      // a live session just appeared (login/join) — switch to it automatically
      const S = window.__axSession;
      try {
        const idn = S ? S.identity() : null;
        if (S && idn && (idn.characterId || idn.zeny != null)) {
          sel = 'session';
          renderBotOptions();
          if (!collapsed) refresh();
          return;
        }
      } catch {}
    }
    if (sel !== 'session' || collapsed) return;
    const now = Date.now();
    if (now - lastAutoRefresh < 15000) return;
    lastAutoRefresh = now;
    refresh();
  });

  // ---------- drag (header + collapsed pill) ----------
  // Window-level pointer listeners during a drag — NOT setPointerCapture on the shadow-DOM header.
  // The capture path is unreliable in Firefox/Zen (moves only register while the cursor stays over the
  // header strip → the panel feels stuck), while window listeners behave identically in every browser.
  function startDrag(e, skipActs) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (skipActs && e.composedPath().some((n) => n instanceof Element && n.dataset && n.dataset.act)) return;
    e.stopPropagation();
    e.preventDefault();
    const r = host.getBoundingClientRect();
    const st = { x: e.clientX, y: e.clientY, l: r.left, t: r.top, moved: false };
    host.style.right = 'auto';
    host.style.left = r.left + 'px';
    host.style.top = r.top + 'px';
    const onMove = (ev) => {
      const dx = ev.clientX - st.x;
      const dy = ev.clientY - st.y;
      if (!st.moved && Math.abs(dx) + Math.abs(dy) > 3) st.moved = true;
      if (!st.moved) return;
      ev.stopPropagation();
      host.style.left = Math.max(0, Math.min(innerWidth - 60, st.l + dx)) + 'px';
      host.style.top = Math.max(0, Math.min(innerHeight - 30, st.t + dy)) + 'px';
    };
    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      if (ev) ev.stopPropagation();
      if (st.moved) {
        lastDragEnd = Date.now();
        const rr = host.getBoundingClientRect();
        try { chrome.storage.local.set({ axPos: { l: Math.round(rr.left), t: Math.round(rr.top) } }); } catch {}
      }
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
  }
  elHd.addEventListener('pointerdown', (e) => startDrag(e, true));
  pill.addEventListener('pointerdown', (e) => startDrag(e, false));
  // block the game from stealing pointer/scroll events aimed at the panel
  for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'click', 'wheel', 'contextmenu']) {
    host.addEventListener(ev, (e) => e.stopPropagation(), false);
  }

  // ---------- chart ----------
  function chartSvg(hs) {
    const W = 254, H = 92, PL = 34, PR = 4, PT = 6, PB = 16;
    const iw = W - PL - PR;
    const ih = H - PT - PB;
    const n = hs.length || 1;
    const max = Math.max(1, ...hs.map((x) => Math.max(x.v || 0, x.e || 0)));
    const step = niceStep(max / 2.4);
    const top = Math.max(step, Math.ceil(max / step) * step);
    const bw = iw / n;
    let s = '';
    for (const g of [0, 0.5, 1]) {
      const y = PT + ih - g * ih;
      s +=
        `<line x1="${PL}" y1="${y.toFixed(1)}" x2="${W - PR}" y2="${y.toFixed(1)}" stroke="#232b38" stroke-width="1"/>` +
        `<text x="${PL - 4}" y="${(y + 3).toFixed(1)}" text-anchor="end" fill="#66707f">${g === 0 ? '0' : fmtC(top * g)}</text>`;
    }
    const every = Math.max(1, Math.ceil(n / 6));
    for (let i = 0; i < n; i++) {
      const x = PL + i * bw;
      const x0 = x + bw * 0.1;
      const w = bw * 0.36;
      const h = hs[i];
      const vh = ((h.v || 0) / top) * ih;
      const eh = ((h.e || 0) / top) * ih;
      const lbl = String(h.h || '').slice(11);
      const tip = `${lbl}:00 — est ${fmtC(h.v)} · earned ${fmtC(h.e)} · ${h.k || 0} kills · ${h.q || 0} drops`;
      s += `<g><title>${esc(tip)}</title>`;
      s += `<rect x="${x0.toFixed(1)}" y="${(PT + ih - vh).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(vh, 0).toFixed(1)}" rx="1.5" fill="#3fae6f"/>`;
      s += `<rect x="${(x0 + w + 1.5).toFixed(1)}" y="${(PT + ih - eh).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(eh, 0).toFixed(1)}" rx="1.5" fill="#4c8bf5"/>`;
      if (i % every === 0 || i === n - 1) {
        s += `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 4}" text-anchor="middle" fill="#66707f">${lbl}</text>`;
      }
      s += '</g>';
    }
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${s}</svg>`;
  }

  // ---------- data ----------
  function note(txt, bad) {
    elUpd.textContent = txt;
    elUpd.className = bad ? 'bad' : '';
  }

  async function loadBots() {
    const r = await send({ type: 'bots' });
    if (!r.ok) {
      ccOk = false;
      elCclink.hidden = true;
      if (!userSet) sel = 'session';
      renderBotOptions();
      return false;
    }
    ccOk = true;
    elCclink.hidden = false;
    bots = r.data || [];
    if (sel !== 'session' && !(sel != null && bots.some((b) => b.id === sel))) {
      // a live game session on this page IS the capture — default to it, no picking needed
      const S = window.__axSession;
      let live = false;
      try {
        const idn = S ? S.identity() : null;
        live = !!(S && idn && (idn.characterId || idn.zeny != null));
      } catch {}
      sel = !userSet && live ? 'session' : bots[0] ? bots[0].id : null;
    }
    renderBotOptions();
    return true;
  }

  const sessName = () => {
    try {
      const s = window.__axSession && window.__axSession.identity();
      return (s && s.name) || null;
    } catch {
      return null;
    }
  };

  function renderBotOptions() {
    elSel.textContent = '';
    const so = document.createElement('option');
    so.value = 'session';
    so.textContent = '🌟 this session' + (sessName() ? ' · ' + sessName() : '');
    if (sel === 'session') so.selected = true;
    elSel.appendChild(so);
    for (const b of bots) {
      const o = document.createElement('option');
      o.value = String(b.id);
      o.textContent = b.name;
      if (sel === b.id) o.selected = true;
      elSel.appendChild(o);
    }
  }

  async function refresh() {
    if (sel === 'session') return refreshSession();
    if (sel == null) {
      await loadBots();
      if (sel === 'session') return refreshSession();
      if (sel == null) return;
    }
    const r = await send({ type: 'earn', botId: sel, hours });
    if (!r.ok) {
      note('⚠ CC offline — ' + r.error, true);
      return;
    }
    elSctls.hidden = true;
    renderData(r.data || {}, (bots.find((b) => b.id === sel) || {}).name || '#' + sel);
  }

  async function refreshSession() {
    const S = window.__axSession;
    if (!S) {
      note('waiting for a game session — log in to the game');
      return;
    }
    const idn = S.identity();
    let lbl = 'live · ' + (idn.name || 'this session');
    if (!idn.name && idn.characterId == null) {
      lbl = idn.hookReady === false
        ? 'waiting for login — capture hook missing; press F5'
        : idn.hookLate
          ? 'waiting for login — add-on loaded after the game; press F5 once'
          : 'waiting for login — already in the game? press F5';
    }
    renderData(S.getDetail(hours), lbl);
    elSctls.hidden = false;
    elPause.textContent = S.isPaused() ? '▶' : '⏸';
    elPause.classList.toggle('warn', S.isPaused());
  }

  function renderData(d, label) {
    const hs = Array.isArray(d.hours) ? d.hours : [];
    elK3.textContent = (d.rate3 != null ? fmtC(d.rate3) : '—') + '/h';
    elK24.textContent = (d.rate24 != null ? fmtC(d.rate24) : '—') + '/h';
    let act = null;
    for (let i = hs.length - 1; i >= 0; i--) {
      const x = hs[i];
      if ((x.v || 0) + (x.e || 0) > 0) {
        act = x;
        break;
      }
    }
    elKL.textContent = act ? fmtC(act.v) : '—';
    elKK.textContent = act ? String(act.k || 0) : '—';
    elChart.innerHTML = hs.length ? chartSvg(hs) : '<div style="padding:10px;color:#67748a">no data yet</div>';
    elPillRate.textContent = d.rate3 != null ? fmtC(d.rate3) : '—';
    note('updated ' + new Date().toLocaleTimeString() + ' · ' + label);
  }

  // ---------- lifecycle ----------
  function startTimer() {
    if (!timer) timer = setInterval(tick, 60000);
  }
  function stopTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }
  async function tick() {
    if (host.isConnected === false) {
      try { (document.body || document.documentElement).appendChild(host); } catch {}
    }
    ticks++;
    if (ticks % 8 === 1) await loadBots(); // bot list refresh every ~8 min
    await refresh();
  }
  function setCollapsed(v, persist) {
    collapsed = v;
    if (persist) { try { chrome.storage.local.set({ axCollapsed: v }); } catch {} }
    panel.hidden = collapsed;
    pill.hidden = !collapsed;
    if (collapsed) stopTimer();
    else {
      startTimer();
      tick();
    }
  }

  (async () => {
    let st = {};
    try {
      st = await chrome.storage.local.get({ axSel: null, axHours: 12, axCollapsed: false, axPos: null, axUserSet: false });
    } catch {}
    sel = st.axSel === 'session' ? 'session' : Number.isFinite(st.axSel) ? st.axSel : null;
    hours = [6, 12, 24].indexOf(st.axHours) >= 0 ? st.axHours : 12;
    userSet = !!st.axUserSet;
    if (st.axPos && Number.isFinite(st.axPos.l) && Number.isFinite(st.axPos.t)) {
      host.style.left = st.axPos.l + 'px';
      host.style.top = st.axPos.t + 'px';
      host.style.right = 'auto';
    }
    for (const b of sr.querySelectorAll('[data-hours]')) b.classList.toggle('on', parseInt(b.dataset.hours, 10) === hours);
    setCollapsed(!!st.axCollapsed, false);
  })();

  chrome.runtime.onMessage.addListener((m) => {
    if (m && m.type === 'toggle') setCollapsed(!collapsed, true);
  });
})();
