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
const CAT = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

/* ============================================================
   STATE
   ============================================================ */
let employees        = {};   // code(string) -> name(string)
let sessions         = [];   // completed sessions
let session          = null; // current in-progress session
let clockTid         = null;
let editingSessionId = null; // 履歴編集中のセッションID
let historyViewDate  = null; // null=日付一覧, 文字列=その日の詳細

// Login numpad
let currentCode = '';

// Pending slot being edited
let pendingSlot = null; // { slotStart, slotEnd }

/* ============================================================
   PERSISTENCE
   ============================================================ */
function persist() {
  try {
    localStorage.setItem('lr_employees', JSON.stringify(employees));
    localStorage.setItem('lr_sessions',  JSON.stringify(sessions));
    if (session) localStorage.setItem('lr_current', JSON.stringify(session));
    else         localStorage.removeItem('lr_current');
  } catch (_) {}
}

function hydrate() {
  try { employees = JSON.parse(localStorage.getItem('lr_employees') || '{}'); } catch { employees = {}; }
  try { sessions  = JSON.parse(localStorage.getItem('lr_sessions')  || '[]'); } catch { sessions  = []; }
  try { const c   = localStorage.getItem('lr_current'); if (c) session = JSON.parse(c); } catch { session = null; }
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
  const t = Math.round(ms / 60000), h = Math.floor(t / 60), m = t % 60;
  if (h === 0) return `${m}分`;
  if (m === 0) return `${h}時間`;
  return `${h}時間${m}分`;
}
function fmtDate(s) {
  const [y, mo, d] = s.split('-').map(Number);
  const dow = ['日','月','火','水','木','金','土'][new Date(y, mo-1, d).getDay()];
  return `${mo}月${d}日（${dow}）`;
}
function floorTo15(ts) { return ts - (ts % (15 * 60000)); }

function parseDateTime(dateStr, timeStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, m]     = timeStr.split(':').map(Number);
  return new Date(y, mo-1, d, h, m, 0, 0).getTime();
}

/* ============================================================
   SLOT COMPUTATION (shared)
   ============================================================ */
function buildSlots(sess) {
  const startSlot = floorTo15(sess.startTs);
  let   endSlot   = floorTo15(sess.endTs);
  if (sess.endTs % (15 * 60000) > 0) endSlot += 15 * 60000;

  const slots = [];
  for (let t = startSlot; t < endSlot; t += 15 * 60000) {
    const mid = t + 7.5 * 60000;
    let catId = null;
    for (const e of sess.entries) {
      if (e.startTs <= mid && mid < e.endTs) { catId = e.categoryId; break; }
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
  return map;
}

/* ============================================================
   SLOT EDITING
   ============================================================ */
function assignSlot(slotStart, slotEnd, catId) {
  if (!session) return;

  // Remove any overlapping entries, then insert new one
  const rebuilt = [];
  for (const e of session.entries) {
    if (e.endTs <= slotStart || e.startTs >= slotEnd) {
      rebuilt.push({ ...e });
      continue;
    }
    if (e.startTs < slotStart) rebuilt.push({ ...e, endTs: slotStart });
    if (e.endTs   > slotEnd)   rebuilt.push({ ...e, startTs: slotEnd });
  }

  if (catId) rebuilt.push({ categoryId: catId, startTs: slotStart, endTs: slotEnd });

  // Sort + merge adjacent same-category
  rebuilt.sort((a, b) => a.startTs - b.startTs);
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
  persist();
}

/* ============================================================
   SHIFT MANAGEMENT
   ============================================================ */
function startShift(code, name, dateStr, startTimeStr, endTimeStr, breakMins) {
  session = {
    id: String(Date.now()),
    employeeCode: code,
    workerName: name,
    date: dateStr,
    startTs:   parseDateTime(dateStr, startTimeStr),
    endTs:     parseDateTime(dateStr, endTimeStr),
    breakMins: parseInt(breakMins, 10) || 0,
    entries: [],
  };
  persist();
}

function saveShift() {
  if (!session) return;
  if (editingSessionId) {
    const idx = sessions.findIndex(s => s.id === editingSessionId);
    if (idx >= 0) sessions[idx] = session;
    else sessions.push(session);
    editingSessionId = null;
  } else {
    sessions.push(session);
  }
  session = null;
  persist();
}

function editHistory(id) {
  const idx = sessions.findIndex(s => s.id === id);
  if (idx < 0) return;
  editingSessionId = id;
  session = JSON.parse(JSON.stringify(sessions[idx]));
  persist();
  refreshHeader();
  renderTimeline();
  startClock();
  showScreen('screen-main');
}


/* ============================================================
   NUMPAD
   ============================================================ */
function updateCodeDisplay() {
  const display = document.getElementById('code-display');
  const nameEl  = document.getElementById('code-name');

  if (currentCode === '') {
    display.textContent = '－－－－';
    nameEl.textContent  = '';
    nameEl.className    = 'code-name';
    return;
  }

  display.textContent = currentCode;

  const name = employees[currentCode];
  if (name) {
    nameEl.textContent = '✅ ' + name;
    nameEl.className   = 'code-name';
  } else {
    nameEl.textContent = '未登録のコードです';
    nameEl.className   = 'code-name unregistered';
  }
}

function numpadPress(digit) {
  if (currentCode.length >= 8) return;
  currentCode += digit;
  updateCodeDisplay();
}

function numpadDelete() {
  currentCode = currentCode.slice(0, -1);
  updateCodeDisplay();
}

function numpadClear() {
  currentCode = '';
  updateCodeDisplay();
}

/* ============================================================
   CLOCK
   ============================================================ */
function startClock() {
  if (clockTid) clearInterval(clockTid);
  const el = document.getElementById('h-clock');
  function tick() { el.textContent = hhmmss(); }
  tick();
  clockTid = setInterval(tick, 1000);
}
function stopClock() { if (clockTid) { clearInterval(clockTid); clockTid = null; } }

/* ============================================================
   SCREEN NAVIGATION
   ============================================================ */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

/* ============================================================
   RENDER: MAIN HEADER
   ============================================================ */
function refreshHeader() {
  if (!session) return;
  document.getElementById('h-name').textContent = session.workerName;
  document.getElementById('h-code').textContent = session.employeeCode;
  document.getElementById('h-date').textContent = fmtDate(session.date) + '　' + hhmm(session.startTs) + '〜' + hhmm(session.endTs);
}

/* ============================================================
   RENDER: TIMELINE
   ============================================================ */
function renderTimeline() {
  if (!session) return;
  const slots        = buildSlots(session);
  const assignedMins = slots.filter(s => s.categoryId).length * 15;
  const shiftMins    = Math.round((session.endTs - session.startTs) / 60000);
  const targetMins   = Math.max(0, shiftMins - (session.breakMins || 0));
  const remaining    = targetMins - assignedMins;
  const pct          = targetMins > 0 ? Math.min(100, Math.round(assignedMins / targetMins * 100)) : 0;

  document.getElementById('prog-assigned').textContent  = `入力済み: ${assignedMins}分`;
  document.getElementById('prog-target').textContent    = `実労働時間: ${targetMins}分`;
  document.getElementById('progress-fill').style.width  = pct + '%';

  let hint;
  if (assignedMins === 0)  hint = '作業が始まった時刻をタップして作業内容を選んでください';
  else if (remaining > 0)  hint = '作業が変わった時刻をタップ → 完了したら「集計する」';
  else                     hint = '✅ 全入力済み！「集計する」を押してください';
  document.getElementById('progress-hint').textContent = hint;

  document.getElementById('btn-finish').disabled = assignedMins === 0;

  const scroll = document.getElementById('tl-scroll');
  scroll.innerHTML = slots.map((sl, i) => {
    const cat     = sl.categoryId ? CAT[sl.categoryId] : null;
    const timeStr = `${hhmm(sl.slotStart)} 〜 ${hhmm(sl.slotEnd)}`;
    const catHtml = cat
      ? `<span class="tl-cat" style="color:${cat.color}">${cat.label.replace('\n', ' ')}</span>`
      : `<span class="tl-cat tl-empty">（未記録）</span>`;
    const border  = cat ? cat.color : 'var(--border)';
    return `<button class="tl-slot" onclick="tapSlot(${i})" style="border-left-color:${border}">
      <span class="tl-time">${timeStr}</span>
      ${catHtml}
      <span class="tl-edit">✏</span>
    </button>`;
  }).join('');
}

function tapSlot(i) {
  if (!session) return;
  const slots = buildSlots(session);
  const sl    = slots[i];
  pendingSlot = { slotStart: sl.slotStart, slotEnd: sl.slotEnd };
  openCatModal('作業を選択', sl.categoryId !== null);
}

/* ============================================================
   CATEGORY MODAL
   ============================================================ */
function openCatModal(title, showClear = false) {
  document.getElementById('modal-title').textContent = title;
  const grid = document.getElementById('modal-grid');

  grid.innerHTML = CATEGORIES.map(cat => {
    const numBg = cat.color + '22';
    const label = cat.label.replace('\n', '<br>');
    return `<button class="modal-cat-btn" onclick="pickCat('${cat.id}')" style="border-color:${cat.color}">
      <span class="modal-cat-num" style="background:${numBg};color:${cat.color}">${cat.num}</span>
      <span class="modal-cat-label" style="color:${cat.color}">${label}</span>
    </button>`;
  }).join('') + (showClear ? `<button class="modal-clear-btn" onclick="pickCat('')">✕ クリア（未記録）</button>` : '');

  document.getElementById('modal-cat').style.display = 'flex';
}

function pickCat(catId) {
  const slot = pendingSlot;
  closeModal();
  if (!slot || !session) return;

  if (catId) {
    // 前の区間を遡及して埋める
    const allSlots = buildSlots(session);
    const idx      = allSlots.findIndex(s => s.slotStart === slot.slotStart);
    let prevEnd = null, prevCat = null;
    for (let j = idx - 1; j >= 0; j--) {
      if (allSlots[j].categoryId) { prevEnd = allSlots[j].slotEnd; prevCat = allSlots[j].categoryId; break; }
    }
    if (prevEnd !== null && prevEnd < slot.slotStart) {
      assignSlot(prevEnd, slot.slotStart, prevCat);
    }
    // タップしたスロット1つだけに新作業をセット（末尾は次のタップで確定）
    assignSlot(slot.slotStart, slot.slotEnd, catId);
  } else {
    assignSlot(slot.slotStart, slot.slotEnd, null);
  }
  renderTimeline();
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
    .map(([id, mins]) => ({ id, mins, cat: CAT[id] }))
    .filter(e => e.cat).sort((a, b) => b.mins - a.mins);

  const totalMins = slots.length * 15;
  const maxMins   = entries.length > 0 ? entries[0].mins : 1;
  const uncovered = slots.filter(s => !s.categoryId).length * 15;

  const rows = entries.map(e => {
    const pct    = Math.round(e.mins / totalMins * 100);
    const barPct = Math.round(e.mins / maxMins * 100);
    return `<tr>
      <td class="td-cat" style="color:${e.cat.color}">${e.cat.label.replace('\n',' ')}</td>
      <td class="td-bar"><div class="bar-wrap"><div class="bar-fill" style="width:${barPct}%;background:${e.cat.color}"></div></div></td>
      <td class="td-dur">${e.mins}分</td>
      <td class="td-pct">${pct}%</td>
    </tr>`;
  }).join('');

  const uncoveredRow = uncovered > 0
    ? `<tr><td class="td-cat" style="color:var(--muted)">（未記録）</td><td class="td-bar"></td><td class="td-dur" style="color:var(--muted)">${uncovered}分</td><td class="td-pct"></td></tr>`
    : '';

  document.getElementById('summary-scroll').innerHTML = `
    <div class="summary-card">
      <div class="info-grid">
        <div class="info-cell"><div class="ic-label">社員コード</div><div class="ic-value" style="font-size:22px">${sess.employeeCode}</div></div>
        <div class="info-cell"><div class="ic-label">氏名</div><div class="ic-value" style="font-size:16px">${sess.workerName}</div></div>
        <div class="info-cell"><div class="ic-label">日付</div><div class="ic-value" style="font-size:14px">${fmtDate(sess.date)}</div></div>
        <div class="info-cell"><div class="ic-label">勤務時間</div><div class="ic-value" style="font-size:15px">${hhmm(sess.startTs)}〜${hhmm(sess.endTs)}</div></div>
      </div>
    </div>
    <div class="summary-card">
      <div class="summary-card-title">作業内訳（15分単位）</div>
      <table class="sum-table">
        <thead><tr><th>作業内容</th><th></th><th style="text-align:right">時間</th><th style="text-align:right">割合</th></tr></thead>
        <tbody>${rows}${uncoveredRow}</tbody>
      </table>
    </div>`;
}

/* ============================================================
   RENDER: HISTORY
   ============================================================ */
function histByDate() {
  const byDate = {};
  for (const sess of sessions) {
    if (!byDate[sess.date]) byDate[sess.date] = [];
    byDate[sess.date].push(sess);
  }
  return byDate;
}

function renderHistory() {
  if (historyViewDate) {
    renderHistoryDay(historyViewDate);
  } else {
    renderHistoryList();
  }
}

function renderHistoryList() {
  document.querySelector('#screen-history h2').textContent = '勤務履歴';
  const list = document.getElementById('history-list');
  if (sessions.length === 0) {
    list.innerHTML = '<div class="empty-state">📭 記録がまだありません</div>';
    return;
  }
  const byDate      = histByDate();
  const sortedDates = Object.keys(byDate).sort((a, b) => b.localeCompare(a));
  list.innerHTML = sortedDates.map(date => {
    const count = byDate[date].length;
    return `<button class="hist-date-row" onclick="showHistoryDate('${date}')">
      <span class="hist-date-row-label">${fmtDate(date)}</span>
      <span class="hist-date-row-count">${count}件</span>
      <span class="hist-date-row-arrow">›</span>
    </button>`;
  }).join('');
}

function showHistoryDate(date) {
  historyViewDate = date;
  renderHistoryDay(date);
}

function renderHistoryDay(date) {
  document.querySelector('#screen-history h2').textContent = fmtDate(date);
  const list    = document.getElementById('history-list');
  const byDate  = histByDate();
  const daySess = byDate[date] || [];
  if (daySess.length === 0) {
    list.innerHTML = '<div class="empty-state">記録がありません</div>';
    return;
  }
  const sorted = daySess.slice().sort((a, b) =>
    String(a.employeeCode).localeCompare(String(b.employeeCode), undefined, { numeric: true }));
  list.innerHTML = sorted.map(sess => {
    const chips = Object.entries(summarise(buildSlots(sess)))
      .sort((a,b) => b[1]-a[1]).slice(0, 5).map(([id, mins]) => {
        const cat = CAT[id];
        return cat ? `<span class="hist-chip" style="background:${cat.color}">${cat.label.replace('\n',' ')} ${mins}分</span>` : '';
      }).join('');
    return `<div class="hist-item">
      <div class="hist-top">
        <div>
          <span class="hist-name">${sess.workerName}</span>
          <span class="hist-code">${sess.employeeCode}</span>
        </div>
        <div class="hist-actions">
          <button class="btn-hist-edit" onclick="editHistory('${sess.id}')">✏ 修正</button>
          <button class="btn-hist-del"  onclick="deleteHistory('${sess.id}')">🗑</button>
        </div>
      </div>
      <div class="hist-range">${hhmm(sess.startTs)} 〜 ${hhmm(sess.endTs)}（${fmtDur(sess.endTs - sess.startTs)}）</div>
      <div class="hist-chips">${chips}</div>
    </div>`;
  }).join('');
}

function deleteHistory(id) {
  if (!confirm('この記録を削除しますか？')) return;
  const idx = sessions.findIndex(s => s.id === id);
  if (idx < 0) return;
  sessions.splice(idx, 1);
  persist();
  const remaining = (histByDate()[historyViewDate] || []).length;
  if (remaining === 0) { historyViewDate = null; renderHistoryList(); }
  else                 { renderHistoryDay(historyViewDate); }
}

/* ============================================================
   RENDER: ADMIN (EMPLOYEE LIST)
   ============================================================ */
function renderEmployeeList() {
  const list = document.getElementById('employee-list');
  const keys = Object.keys(employees).sort();
  if (keys.length === 0) {
    list.innerHTML = '<div style="color:var(--muted);font-size:14px;padding:8px 4px">登録された社員がいません</div>';
    return;
  }
  list.innerHTML = keys.map(code => `
    <div class="emp-row">
      <span class="emp-code">${code}</span>
      <span class="emp-name">${employees[code]}</span>
      <button class="btn-del-emp" data-code="${code}">✕</button>
    </div>`).join('');

  list.querySelectorAll('.btn-del-emp').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm(`${btn.dataset.code} を削除しますか？`)) return;
      delete employees[btn.dataset.code];
      persist();
      renderEmployeeList();
    });
  });
}

/* ============================================================
   CSV EXPORT
   ============================================================ */
function exportCSV() {
  const target   = historyViewDate ? sessions.filter(s => s.date === historyViewDate) : sessions;
  if (target.length === 0) { alert('記録がありません'); return; }
  const rows = [['日付','社員コード','氏名','開始','終了','作業内容','時間（h）']];
  for (const sess of target) {
    const summary = summarise(buildSlots(sess));
    for (const [id, mins] of Object.entries(summary)) {
      const cat = CAT[id];
      rows.push([
        sess.date, sess.employeeCode, sess.workerName,
        hhmm(sess.startTs), hhmm(sess.endTs),
        cat ? cat.label.replace('\n',' ') : id,
        (mins / 60).toFixed(2),
      ]);
    }
  }
  const filename = historyViewDate ? `作業記録_${historyViewDate}.csv` : `作業記録_${new Date().toISOString().slice(0,10)}.csv`;
  const csv  = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: filename }).click();
  URL.revokeObjectURL(url);
}

function downloadEmpTemplate() {
  const csv  = '﻿社員コード,氏名\r\n1001,田中 太郎\r\n1002,鈴木 花子\r\n';
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: '社員登録テンプレート.csv' }).click();
  URL.revokeObjectURL(url);
}

/* ============================================================
   TOAST
   ============================================================ */
let toastTid = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.style.display = 'block'; el.style.animation = 'toastIn .25s ease';
  if (toastTid) clearTimeout(toastTid);
  toastTid = setTimeout(() => {
    el.style.animation = 'toastOut .3s ease forwards';
    setTimeout(() => { el.style.display = 'none'; }, 300);
  }, 1800);
}

/* ============================================================
   EVENT SETUP
   ============================================================ */
function setupEvents() {

  // ── Numpad ──
  document.querySelectorAll('.np-btn[data-n]').forEach(btn => {
    btn.addEventListener('click', () => numpadPress(btn.dataset.n));
  });
  document.getElementById('np-del').addEventListener('click', numpadDelete);
  document.getElementById('np-clr').addEventListener('click', numpadClear);

  // ── 時刻を15分単位にスナップ ──
  function snapTo15(val) {
    if (!val) return val;
    const [h, m] = val.split(':').map(Number);
    const snapped = Math.round(m / 15) * 15;
    if (snapped === 60) return `${pad((h + 1) % 24)}:00`;
    return `${pad(h)}:${pad(snapped)}`;
  }
  document.getElementById('start-time').addEventListener('change', function() { this.value = snapTo15(this.value); });
  document.getElementById('end-time').addEventListener('change', function()   { this.value = snapTo15(this.value); });

  // ── Start shift ──
  document.getElementById('btn-start-shift').addEventListener('click', () => {
    const code     = currentCode.trim();
    const date     = document.getElementById('work-date').value;
    const start    = document.getElementById('start-time').value;
    const end      = document.getElementById('end-time').value;
    const breakVal = document.getElementById('break-mins').value;

    if (!code)                   { showToast('社員コードを入力してください'); return; }
    if (!date || !start || !end) { showToast('日付・開始・終了時刻を入力してください'); return; }

    const sTs = parseDateTime(date, start);
    const eTs = parseDateTime(date, end);
    if (eTs <= sTs) { showToast('終了は開始より後の時刻にしてください'); return; }

    const name = employees[code] || code + ' さん';
    startShift(code, name, date, start, end, breakVal);
    refreshHeader();
    renderTimeline();
    startClock();
    showScreen('screen-main');
    currentCode = '';
    updateCodeDisplay();
  });

  document.getElementById('btn-show-history').addEventListener('click', () => {
    renderHistory();
    showScreen('screen-history');
  });

  document.getElementById('btn-goto-admin').addEventListener('click', () => {
    renderEmployeeList();
    showScreen('screen-admin');
  });

  // ── Main / Timeline ──
  document.getElementById('btn-back-to-login').addEventListener('click', () => {
    const wasEditing = editingSessionId !== null;
    const savedDate  = wasEditing ? session.date : null;
    const msg = wasEditing
      ? '修正を中断して履歴画面に戻りますか？（変更は破棄されます）'
      : '作業入力を中断してログイン画面に戻りますか？（入力内容は破棄されます）';
    if (!confirm(msg)) return;
    session = null;
    editingSessionId = null;
    persist();
    stopClock();
    if (wasEditing) {
      historyViewDate = savedDate;
      renderHistoryDay(savedDate);
      showScreen('screen-history');
    } else {
      showScreen('screen-login');
    }
  });

  document.getElementById('btn-clr-all').addEventListener('click', () => {
    if (!confirm('全スロットをクリアしますか？')) return;
    session.entries = [];
    persist();
    renderTimeline();
  });

  document.getElementById('btn-finish').addEventListener('click', () => {
    if (!session) return;
    // 最後に入力されたスロットから勤務終了まで、その作業で自動補完
    const slots      = buildSlots(session);
    const lastFilled = [...slots].reverse().find(s => s.categoryId);
    if (lastFilled && lastFilled.slotEnd < session.endTs) {
      assignSlot(lastFilled.slotEnd, session.endTs, lastFilled.categoryId);
    }
    renderSummary(session);
    showScreen('screen-summary');
  });

  // ── Summary ──
  document.getElementById('btn-back-to-main').addEventListener('click', () => {
    renderTimeline();
    showScreen('screen-main');
  });

  document.getElementById('btn-save-finish').addEventListener('click', () => {
    const wasEditing = editingSessionId !== null;
    const savedDate  = wasEditing ? session.date : null;
    saveShift();
    stopClock();
    showToast('記録を保存しました');
    if (wasEditing) {
      historyViewDate = savedDate;
      renderHistoryDay(savedDate);
      showScreen('screen-history');
    } else {
      showScreen('screen-login');
    }
  });

  // ── History ──
  document.getElementById('btn-back-from-history').addEventListener('click', () => {
    if (historyViewDate) {
      historyViewDate = null;
      renderHistoryList();
    } else {
      showScreen(session ? 'screen-main' : 'screen-login');
    }
  });
  document.getElementById('btn-export').addEventListener('click', exportCSV);

  // ── Admin ──
  document.getElementById('btn-back-admin').addEventListener('click', () => showScreen('screen-login'));

  document.getElementById('btn-add-emp').addEventListener('click', () => {
    const code = document.getElementById('admin-code').value.trim();
    const name = document.getElementById('admin-name').value.trim();
    if (!code || !name) { showToast('コードと氏名を入力してください'); return; }
    employees[code] = name;
    persist();
    document.getElementById('admin-code').value = '';
    document.getElementById('admin-name').value = '';
    renderEmployeeList();
    showToast(`${code}：${name} を登録しました`);
  });

  // ── Admin CSV import ──
  document.getElementById('admin-csv-file').addEventListener('change', function() {
    document.getElementById('admin-csv-name').textContent = this.files[0] ? this.files[0].name : '未選択';
  });
  document.getElementById('btn-import-csv').addEventListener('click', () => {
    const file = document.getElementById('admin-csv-file').files[0];
    if (!file) { showToast('CSVファイルを選択してください'); return; }
    const reader = new FileReader();
    reader.onload = function(e) {
      const buf = new Uint8Array(e.target.result);
      // UTF-8 BOM (EF BB BF) があればUTF-8、なければExcelのShift-JISとして読む
      const isUtf8 = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
      let text;
      if (isUtf8) {
        text = new TextDecoder('utf-8').decode(buf);
      } else {
        try { text = new TextDecoder('shift_jis').decode(buf); }
        catch { text = new TextDecoder('utf-8').decode(buf); }
      }
      text = text.replace(/^﻿/, ''); // BOM除去
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      let count = 0;
      for (const line of lines) {
        const parts = line.split(',').map(p => p.replace(/^"(.*)"$/, '$1').trim());
        if (parts.length < 2) continue;
        const code = parts[0], name = parts[1];
        if (!code || !name || isNaN(Number(code))) continue; // 非数値はヘッダー行として無視
        employees[code] = name;
        count++;
      }
      persist();
      renderEmployeeList();
      showToast(`${count}名を登録しました`);
      document.getElementById('admin-csv-file').value = '';
    };
    reader.readAsArrayBuffer(file);
  });

  // ── Modal ──
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-backdrop').addEventListener('click', closeModal);
}

/* ============================================================
   INIT
   ============================================================ */
function init() {
  hydrate();

  // Default date / time
  const now      = new Date();
  const rMin     = Math.floor(now.getMinutes() / 15) * 15;
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  document.getElementById('work-date').value  = todayStr;
  document.getElementById('start-time').value = `${pad(now.getHours())}:${pad(rMin)}`;
  document.getElementById('end-time').value   = '';

  setupEvents();
  updateCodeDisplay();

  // Resume in-progress session
  if (session) {
    refreshHeader();
    renderTimeline();
    startClock();
    showScreen('screen-main');
  } else {
    showScreen('screen-login');
  }
}

document.addEventListener('DOMContentLoaded', init);
