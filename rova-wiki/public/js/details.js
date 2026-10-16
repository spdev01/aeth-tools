// details.js — slide-in detail drawer for monsters, items and maps.
import {
  state, evOfMob, srcIndex, fmtZ, fmtPct, fmtWeight, fmtRespawn, itemIconUrl, mobImgUrl, esc,
} from './engine.js';

const $ = (s, r = document) => r.querySelector(s);

let current = { kind: null, id: null };

const CLASS_LABEL = { drop: '', mvp: 'MVP', spc: 'SPECIAL' };

export function closeDetail() {
  $('#detail').classList.add('off');
  current = { kind: null, id: null };
}

function open(title, bodyHtml, kind, id) {
  current = { kind, id };
  $('#detail-title').innerHTML = title;
  $('#detail-body').innerHTML = bodyHtml;
  $('#detail').classList.remove('off');
}

function iconImg(item, size = 20) {
  const url = itemIconUrl(item);
  if (!url) return `<span class="icn-fb">${esc(item.n.slice(0, 2))}</span>`;
  return `<img class="icn" style="width:${size}px;height:${size}px" src="${esc(url)}" data-fb="${esc(item.n)}" alt="">`;
}

const scaleLabel = () => (state.cfg.scale === 1 ? 'per kill' : `per ${state.cfg.scale.toLocaleString('en-US')} kills`);

// ---------------- MONSTER ----------------
export function openMob(mobId) {
  const m = state.db.mobs.find((x) => x.id === mobId);
  if (!m) return;
  const ev = evOfMob(m);
  const scale = state.cfg.scale;

  const spawns = m.spawns.length
    ? `<div class="spawn-list">${m.spawns.map((s) => {
        const mp = state.db.maps[s.map];
        return `<div class="row"><span class="link" data-open="map" data-id="${esc(s.map)}">${esc(mp?.n ?? s.map)}</span>
          <span><b>${s.count}</b> spawn${s.count === 1 ? '' : 's'} &middot; <span class="dim">respawn ${fmtRespawn(s.lo, s.hi)}</span></span></div>`;
      }).join('')}</div>`
    : '<p class="note">No natural spawns in the wiki data (summoned, event or special spawn).</p>';

  const maxEv = ev.rows.length ? Math.max(...ev.rows.map((r) => r.ev)) : 1;
  const dropTable = `
    <table class="drops">
      <thead><tr><th class="left">Item</th><th>Chance</th><th>Sell</th><th>EV/kill</th></tr></thead>
      <tbody>${ev.rows.map((r) => {
        const cond = r.cond && r.cond.length
          ? `<div class="dim" style="font-size:11px">only in ${r.cond.map((c) => esc(state.db.maps[c]?.n ?? c)).join(', ')}</div>`
          : '';
        return `<tr class="${r.included ? '' : 'off'}">
          <td class="left"><span class="itemcell">${iconImg(r.item)}<span>
            <span class="link" data-open="item" data-id="${r.itemId}">${esc(r.item.n)}</span>
            ${r.cls !== 'drop' ? `<span class="cls-tag">${CLASS_LABEL[r.cls]}</span>` : ''}
            ${cond}</span></span>
            <div class="bar"><i style="width:${maxEv ? Math.round((r.ev / maxEv) * 100) : 0}%"></i></div></td>
          <td>${fmtPct(r.chance)}</td>
          <td>${r.item.s ? fmtZ(r.item.s) : '<span class="dim">0</span>'}</td>
          <td class="ev">${fmtZ(r.ev)}</td>
        </tr>`;
      }).join('')}
      </tbody>
    </table>`;

  const body = `
    <div class="ev-total">
      ${(() => { const u = mobImgUrl(m); return u ? `<img class="mobimg big" src="${esc(u)}" data-fb="${esc(m.n)}" alt="">` : ''; })()}
      <span class="big">${fmtZ(ev.total * scale, { compact: scale > 1 })}z</span>
      <span class="dim">${scaleLabel()} &middot; ${ev.included} of ${ev.rows.length} drops counted</span>
    </div>
    ${ev.excluded ? `<p class="note warn">${ev.excluded} drop row(s) are excluded by the current category / class toggles (dimmed below).</p>` : ''}
    <h4>Stats</h4>
    <div class="stat-grid">
      <div><div class="k">Level</div><div class="v">${m.lv}</div></div>
      <div><div class="k">HP</div><div class="v">${m.hp.toLocaleString('en-US')}</div></div>
      <div><div class="k">Element</div><div class="v"><span class="badge el-${esc(m.el)}">${esc(m.el)}${m.ell ? ' ' + m.ell : ''}</span></div></div>
      <div><div class="k">Race</div><div class="v">${esc(m.race)}</div></div>
      <div><div class="k">Size</div><div class="v">${esc(m.size)}</div></div>
      <div><div class="k">Aggressive</div><div class="v">${m.ag ? 'yes' : 'no'}</div></div>
      <div><div class="k">Boss</div><div class="v">${m.boss ? 'yes' : 'no'}</div></div>
      <div><div class="k">ATK</div><div class="v">${Array.isArray(m.atk) ? m.atk[0] + '-' + m.atk[1] : m.atk}</div></div>
      <div><div class="k">DEF / MDEF</div><div class="v">${m.def} / ${m.mdef}</div></div>
      <div><div class="k">HIT / FLEE</div><div class="v">${m.hit} / ${m.flee}</div></div>
      <div><div class="k">EXP (base/job)</div><div class="v">${m.bexp} / ${m.jexp}</div></div>
      ${m.mvpexp ? `<div><div class="k">MVP EXP</div><div class="v">${m.mvpexp}</div></div>` : ''}
      <div><div class="k">Wiki ID</div><div class="v dim">${esc(m.id)}</div></div>
    </div>
    <h4>Spawns</h4>
    ${spawns}
    <h4>Drop table ${ev.rows.length ? '' : '<span class="dim">(nothing)</span>'}</h4>
    ${ev.rows.length ? dropTable : '<p class="note">This monster has no drops in the wiki data.</p>'}`;

  open(`${esc(m.n)}${m.boss ? ' <span class="boss" style="color:var(--gold)">&#9733;</span>' : ''} <span class="dim" style="font-size:12px">Lv ${m.lv}</span>`, body, 'mob', mobId);
}

// ---------------- ITEM ----------------
export function openItem(itemId) {
  const it = state.db.items[itemId];
  if (!it) return;
  const rec = srcIndex()[itemId];

  const stats = [
    ['Sell', it.s ? fmtZ(it.s) + 'z' : '-'],
    ['Buy', it.b ? fmtZ(it.b) + 'z' : '-'],
    ['Weight', fmtWeight(it.w)],
    ['Type', esc(it.t) + (it.sb ? ' / ' + esc(it.sb) : '')],
  ];
  if (it.atk) stats.push(['ATK', it.atk]);
  if (it.ma) stats.push(['MATK', it.ma]);
  if (it.def) stats.push(['DEF', it.def]);
  if (it.rng) stats.push(['Range', it.rng]);
  if (it.sl) stats.push(['Slots', it.sl]);
  if (it.wlv) stats.push(['Weapon Lv', it.wlv]);
  if (it.elv) stats.push(['Equip Lv', it.elv]);

  const flags = [];
  if (it.ns) flags.push('NoSell');
  if (it.nd) flags.push('NoDrop');
  if (it.nt) flags.push('NoTrade');

  const factBits = [];
  if (it.f?.heal) factBits.push(`Heals ${it.f.heal[0]}–${it.f.heal[1]} HP`);
  if (it.f?.cat) factBits.push(`Class: ${it.f.cat.join(', ')}`);

  const droppedBy = rec?.droppedBy?.length
    ? `<table class="drops"><thead><tr><th class="left">Monster</th><th>Lv</th><th>Class</th><th>Chance</th><th>EV/kill</th></tr></thead><tbody>
      ${rec.droppedBy.map((d) => {
        const ok = state.cfg.classes[d.cls] && state.cfg.types.has(it.t);
        return `<tr class="${ok ? '' : 'off'}">
          <td class="left"><span class="link" data-open="mob" data-id="${esc(d.mob.id)}">${esc(d.mob.n)}</span></td>
          <td>${d.mob.lv}</td>
          <td>${CLASS_LABEL[d.cls] || 'drop'}</td>
          <td>${fmtPct(d.chance)}</td>
          <td class="ev">${fmtZ((d.chance / 10000) * (it.s || 0))}</td>
        </tr>`;
      }).join('')}
    </tbody></table>`
    : '<p class="note">No monster drops this item.</p>';

  const shops = rec?.shops?.length
    ? `<div class="spawn-list">${rec.shops.map((s) =>
        `<div class="row"><span><b>${fmtZ(s.price)}z</b> <span class="dim">(${esc(s.shopId.replace(/_/g, ' '))})</span></span>
         <span class="dim">${s.npcs.slice(0, 3).map(([, , n]) => esc(n)).join(', ')}${s.npcs.length > 3 ? ' +' + (s.npcs.length - 3) : ''}</span></div>`).join('')}</div>`
    : '';

  const quests = rec?.quests?.length
    ? `<div class="spawn-list">${rec.quests.map((q) =>
        `<div class="row"><span>${esc(q.quest.n)}</span><span class="dim">x${q.qty} \u00b7 ${esc(q.quest.k)} lv${q.quest.lv}</span></div>`).join('')}</div>`
    : '';

  const boxes = rec?.boxes?.length
    ? `<div class="spawn-list">${rec.boxes.map((b) => {
        const box = state.db.items[b.boxId];
        return `<div class="row"><span>${box ? `<span class="link" data-open="item" data-id="${b.boxId}">${esc(box.n)}</span>` : b.boxId}</span><span class="dim">${fmtPct(b.chance)}${b.qty ? ' \u00d7' + b.qty : ''}</span></div>`;
      }).join('')}</div>`
    : '';

  const otherSrc = [];
  for (const s of rec?.src ?? []) {
    const tag = String(s.entry[0]);
    if (tag === 'box') continue; // already listed under "From boxes" (box item + chance)
    if (tag === 'fishing') otherSrc.push('Caught by fishing');
    else if (tag === 'collect') otherSrc.push('Collection reward');
    else otherSrc.push(esc(tag.replace(/_/g, ' ')));
  }
  // card -> monster
  let cardMob = '';
  if (it.t === 'Card' && state.db.cardmob[itemId]) {
    cardMob = state.db.cardmob[itemId].map((id) => {
      const m = state.db.mobs.find((x) => x.id === id);
      return m ? `<span class="link" data-open="mob" data-id="${esc(id)}">${esc(m.n)}</span>` : esc(id);
    }).join(', ');
  }

  const body = `
    <h4>Item</h4>
    <div class="ev-total">
      ${iconImg(it, 40)}
      <span class="big">${it.s ? fmtZ(it.s) + 'z' : '<span class="dim">no sell</span>'}</span>
      <span class="dim">NPC sell value &middot; id ${itemId}</span>
    </div>
    <div class="stat-grid">
      ${stats.map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}
    </div>
    ${flags.length ? `<p class="note warn">${flags.join(' \u00b7 ')}</p>` : ''}
    ${factBits.length ? `<p class="note">${factBits.join(' \u00b7 ')}</p>` : ''}
    ${cardMob ? `<p class="note">Card of: ${cardMob}</p>` : ''}
    <h4>Dropped by</h4>
    ${droppedBy}
    ${shops ? `<h4>Sold at</h4>${shops}` : ''}
    ${quests ? `<h4>Quest rewards</h4>${quests}` : ''}
    ${boxes ? `<h4>From boxes</h4>${boxes}` : ''}
    ${otherSrc.length ? `<h4>Other sources</h4><p class="note">${otherSrc.join(' \u00b7 ')}</p>` : ''}
  `;
  open(esc(it.n), body, 'item', itemId);
}

// ---------------- MAP ----------------
export function openMap(mapId) {
  const mp = state.db.maps[mapId];
  if (!mp) return;
  const rows = mp.spawns.map(([mobId, count, lo, hi]) => {
    const m = state.db.mobs.find((x) => x.id === mobId);
    if (!m) return null;
    const ev = evOfMob(m);
    return `<tr>
      <td class="left"><span class="link" data-open="mob" data-id="${esc(mobId)}">${esc(m.n)}</span>${m.boss ? ' <span style="color:var(--gold)">&#9733;</span>' : ''}</td>
      <td>${count}</td>
      <td class="dim">${fmtRespawn(lo, hi)}</td>
      <td class="ev">${fmtZ(ev.total)}</td>
    </tr>`;
  }).filter(Boolean).join('');

  const body = `
    <p class="note">Number = spawns on this map; EV column uses the current toggles.</p>
    <h4>Monsters (${mp.spawns.length})</h4>
    <table class="drops"><thead><tr><th class="left">Monster</th><th>Spawns</th><th>Respawn</th><th>EV/kill</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
  open(`${esc(mp.n)} <span class="dim" style="font-size:12px">${esc(mapId)}</span>`, body, 'map', mapId);
}

// ---------------- navigation ----------------
document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-open]');
  if (!link) return;
  const kind = link.dataset.open;
  const id = link.dataset.id;
  if (kind === 'item') openItem(Number(id));
  else if (kind === 'mob') openMob(id);
  else if (kind === 'map') openMap(id);
});
