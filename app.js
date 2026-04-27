'use strict';

/* ============================================================
   CATEGORIES
   ============================================================ */
const CATEGORIES = [
  { id: '1',   num: '1',   label: 'DC入荷',              color: '#1d4ed8' },
  { id: '2',   num: '2',   label: 'デバン',               color: '#0369a1' },
  { id: '3-1', num: '3-1', label: 'DC出荷\nケースピック',  color: '#15803d' },
  { id: '3-2', num: '3-2', label: 'DC出荷\nバラピック',    color: '#166534' },
  { id: '3-3', num: '3-3', label: 'DC出荷\nケース店分',    color: '#065f46' },
  { id: '3-4', num: '3-4', label: 'DC出荷\n種まき',        color: '#047857' },
  { id: '3-5', num: '3-5', label: 'DC出荷\nその他',        color: '#0f766e' },
  { id: '4',   num: '4',   label: 'TC入荷',               color: '#b45309' },
  { id: '5',   num: '5',   label: 'TC出荷',               color: '#92400e' },
  { id: '6',   num: '6',   label: 'FOパレット搬送',        color: '#7c3aed' },
  { id: '7',   num: '7',   label: '配車\nスキャン・ラップ', color: '#6d28d9' },
  { id: '8',   num: '8',   label: '配車（出庫）',          color: '#5b21b6' },
  { id: '9',   num: '9',   label: 'ロケ変',               color: '#be185d' },
  { id: '10',  num: '10',  label: '入庫',                 color: '#9f1239' },
  { id: '11',  num: '11',  label: '棚卸',                 color: '#334155' },
  { id: '12',  num: '12',  label: '翌日準備',             color: '#475569' },
  { id: '13',  num: '13',  label: '清掃',                 color: '#4d7c0f' },
  { id: '14',  num: '14',  label: 'TCエラー処理',          color: '#c2410c' },
  { id: '15',  num: '15',  label: '事務作業',             color: '#4338ca' },
  { id: '16',  num: '16',  label: '休憩',                 color: '#6b7280' },
  { id: '17',  num: '17',  label: 'その他',               color: '#78716c' },
];

const CAT_BY_ID = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

/* ============================================================
   STATE
   ============================================================ */
let sessions = [];        // completed sessions
let session  = null;      // in-progress session
let clockTid = null;      // setInterval id for clock/elapsed
let pendingSlot = null;   // { slotStart, slotEnd } being edited

/* ============================================================
   PERSISTENCE
   ============================================================ */
function persist() {
  try {
    localStorage.setItem('lr_sessions', JSON.stringify(sessions));
    if (session) {
      localStorage.setItem('lr_current', JSON.stringify(session));
    } else {
      localStorage.removeItem('lr_current');
    }
  } catch (_) {}
}

function hydrate() {
  try {
    const s = localStorage.getItem('lr_sessions');
    if (s) sessions = JSON.parse(s);
  } catch (_) { sessions = []; }

  try {
    const c = localStorage.getItem('lr_current');
    if (c) session = JSON.parse(c);
  } catch (_) { session = null; }
}

/* ============================================================
   TIME HELPERS
   ============================================================ */
const pad = n => String(n).padStart(2, '0');

function hhmm(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function hhmmss() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtDur(ms) {
  if (ms < 0) ms = 0;
  const tot = Math.round(ms / 60000);
  const h = Math.floor(tot / 60), m = tot % 60;
  if (h === 0) return `${m}分`;
  if (m === 0) return `${h}時間`;
  return `${h}時間${m}分`;
}

function fmtDate(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const dow = ['日','月','火','水','木','金','土'][new Date(y, mo-1, d).getDay()];
  return `${mo}月${d}日（${dow}）`;
}

function floorTo15(ts) {
  return ts - (ts % (15 * 60000));
}

/* ============================================================
   SLOT COMPUTATION
   ============================================================ */
function buildSlots(sess) {
  const endTs    = sess.endTs || Date.now();
  const startSlot = floorTo15(sess.startTs);
  let   endSlot   = floorTo15(endTs);
  if (endTs % (15 * 60000) > 0) endSlot += 15 * 60000;

  const slots = [];
  for (let t = startSlot; t < endSlot; t += 15 * 60000) {
    const mid = t + 7.5 * 60000;
    let catId = null;
    for (const e of sess.entries) {
      const es = e.startTs;
      const ee = e.endTs || Date.now();
      if (es <= mid && mid < ee) { catId = e.categoryId; break; }
    }
    slots.push({ slotStart: t, slotEnd: t + 15 * 60000, categoryId: catId });
  }
  return slots;
}

function summarise(slots) {
  const map = {};
  for (const s of slots) {
    if (!s.categoryId) continue;
    map[s.categoryId] = (map[s.categoryId] || 0) + 15;
  }
  return map; // catId -> minutes
}

/* ============================================================
   SHIFT CONTROL
   ============================================================ */
function startShift(name, dateStr, timeStr) {
  const [h, m]     = timeStr.split(':').map(Number);
  const [y, mo, d] = dateStr.split('-').map(Number);
  const startTs    = new Date(y, mo-1, d, h, m, 0, 0).getTime();

  session = { id: String(Date.now()), workerName: name, date: dateStr,
              startTs, endTs: null, entries: [] };
  persist();
}

function tapCategory(catId) {
  if (!session) return;
  const now = Date.now();

  if (session.entries.length > 0) {
    const last = session.entries[session.entries.length - 1];
    if (last.categoryId === catId) return; // same cat — ignore
    if (!last.endTs) last.endTs = now;
  }

  session.entries.push({ categoryId: catId, startTs: now, endTs: null });
  persist();
  refreshCurrentTask();
  refreshCategoryGrid();
  showToast(`${CAT_BY_ID[catId].label.replace('\n', ' ')} を開始`);
}

function finishShift() {
  if (!session) return;
  const now = Date.now();
  session.endTs = now;
  if (session.entries.length > 0) {
    const last = session.entries[session.entries.length - 1];
    if (!last.endTs) last.endTs = now;
  }
  sessions.push(session);
  session = null;
  persist();
}

/* ============================================================
   SLOT EDITING
   ============================================================ */
function applySlotEdit(catId) {
  if (!session || !pendingSlot) return;
  const { slotStart, slotEnd } = pendingSlot;
  rebuildWithSlot(slotStart, slotEnd, catId || null);
  persist();
  closeModal();
  renderTimeline();
  refreshCategoryGrid();
  refreshCurrentTask();
}

function rebuildWithSlot(slotStart, slotEnd, newCatId) {
  const now     = Date.now();
  const entries = session.entries;
  const rebuilt = [];

  for (const e of entries) {
    const es = e.startTs;
    const ee = e.endTs ?? now;

    if (ee <= slotStart || es >= slotEnd) {
      rebuilt.push({ ...e });
      continue;
    }
    // Before slot
    if (es < slotStart) rebuilt.push({ ...e, endTs: slotStart });
    // After slot
    if (ee > slotEnd)   rebuilt.push({ ...e, startTs: slotEnd });
    // Within slot: dropped, replaced below
  }

  if (newCatId) {
    const isCurrentSlot = slotEnd > now - 5000;
    rebuilt.push({
      categoryId: newCatId,
      startTs: slotStart,
      endTs: isCurrentSlot ? null : slotEnd,
    });
  }

  // Sort by startTs
  rebuilt.sort((a, b) => a.startTs - b.startTs);

  // Merge consecutive same-category entries
  const merged = [];
  for (const e of rebuilt) {
    if (merged.length > 0) {
      const prev = merged[merged.length - 1];
      if (prev.categoryId === e.categoryId && prev.endTs === e.startTs) {
        prev.endTs = e.endTs; continue;
      }
    }
    merged.push({ ...e });
  }

  session.entries = merged;
}

/* ============================================================
   SCREEN NAVIGATION
   ============================================================ */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

/* ============================================================
   RENDER: CATEGORY GRID
   ============================================================ */
function refreshCategoryGrid() {
  const grid = document.getElementById('category-grid');
  const activeCatId = session && session.entries.length > 0
    ? session.entries[session.entries.length - 1].categoryId : null;

  grid.innerHTML = CATEGORIES.map(cat => {
    const isActive = cat.id === activeCatId;
    const label    = cat.label.replace('\n', '<br>');
    const numBg    = cat.color + '22';
    return `
      <button
        class="cat-btn${isActive ? ' cat-active' : ''}"
        data-cat="${cat.id}"
        style="
          border-left-color:${cat.color};
          --cat-color:${cat.color};
          ${isActive ? `background:${cat.color}12;` : ''}
        "
      >
        <span class="cat-num" style="background:${numBg}; color:${cat.color}">${cat.num}</span>
        <span class="cat-label" style="${isActive ? `color:${cat.color}` : ''}">${label}</span>
      </button>`;
  }).join('');

  grid.querySelectorAll('.cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.classList.add('flashing');
      btn.addEventListener('animationend', () => btn.classList.remove('flashing'), { once: true });
      tapCategory(btn.dataset.cat);
    });
  });
}

/* ============================================================
   RENDER: CURRENT TASK + CLOCK
   ============================================================ */
function refreshCurrentTask() {
  const nameEl    = document.getElementById('ct-name');
  const elapsedEl = document.getElementById('ct-elapsed');
  if (!session || session.entries.length === 0) {
    nameEl.textContent    = '-- 未選択 --';
    nameEl.style.color    = '#fff';
    elapsedEl.textContent = '';
    return;
  }
  const last = session.entries[session.entries.length - 1];
  const cat  = CAT_BY_ID[last.categoryId];
  if (cat) {
    nameEl.textContent = cat.label.replace('\n', ' ');
    nameEl.style.color = cat.color;
  }
}

function tickClock() {
  document.getElementById('h-clock').textContent = hhmmss();

  // Update elapsed
  const elapsedEl = document.getElementById('ct-elapsed');
  if (session && session.entries.length > 0) {
    const last = session.entries[session.entries.length - 1];
    if (!last.endTs) {
      elapsedEl.textContent = fmtDur(Date.now() - last.startTs);
    }
  }
}

function startClock() {
  if (clockTid) clearInterval(clockTid);
  tickClock();
  clockTid = setInterval(tickClock, 1000);
}

function stopClock() {
  if (clockTid) { clearInterval(clockTid); clockTid = null; }
}

/* ============================================================
   RENDER: HEADER INFO
   ============================================================ */
function refreshHeader() {
  if (!session) return;
  document.getElementById('h-name').textContent = session.workerName;
  document.getElementById('h-date').textContent = fmtDate(session.date);
}

/* ============================================================
   RENDER: TIMELINE
   ============================================================ */
function renderTimeline() {
  if (!session) return;
  const slots = buildSlots(session);
  document.getElementById('tl-total').textContent =
    `${slots.length * 15}分 / ${slots.length}スロット`;

  const list = document.getElementById('timeline-list');
  list.innerHTML = slots.map((sl, i) => {
    const cat        = sl.categoryId ? CAT_BY_ID[sl.categoryId] : null;
    const timeStr    = `${hhmm(sl.slotStart)} 〜 ${hhmm(sl.slotEnd)}`;
    const catHtml    = cat
      ? `<span class="tl-cat" style="color:${cat.color}">${cat.label.replace('\n', ' ')}</span>`
      : `<span class="tl-cat tl-empty">（未記録）</span>`;
    const border     = cat ? cat.color : 'var(--border)';
    return `<div class="tl-slot" data-slot="${i}" style="border-left-color:${border}">
      <span class="tl-time">${timeStr}</span>
      ${catHtml}
      <span class="tl-pencil">✏</span>
    </div>`;
  }).join('');

  list.querySelectorAll('.tl-slot').forEach(el => {
    el.addEventListener('click', () => {
      const i  = parseInt(el.dataset.slot);
      const sl = slots[i];
      pendingSlot = { slotStart: sl.slotStart, slotEnd: sl.slotEnd };
      openModal('スロットの作業を変更', true);
    });
  });
}

/* ============================================================
   MODAL
   ============================================================ */
function openModal(title, showClear = false) {
  document.getElementById('modal-title').textContent = title;
  const grid = document.getElementById('modal-grid');

  grid.innerHTML = CATEGORIES.map(cat => {
    const numBg = cat.color + '22';
    const label = cat.label.replace('\n', '<br>');
    return `<button class="modal-cat-btn" data-cat="${cat.id}" style="border-color:${cat.color}">
      <span class="modal-cat-num" style="background:${numBg}; color:${cat.color}">${cat.num}</span>
      <span class="modal-cat-label" style="color:${cat.color}">${label}</span>
    </button>`;
  }).join('') + (showClear
    ? `<button class="modal-clear-btn" data-cat="">✕ クリア（未記録）</button>` : '');

  grid.querySelectorAll('[data-cat]').forEach(btn => {
    btn.addEventListener('click', () => applySlotEdit(btn.dataset.cat));
  });

  document.getElementById('modal-cat').style.display = 'flex';
}

function closeModal() {
  document.getElementById('modal-cat').style.display = 'none';
  pendingSlot = null;
}

/* ============================================================
   RENDER: SUMMARY
   ============================================================ */
function renderSummary(sess) {
  const slots   = buildSlots(sess);
  const summary = summarise(slots);
  const entries = Object.entries(summary)
    .map(([id, mins]) => ({ id, mins, cat: CAT_BY_ID[id] }))
    .filter(e => e.cat)
    .sort((a, b) => b.mins - a.mins);

  const totalMs   = sess.endTs - sess.startTs;
  const totalMins = slots.length * 15;
  const maxMins   = entries.length > 0 ? entries[0].mins : 1;

  const rows = entries.map(e => {
    const pct    = Math.round(e.mins / totalMins * 100);
    const barPct = Math.round(e.mins / maxMins * 100);
    return `<tr>
      <td class="td-cat" style="color:${e.cat.color}">${e.cat.label.replace('\n', ' ')}</td>
      <td class="td-bar">
        <div class="bar-wrap">
          <div class="bar-fill" style="width:${barPct}%; background:${e.cat.color}"></div>
        </div>
      </td>
      <td class="td-dur">${e.mins}分</td>
      <td class="td-pct">${pct}%</td>
    </tr>`;
  }).join('');

  document.getElementById('summary-scroll').innerHTML = `
    <div class="summary-card">
      <div class="info-grid">
        <div class="info-cell">
          <div class="ic-label">お名前</div>
          <div class="ic-value" style="font-size:17px">${sess.workerName}</div>
        </div>
        <div class="info-cell">
          <div class="ic-label">日付</div>
          <div class="ic-value" style="font-size:15px">${fmtDate(sess.date)}</div>
        </div>
        <div class="info-cell">
          <div class="ic-label">勤務時間帯</div>
          <div class="ic-value" style="font-size:17px">${hhmm(sess.startTs)} 〜 ${hhmm(sess.endTs)}</div>
        </div>
        <div class="info-cell">
          <div class="ic-label">実勤務時間</div>
          <div class="ic-value">${fmtDur(totalMs)}</div>
        </div>
      </div>
    </div>
    <div class="summary-card">
      <div class="summary-card-title">作業内訳（15分単位）</div>
      <table class="sum-table">
        <thead><tr>
          <th>作業内容</th><th></th>
          <th style="text-align:right">時間</th>
          <th style="text-align:right">割合</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/* ============================================================
   RENDER: HISTORY
   ============================================================ */
function renderHistory() {
  const list = document.getElementById('history-list');
  if (sessions.length === 0) {
    list.innerHTML = '<div class="empty-state">📭 記録がまだありません</div>';
    return;
  }

  list.innerHTML = [...sessions].reverse().map(sess => {
    const slots   = buildSlots(sess);
    const summary = summarise(slots);
    const chips   = Object.entries(summary)
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([id, mins]) => {
        const cat = CAT_BY_ID[id];
        return cat
          ? `<span class="hist-chip" style="background:${cat.color}">${cat.label.replace('\n',' ')} ${mins}分</span>`
          : '';
      }).join('');
    return `<div class="hist-item">
      <div class="hist-top">
        <span class="hist-name">${sess.workerName}</span>
        <span class="hist-date">${fmtDate(sess.date)}</span>
      </div>
      <div class="hist-range">${hhmm(sess.startTs)} 〜 ${hhmm(sess.endTs)}（${fmtDur(sess.endTs - sess.startTs)}）</div>
      <div class="hist-chips">${chips}</div>
    </div>`;
  }).join('');
}

/* ============================================================
   CSV EXPORT
   ============================================================ */
function exportCSV() {
  if (sessions.length === 0) { alert('記録がありません'); return; }

  const header = ['日付', 'お名前', '開始時刻', '終了時刻', '作業内容', '時間（分）'];
  const rows   = [header];

  for (const sess of sessions) {
    const summary = summarise(buildSlots(sess));
    for (const [id, mins] of Object.entries(summary)) {
      const cat = CAT_BY_ID[id];
      rows.push([
        sess.date, sess.workerName,
        hhmm(sess.startTs), hhmm(sess.endTs),
        cat ? cat.label.replace('\n', ' ') : id,
        mins,
      ]);
    }
  }

  const csv  = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href: url,
    download: `作業記録_${new Date().toISOString().slice(0, 10)}.csv`,
  });
  a.click();
  URL.revokeObjectURL(url);
}

/* ============================================================
   TOAST
   ============================================================ */
let toastTid = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.display = 'block';
  el.style.animation = 'toastIn .25s ease';
  if (toastTid) clearTimeout(toastTid);
  toastTid = setTimeout(() => {
    el.style.animation = 'toastOut .3s ease forwards';
    setTimeout(() => { el.style.display = 'none'; }, 300);
  }, 1800);
}

/* ============================================================
   EVENTS
   ============================================================ */
function setupEvents() {
  // Login
  document.getElementById('btn-start-shift').addEventListener('click', () => {
    const name = document.getElementById('worker-name').value.trim();
    const date = document.getElementById('work-date').value;
    const time = document.getElementById('start-time').value;
    if (!name) { alert('お名前を入力してください'); return; }
    if (!date || !time) { alert('日付と開始時刻を入力してください'); return; }

    startShift(name, date, time);
    refreshHeader();
    refreshCategoryGrid();
    refreshCurrentTask();
    startClock();
    showScreen('screen-main');
  });

  document.getElementById('btn-show-history').addEventListener('click', () => {
    renderHistory();
    showScreen('screen-history');
  });

  // Main
  document.getElementById('btn-timeline').addEventListener('click', () => {
    renderTimeline();
    showScreen('screen-timeline');
  });

  document.getElementById('btn-end-shift').addEventListener('click', () => {
    if (!confirm('退勤しますか？')) return;
    stopClock();
    finishShift();
    renderSummary(sessions[sessions.length - 1]);
    showScreen('screen-summary');
  });

  // Timeline
  document.getElementById('btn-back-main').addEventListener('click', () => showScreen('screen-main'));

  document.getElementById('btn-end-from-tl').addEventListener('click', () => {
    if (!confirm('退勤しますか？')) return;
    stopClock();
    finishShift();
    renderSummary(sessions[sessions.length - 1]);
    showScreen('screen-summary');
  });

  // Summary
  document.getElementById('btn-new-shift').addEventListener('click', () => showScreen('screen-login'));
  document.getElementById('btn-to-history').addEventListener('click', () => {
    renderHistory();
    showScreen('screen-history');
  });

  // History
  document.getElementById('btn-back-from-history').addEventListener('click', () => {
    showScreen(session ? 'screen-main' : 'screen-login');
  });
  document.getElementById('btn-export').addEventListener('click', exportCSV);

  // Modal
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-backdrop').addEventListener('click', closeModal);
}

/* ============================================================
   INIT
   ============================================================ */
function init() {
  hydrate();

  // Default form values
  const now = new Date();
  const roundedMin = Math.floor(now.getMinutes() / 15) * 15;
  document.getElementById('work-date').value =
    `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  document.getElementById('start-time').value =
    `${pad(now.getHours())}:${pad(roundedMin)}`;

  setupEvents();

  if (session) {
    refreshHeader();
    refreshCategoryGrid();
    refreshCurrentTask();
    startClock();
    showScreen('screen-main');
  } else {
    showScreen('screen-login');
  }
}

document.addEventListener('DOMContentLoaded', init);
