'use strict';

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

let employees = {};
let sessions  = [];
let session   = null;
let clockTid  = null;
let currentCode = '';
let paintCat    = null;
let pendingSlot = null;

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
  try { const c = localStorage.getItem('lr_current'); if (c) session = JSON.parse(c); } catch { session = null; }
}

const pad = n => String(n).padStart(2, '0');
function hhmm(ts) { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function hhmmss() { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
function fmtDur(ms) {
  if (ms < 0) ms = 0;
  const t = Math.round(ms / 60000), h = Math.floor(t / 60), m = t % 60;
  if (h === 0) return `${m}分`; if (m === 0) return `${h}時間`; return `${h}時間${m}分`;
}
function fmtDate(s) {
  const [y, mo, d] = s.split('-').map(Number);
  return `${mo}月${d}日（${'日月火水木金土'[new Date(y,mo-1,d).getDay()]}）`;
}
function floorTo15(ts) { return ts - (ts % (15 * 60000)); }
function parseDateTime(dateStr, timeStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, m]     = timeStr.split(':').map(Number);
  return new Date(y, mo-1, d, h, m, 0, 0).getTime();
}

function buildSlots(sess) {
  const startSlot = floorTo15(sess.startTs);
  let endSlot = floorTo15(sess.endTs);
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
  for (const s of slots) { if (!s.categoryId) continue; map[s.categoryId] = (map[s.categoryId] || 0) + 15; }
  return map;
}

function assignSlot(slotStart, slotEnd, catId) {
  if (!session) return;
  const rebuilt = [];
  for (const e of session.entries) {
    if (e.endTs <= slotStart || e.startTs >= slotEnd) { rebuilt.push({...e}); continue; }
    if (e.startTs < slotStart) rebuilt.push({...e, endTs: slotStart});
    if (e.endTs   > slotEnd)   rebuilt.push({...e, startTs: slotEnd});
  }
  if (catId) rebuilt.push({ categoryId: catId, startTs: slotStart, endTs: slotEnd });
  rebuilt.sort((a, b) => a.startTs - b.startTs);
  const merged = [];
  for (const e of rebuilt) {
    if (merged.length > 0) {
      const prev = merged[merged.length - 1];
      if (prev.categoryId === e.categoryId && prev.endTs === e.startTs) { prev.endTs = e.endTs; continue; }
    }
    merged.push({...e});
  }
  session.entries = merged;
  persist();
}

function startShift(code, name, dateStr, startTimeStr, endTimeStr) {
  session = {
    id: String(Date.now()), employeeCode: code, workerName: name, date: dateStr,
    startTs: parseDateTime(dateStr, startTimeStr),
    endTs:   parseDateTime(dateStr, endTimeStr),
    entries: [],
  };
  persist();
}

function saveShift() {
  if (!session) return;
  sessions.push(session); session = null; persist();
}

function updateCodeDisplay() {
  const display = document.getElementById('code-display');
  const nameEl  = document.getElementById('code-name');
  if (currentCode === '') {
    display.textContent = '－－－－'; nameEl.textContent = ''; nameEl.className = 'code-name'; return;
  }
  display.textContent = currentCode;
  const name = employees[currentCode];
  if (name) { nameEl.textContent = '✅ ' + name; nameEl.className = 'code-name'; }
  else       { nameEl.textContent = '未登録のコードです'; nameEl.className = 'code-name unregistered'; }
}

function numpadPress(digit) { if (currentCode.length < 8) { currentCode += digit; updateCodeDisplay(); } }
function numpadDelete()     { currentCode = currentCode.slice(0, -1); updateCodeDisplay(); }
function numpadClear()      { currentCode = ''; updateCodeDisplay(); }

function startClock() {
  if (clockTid) clearInterval(clockTid);
  const el = document.getElementById('h-clock');
  function tick() { el.textContent = hhmmss(); }
  tick(); clockTid = setInterval(tick, 1000);
}
function stopClock() { if (clockTid) { clearInterval(clockTid); clockTid = null; } }

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function refreshHeader() {
  if (!session) return;
  document.getElementById('h-name').textContent = session.workerName;
  document.getElementById('h-code').textContent = session.employeeCode;
  document.getElementById('h-date').textContent = fmtDate(session.date) + '　' + hhmm(session.startTs) + '〜' + hhmm(session.endTs);
}

function renderTimeline() {
  if (!session) return;
  const slots = buildSlots(session);
  const filled = slots.filter(s => s.categoryId).length;
  const total  = slots.length;
  document.getElementById('tl-progress').textContent =
    `${filled} / ${total} スロット入力済（${total > 0 ? Math.round(filled/total*100) : 0}%）`;

  const scroll = document.getElementById('tl-scroll');
  scroll.innerHTML = slots.map((sl, i) => {
    const cat     = sl.categoryId ? CAT[sl.categoryId] : null;
    const timeStr = `${hhmm(sl.slotStart)} 〜 ${hhmm(sl.slotEnd)}`;
    const catHtml = cat
      ? `<span class="tl-cat" style="color:${cat.color}">${cat.label.replace('\n',' ')}</span>`
      : `<span class="tl-cat tl-empty">（未記録）</span>`;
    return `<div class="tl-slot" data-slot="${i}" style="border-left-color:${cat ? cat.color : 'var(--border)'}">
      <span class="tl-time">${timeStr}</span>${catHtml}
      <span class="tl-edit">${paintCat ? '▶' : '✏'}</span>
    </div>`;
  }).join('');

  scroll.querySelectorAll('.tl-slot').forEach(el => {
    el.addEventListener('click', () => {
      const sl = slots[parseInt(el.dataset.slot)];
      if (paintCat) {
        assignSlot(sl.slotStart, sl.slotEnd, sl.categoryId === paintCat ? null : paintCat);
        renderTimeline();
      } else {
        pendingSlot = { slotStart: sl.slotStart, slotEnd: sl.slotEnd };
        openCatModal('作業を選択', true);
      }
    });
  });
}

function enterPaintMode(catId) {
  paintCat = catId;
  const cat = CAT[catId];
  document.getElementById('paint-banner').style.display = 'flex';
  document.getElementById('paint-icon').textContent = '■';
  document.getElementById('paint-icon').style.color = cat.color;
  document.getElementById('paint-text').textContent  = cat.label.replace('\n',' ') + ' を塗り中　タップして適用';
  renderTimeline();
  showToast('塗りモード: ' + cat.label.replace('\n',' '));
}

function exitPaintMode() {
  paintCat = null;
  document.getElementById('paint-banner').style.display = 'none';
  renderTimeline();
}

function openCatModal(title, showClear = false) {
  document.getElementById('modal-title').textContent = title;
  const grid = document.getElementById('modal-grid');
  grid.innerHTML = CATEGORIES.map(cat => {
    const numBg = cat.color + '22';
    return `<button class="modal-cat-btn" data-cat="${cat.id}" style="border-color:${cat.color}">
      <span class="modal-cat-num" style="background:${numBg};color:${cat.color}">${cat.num}</span>
      <span class="modal-cat-label" style="color:${cat.color}">${cat.label.replace('\n','<br>')}</span>
    </button>`;
  }).join('') + (showClear ? `<button class="modal-clear-btn" data-cat="">✕ クリア（未記録）</button>` : '');

  grid.querySelectorAll('[data-cat]').forEach(btn => {
    btn.addEventListener('click', () => {
      const catId = btn.dataset.cat || null;
      closeModal();
      if (pendingSlot) {
        assignSlot(pendingSlot.slotStart, pendingSlot.slotEnd, catId);
        pendingSlot = null; renderTimeline();
      } else {
        if (catId) enterPaintMode(catId);
      }
    });
  });
  document.getElementById('modal-cat').style.display = 'flex';
}

function closeModal() { document.getElementById('modal-cat').style.display = 'none'; pendingSlot = null; }

function renderSummary(sess) {
  const slots   = buildSlots(sess);
  const summary = summarise(slots);
  const entries = Object.entries(summary).map(([id, mins]) => ({ id, mins, cat: CAT[id] }))
    .filter(e => e.cat).sort((a, b) => b.mins - a.mins);
  const totalMs   = sess.endTs - sess.startTs;
  const totalMins = slots.length * 15;
  const maxMins   = entries.length > 0 ? entries[0].mins : 1;
  const uncovered = slots.filter(s => !s.categoryId).length * 15;

  const rows = entries.map(e => {
    const pct = Math.round(e.mins / totalMins * 100);
    return `<tr>
      <td class="td-cat" style="color:${e.cat.color}">${e.cat.label.replace('\n',' ')}</td>
      <td class="td-bar"><div class="bar-wrap"><div class="bar-fill" style="width:${Math.round(e.mins/maxMins*100)}%;background:${e.cat.color}"></div></div></td>
      <td class="td-dur">${e.mins}分</td><td class="td-pct">${pct}%</td>
    </tr>`;
  }).join('') + (uncovered > 0
    ? `<tr><td class="td-cat" style="color:var(--muted)">（未記録）</td><td class="td-bar"></td><td class="td-dur" style="color:var(--muted)">${uncovered}分</td><td class="td-pct"></td></tr>`
    : '');

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
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderHistory() {
  const list = document.getElementById('history-list');
  if (sessions.length === 0) { list.innerHTML = '<div class="empty-state">📭 記録がまだありません</div>'; return; }
  list.innerHTML = [...sessions].reverse().map(sess => {
    const slots = buildSlots(sess);
    const chips = Object.entries(summarise(slots)).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([id,mins]) => {
      const cat = CAT[id];
      return cat ? `<span class="hist-chip" style="background:${cat.color}">${cat.label.replace('\n',' ')} ${mins}分</span>` : '';
    }).join('');
    return `<div class="hist-item">
      <div class="hist-top"><span class="hist-name">${sess.workerName}</span><span class="hist-meta">${sess.employeeCode} ／ ${fmtDate(sess.date)}</span></div>
      <div class="hist-range">${hhmm(sess.startTs)} 〜 ${hhmm(sess.endTs)}（${fmtDur(sess.endTs - sess.startTs)}）</div>
      <div class="hist-chips">${chips}</div>
    </div>`;
  }).join('');
}

function renderEmployeeList() {
  const list = document.getElementById('employee-list');
  const keys = Object.keys(employees).sort();
  if (keys.length === 0) { list.innerHTML = '<div style="color:var(--muted);font-size:14px;padding:8px 4px">登録された社員がいません</div>'; return; }
  list.innerHTML = keys.map(code => `
    <div class="emp-row">
      <span class="emp-code">${code}</span>
      <span class="emp-name">${employees[code]}</span>
      <button class="btn-del-emp" data-code="${code}">✕</button>
    </div>`).join('');
  list.querySelectorAll('.btn-del-emp').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm(`${btn.dataset.code} を削除しますか？`)) return;
      delete employees[btn.dataset.code]; persist(); renderEmployeeList();
    });
  });
}

function exportCSV() {
  if (sessions.length === 0) { alert('記録がありません'); return; }
  const rows = [['日付','社員コード','氏名','開始','終了','作業内容','時間（分）']];
  for (const sess of sessions) {
    for (const [id, mins] of Object.entries(summarise(buildSlots(sess)))) {
      const cat = CAT[id];
      rows.push([sess.date, sess.employeeCode, sess.workerName, hhmm(sess.startTs), hhmm(sess.endTs), cat ? cat.label.replace('\n',' ') : id, mins]);
    }
  }
  const csv  = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: `作業記録_${new Date().toISOString().slice(0,10)}.csv` }).click();
  URL.revokeObjectURL(url);
}

let toastTid = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.style.display = 'block'; el.style.animation = 'toastIn .25s ease';
  if (toastTid) clearTimeout(toastTid);
  toastTid = setTimeout(() => { el.style.animation = 'toastOut .3s ease forwards'; setTimeout(() => { el.style.display = 'none'; }, 300); }, 1800);
}

function setupEvents() {
  document.querySelectorAll('.np-btn[data-n]').forEach(btn => btn.addEventListener('click', () => numpadPress(btn.dataset.n)));
  document.getElementById('np-del').addEventListener('click', numpadDelete);
  document.getElementById('np-clr').addEventListener('click', numpadClear);

  document.getElementById('btn-start-shift').addEventListener('click', () => {
    const code  = currentCode.trim();
    const date  = document.getElementById('work-date').value;
    const start = document.getElementById('start-time').value;
    const end   = document.getElementById('end-time').value;
    if (!code)               { showToast('社員コードを入力してください'); return; }
    if (!date||!start||!end) { showToast('日付・開始・終了時刻を入力してください'); return; }
    if (parseDateTime(date,end) <= parseDateTime(date,start)) { showToast('終了は開始より後の時刻にしてください'); return; }
    startShift(code, employees[code] || code + ' さん', date, start, end);
    refreshHeader(); renderTimeline(); startClock(); showScreen('screen-main');
    currentCode = ''; updateCodeDisplay();
  });

  document.getElementById('btn-show-history').addEventListener('click', () => { renderHistory(); showScreen('screen-history'); });
  document.getElementById('btn-goto-admin').addEventListener('click', () => { renderEmployeeList(); showScreen('screen-admin'); });

  document.getElementById('btn-bulk').addEventListener('click', () => { exitPaintMode(); openCatModal('一括入力：作業を選んでください', false); });
  document.getElementById('btn-clr-all').addEventListener('click', () => {
    if (!confirm('全スロットをクリアしますか？')) return;
    session.entries = []; persist(); renderTimeline();
  });
  document.getElementById('btn-paint-done').addEventListener('click', exitPaintMode);
  document.getElementById('btn-finish').addEventListener('click', () => { if (!session) return; renderSummary(session); showScreen('screen-summary'); });

  document.getElementById('btn-back-to-main').addEventListener('click', () => { renderTimeline(); showScreen('screen-main'); });
  document.getElementById('btn-save-finish').addEventListener('click', () => { saveShift(); stopClock(); showScreen('screen-login'); showToast('記録を保存しました'); });

  document.getElementById('btn-back-from-history').addEventListener('click', () => showScreen(session ? 'screen-main' : 'screen-login'));
  document.getElementById('btn-export').addEventListener('click', exportCSV);

  document.getElementById('btn-back-admin').addEventListener('click', () => showScreen('screen-login'));
  document.getElementById('btn-add-emp').addEventListener('click', () => {
    const code = document.getElementById('admin-code').value.trim();
    const name = document.getElementById('admin-name').value.trim();
    if (!code || !name) { showToast('コードと氏名を入力してください'); return; }
    employees[code] = name; persist();
    document.getElementById('admin-code').value = '';
    document.getElementById('admin-name').value = '';
    renderEmployeeList(); showToast(`${code}：${name} を登録しました`);
  });

  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-backdrop').addEventListener('click', closeModal);
}

function init() {
  hydrate();
  const now = new Date();
  const rMin = Math.floor(now.getMinutes() / 15) * 15;
  const today = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  document.getElementById('work-date').value  = today;
  document.getElementById('start-time').value = `${pad(now.getHours())}:${pad(rMin)}`;
  document.getElementById('end-time').value   = `${pad(now.getHours())}:${pad(rMin)}`;
  setupEvents(); updateCodeDisplay();
  if (session) { refreshHeader(); renderTimeline(); startClock(); showScreen('screen-main'); }
  else { showScreen('screen-login'); }
}

document.addEventListener('DOMContentLoaded', init);
