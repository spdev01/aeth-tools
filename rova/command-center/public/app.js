// app.js — ROVA Command Center dashboard. WS feed with polling fallback; all actions via the local API.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
let state = null;
let logLines = 0;

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
  } catch (e) { toast('API ไม่ตอบสนอง: ' + e.message, true); return {}; }
}

// ---------------- rendering ----------------
function render() {
  if (!state) return;
  $('ver').textContent = 'v' + (state.meta?.version || '—');
  // tor bar
  const tor = state.tor || {};
  const daemons = tor.daemons || {};
  const chip = (el, ok, label) => { el.textContent = label; el.className = 'tor-chip ' + (ok === true ? 'ok' : ok === false ? 'bad' : ''); };
  chip($('tor-d1'), daemons[1]?.listening, `D1 ${daemons[1]?.listening ? 'OK' : 'DOWN'}`);
  chip($('tor-d2'), daemons[2]?.listening, `D2 ${daemons[2]?.listening ? 'OK' : 'DOWN'}`);
  $('tor-ports').textContent = `ports ${tor.info?.ports ?? 0}`;
  // kpis
  const bots = state.bots || [];
  const by = {}; for (const b of bots) { const s = b.runtime?.state || 'stopped'; by[s] = (by[s] || 0) + 1; }
  const parts = [['บอท', bots.length], ['ทำงาน', (by.running || 0) + (by.starting || 0) + (by.restarting || 0)], ['หยุด', by.stopped || 0], ['พัก', by.paused || 0], ['ปัญหา', (by['tor-fail'] || 0) + (by.error || 0)], ['บัญชี', (state.accounts || []).length]];
  $('kpis').innerHTML = parts.map(([k, v]) => `<span class="kpi">${k} <b>${fmt(v)}</b></span>`).join('');
  $('bots-count').textContent = `${bots.length} ตัว`;
  // bots
  const grid = $('bots');
  if (!bots.length) grid.innerHTML = '<div class="muted">ยังไม่มีบอท — กด “+ เพิ่มบอท” (แต่ละตัวจะได้ Tor circuit ของตัวเองทันที)</div>';
  else {
    grid.innerHTML = bots.map((b) => {
      const rt = b.runtime || {};
      const st = b.status || {};
      const stateCls = esc(rt.state || 'stopped');
      const running = ['running', 'starting', 'restarting', 'paused', 'queued', 'tor-fail'].includes(rt.state);
      const canResume = rt.state === 'paused';
      const evt = rt.lastEvt ? `${esc(rt.lastEvt.evt)} ${esc(JSON.stringify(Object.fromEntries(Object.entries(rt.lastEvt).filter(([k]) => k !== 'evt'))))}` : '—';
      const torBadge = st.isTor === true ? '<span class="tor-ok">Tor ✓</span>' : st.isTor === false ? '<span class="tor-bad">Tor ✗</span>' : '';
      return `<div class="bot" data-id="${b.id}">
        <div class="row1"><span class="name">${esc(b.name)}</span><span class="id">#${b.id}</span><span class="spacer"></span><span class="state ${stateCls}">${esc(rt.state || 'stopped')}</span></div>
        <div class="meta">
          <span>mode <b>${esc(b.mode || 'smoke')}</b></span>
          <span>port <b>${st.port ?? '—'}</b></span>
          <span>exit <b>${esc(st.exitIp || '—')}</b> ${torBadge}</span>
          ${rt.restarts ? `<span>restarts <b>${rt.restarts}</b></span>` : ''}
          ${rt.lastExit ? `<span>exit <b>${rt.lastExit.code}</b></span>` : ''}
        </div>
        <div class="evt">${evt}</div>
        <div class="acts">
          ${!running ? `<button class="btn small" data-act="start" data-id="${b.id}">▶ เริ่ม</button>` : ''}
          ${rt.state === 'running' ? `<button class="btn small" data-act="pause" data-id="${b.id}">⏸ พัก</button>` : ''}
          ${canResume ? `<button class="btn small" data-act="resume" data-id="${b.id}">⏵ ต่อ</button>` : ''}
          ${running ? `<button class="btn small" data-act="stop" data-id="${b.id}">⏹ หยุด</button>` : ''}
          <span class="spacer"></span>
          <button class="btn small danger" data-act="delete" data-id="${b.id}">🗑</button>
        </div>
      </div>`;
    }).join('');
  }
  // accounts
  const accs = state.accounts || [];
  $('acc-count').textContent = `${accs.length} บัญชี`;
  $('acc-list').innerHTML = accs.slice(0, 60).map((a) => `<span class="acc"><b>${esc(a.userId)}</b><span class="st ${esc(a.status)}">${esc(a.status)}</span><button class="btn small" data-act="reveal" data-id="${a.id}" title="ดูรหัส">👁</button></span>`).join('') || '<span class="muted">ยังไม่มีบัญชี</span>';
}

function appendLog(e) {
  const el = $('log');
  const evt = e.evt || {};
  const line = document.createElement('div');
  line.className = 'l e-' + esc(evt.evt || '');
  const t = (evt.t || '').slice(11, 19);
  line.innerHTML = `<span class="t">${esc(t)}</span> <b>#${esc(e.botId)}</b> ${esc(evt.evt || '')} ${esc(JSON.stringify(evt.data || {}).slice(0, 220))}`;
  el.appendChild(line);
  while (el.children.length > 500) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
  logLines++;
}

// ---------------- feed ----------------
function connectWs() {
  try {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onmessage = (m) => {
      try {
        const msg = JSON.parse(m.data);
        if (msg.type === 'state') { state = msg.state; render(); }
        else if (msg.type === 'event') appendLog(msg);
      } catch {}
    };
    ws.onclose = () => setTimeout(connectWs, 3000);
  } catch { setTimeout(connectWs, 3000); }
}

// ---------------- actions ----------------
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (btn) {
    const id = btn.dataset.id;
    const act = btn.dataset.act;
    if (act === 'reveal') {
      const r = await api(`/api/accounts/${id}/password`);
      if (r.ok) toast(`รหัสของ ${r.userId}: ${r.password}`);
      return;
    }
    if (act === 'delete' && !confirm(`ลบบอท #${id}? (ประวัติในโฟลเดอร์ยังอยู่)`)) return;
    const r = act === 'delete' ? await api(`/api/bots/${id}/delete`, 'POST') : await api(`/api/bots/${id}/${act}`, 'POST');
    if (r && r.ok === false && r.error) toast(r.error, true);
    return;
  }
});
$('btn-create').onclick = async () => {
  const r = await api('/api/bots/create', 'POST', { count: parseInt($('new-count').value, 10) || 1, mode: 'smoke' });
  if (r.ok) toast(`เพิ่ม ${r.bots.length} บอท (จัดสรร Tor port แล้ว)`);
};
$('btn-start-all').onclick = async () => { const r = await api('/api/bots/start-all', 'POST', { rampMs: 3000 }); if (r.failed?.length) toast('เริ่มไม่สำเร็จบางตัว: ' + r.failed.map((f) => '#' + f.id + ' ' + f.error).join(' | '), true); };
$('btn-stop-all').onclick = async () => { await api('/api/bots/stop-all', 'POST'); toast('สั่งหยุดทั้งหมดแล้ว'); };
$('btn-tor-start').onclick = async () => {
  toast('กำลังเริ่ม tor daemons…');
  const r = await api('/api/tor/start', 'POST');
  const ok = r.d1?.ok && r.d2?.ok;
  toast((ok ? 'Tor พร้อม — ' : 'มีปัญหา: ') + `d1: ${r.d1?.msg || '?'} · d2: ${r.d2?.msg || '?'}`, !ok);
};
$('btn-import').onclick = async () => {
  const r = await api('/api/accounts/import', 'POST', { lines: $('import-lines').value });
  if (r.ok) { toast(`นำเข้า ${r.added.length} บัญชี`); $('import-lines').value = ''; }
};
$('btn-placeholder').onclick = async () => {
  const r = await api('/api/accounts/placeholder', 'POST', { count: parseInt($('ph-count').value, 10) || 1 });
  if (r.ok) toast(`สร้าง ${r.added.length} บัญชี placeholder`);
};
$('btn-clear-log').onclick = () => { $('log').innerHTML = ''; };

connectWs();
setInterval(async () => { if (!state) { state = await api('/api/state'); render(); } }, 5000); // fallback if WS dies
