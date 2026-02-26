// ── Persistence ───────────────────────────────────────────────────────────────
let data = { tasks: [] };

async function load() {
  const resetToken = new URLSearchParams(location.search).get('token');
  if (resetToken) { showAuth(); showResetView(); return; }
  const token = localStorage.getItem('tt_token');
  if (!token) { showAuth(); return; }
  try {
    const r = await fetch('/data', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (r.status === 401) { localStorage.removeItem('tt_token'); showAuth(); return; }
    data = await r.json();
  } catch { data = { tasks: [] }; }
  showTracker();
  render();
  ensureTick();
}

const bc = new BroadcastChannel('tt');

bc.onmessage = e => {
  data = e.data;
  render();
  ensureTick();
};

function persist() {
  const token = localStorage.getItem('tt_token');
  if (!token) return;
  bc.postMessage(data);
  fetch('/data', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(data)
  }).then(r => {
    if (r.status === 401) { localStorage.removeItem('tt_token'); showAuth(); }
  }).catch(() => {});
}

// ── Auth ──────────────────────────────────────────────────────────────────────
let authMode = 'login';
let googleClientId = null;
let googleButtonRendered = false;

async function loadGoogleAuth() {
  try {
    const r = await fetch('/auth/google/client-id');
    const { client_id } = await r.json();
    if (!client_id) return;
    googleClientId = client_id;
    initGoogleButton();
  } catch {}
}

function initGoogleButton() {
  if (!googleClientId || !window.google?.accounts?.id || googleButtonRendered) return;
  const container = document.getElementById('google-btn');
  const width = Math.min(container.offsetWidth || 400, 400);
  google.accounts.id.initialize({ client_id: googleClientId, callback: handleGoogleCredential });
  google.accounts.id.renderButton(container, { theme: 'outline', size: 'large', width });
  googleButtonRendered = true;
}

async function handleGoogleCredential(response) {
  const errorEl = document.getElementById('auth-error');
  errorEl.textContent = '';
  try {
    const r = await fetch('/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential })
    });
    const body = await r.json();
    if (!r.ok) { errorEl.textContent = body.detail || 'error'; return; }
    localStorage.setItem('tt_token', body.token);
    data = { tasks: [] };
    await load();
  } catch {
    errorEl.textContent = 'network error';
  }
}

function showLoginView() {
  document.getElementById('auth-login-view').style.display = 'block';
  document.getElementById('auth-forgot-view').style.display = 'none';
  document.getElementById('auth-reset-view').style.display = 'none';
  document.getElementById('auth-error').textContent = '';
  document.getElementById('auth-email').focus();
  initGoogleButton(); // no-op if already rendered or GIS not yet loaded
}

function showForgotView() {
  document.getElementById('auth-login-view').style.display = 'none';
  document.getElementById('auth-forgot-view').style.display = 'block';
  document.getElementById('auth-reset-view').style.display = 'none';
  document.getElementById('forgot-error').textContent = '';
  document.getElementById('forgot-email').focus();
}

function showResetView() {
  document.getElementById('auth-login-view').style.display = 'none';
  document.getElementById('auth-forgot-view').style.display = 'none';
  document.getElementById('auth-reset-view').style.display = 'block';
  document.getElementById('reset-error').textContent = '';
  document.getElementById('reset-password').focus();
}

function showAuth() {
  document.getElementById('auth-screen').style.display = 'block';
  document.getElementById('app').style.display = 'none';
  showLoginView();
}

function showTracker() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  searchEl.focus();
}

document.getElementById('auth-toggle').addEventListener('click', () => {
  authMode = authMode === 'login' ? 'signup' : 'login';
  document.getElementById('auth-submit').textContent = authMode === 'login' ? 'sign in' : 'sign up';
  document.getElementById('auth-toggle').textContent = authMode === 'login'
    ? 'no account? sign up'
    : 'have an account? sign in';
  document.getElementById('auth-error').textContent = '';
});

async function submitAuth() {
  const email    = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const errorEl  = document.getElementById('auth-error');
  errorEl.textContent = '';
  if (!email || !password) { errorEl.textContent = 'email and password required'; return; }
  try {
    const endpoint = authMode === 'login' ? '/auth/login' : '/auth/signup';
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const body = await r.json();
    if (!r.ok) { errorEl.textContent = body.detail || 'error'; return; }
    localStorage.setItem('tt_token', body.token);
    document.getElementById('auth-password').value = '';
    data = { tasks: [] };
    await load();
  } catch {
    errorEl.textContent = 'network error';
  }
}

document.getElementById('auth-submit').addEventListener('click', submitAuth);

document.getElementById('auth-email').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('auth-password').focus();
});

document.getElementById('auth-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitAuth();
});

document.getElementById('auth-forgot-link').addEventListener('click', showForgotView);
document.getElementById('forgot-back').addEventListener('click', showLoginView);

async function submitForgot() {
  const email   = document.getElementById('forgot-email').value.trim();
  const errorEl = document.getElementById('forgot-error');
  errorEl.textContent = '';
  if (!email) { errorEl.textContent = 'email required'; return; }
  try {
    await fetch('/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    errorEl.style.color = 'teal';
    errorEl.textContent = 'if that email exists, a reset link is on its way';
  } catch {
    errorEl.style.color = '';
    errorEl.textContent = 'network error';
  }
}

document.getElementById('forgot-submit').addEventListener('click', submitForgot);
document.getElementById('forgot-email').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitForgot();
});

async function submitReset() {
  const password = document.getElementById('reset-password').value;
  const errorEl  = document.getElementById('reset-error');
  errorEl.textContent = '';
  const token = new URLSearchParams(location.search).get('token');
  if (!token) { errorEl.textContent = 'missing reset token'; return; }
  try {
    const r = await fetch('/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password })
    });
    const body = await r.json();
    if (!r.ok) { errorEl.textContent = body.detail || 'error'; return; }
    history.replaceState(null, '', '/');
    errorEl.style.color = 'teal';
    errorEl.textContent = 'password updated — sign in';
    setTimeout(showLoginView, 1800);
  } catch {
    errorEl.style.color = '';
    errorEl.textContent = 'network error';
  }
}

document.getElementById('reset-submit').addEventListener('click', submitReset);
document.getElementById('reset-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitReset();
});

function logout() {
  const cur = runningTask();
  if (cur) {
    cur.sessions.find(s => !s.end).end = Date.now();
    persist();
  }
  if (ticker) { clearInterval(ticker); ticker = null; }
  localStorage.removeItem('tt_token');
  data = { tasks: [] };
  showAuth();
}

document.getElementById('hd-logout').addEventListener('click', logout);

// ── Helpers ───────────────────────────────────────────────────────────────────
const todayStr = () => new Date().toISOString().slice(0,10);
const isToday  = ts => new Date(ts).toISOString().slice(0,10) === todayStr();

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const x = s % 60;
  return `${h}:${String(m).padStart(2,'0')}:${String(x).padStart(2,'0')}`;
}

function fmtClock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function toTimeInput(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function fromTimeInput(timeStr, originalTs) {
  const [h, m] = timeStr.split(':').map(Number);
  const d = new Date(originalTs);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const taskTotalMs = t => t.sessions.reduce((a,s) => a + ((s.end ?? Date.now()) - s.start), 0);

const taskTodayMs = t => t.sessions
  .filter(s => isToday(s.start))
  .reduce((a,s) => a + ((s.end ?? Date.now()) - s.start), 0);

const allTodayMs = () => data.tasks.reduce((a,t) => a + taskTodayMs(t), 0);
const runningTask = () => data.tasks.find(t => t.sessions.some(s => !s.end)) ?? null;

function allWeekMs() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
  const mondayTs = monday.getTime();
  return data.tasks.reduce((total, t) =>
    total + t.sessions
      .filter(s => s.start >= mondayTs)
      .reduce((a, s) => a + ((s.end ?? Date.now()) - s.start), 0)
  , 0);
}

// ── Actions ───────────────────────────────────────────────────────────────────
function startTask(task) {
  const cur = runningTask();
  if (cur && cur.id !== task.id) {
    cur.sessions.find(s => !s.end).end = Date.now();
  }
  if (task.sessions.some(s => !s.end)) {
    task.sessions.find(s => !s.end).end = Date.now();
  } else {
    task.sessions.push({ start: Date.now(), end: null });
  }
  persist();
  render();
  ensureTick();
}

function deleteTask(id) {
  const task = data.tasks.find(t => t.id === id);
  if (!task) return;
  if (!confirm(`Delete "${task.name}" and all its history?`)) return;
  data.tasks = data.tasks.filter(t => t.id !== id);
  expanded.delete(id);
  persist();
  render();
}

function deleteSession(taskId, sessionStart) {
  const task = data.tasks.find(t => t.id === taskId);
  if (!task) return;
  if (!confirm('Delete this time entry?')) return;
  task.sessions = task.sessions.filter(s => s.start !== sessionStart);
  persist();
  render();
}

// ── Tick ──────────────────────────────────────────────────────────────────────
let ticker = null;

function ensureTick() {
  if (ticker || !runningTask()) return;
  ticker = setInterval(() => {
    if (!runningTask()) { clearInterval(ticker); ticker = null; }
    liveUpdate();
  }, 1000);
}

function fmtTabTimer(ms) {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function updateTabTitle() {
  const cur = runningTask();
  if (!cur) { document.title = 'Tikkit'; return; }
  const session = cur.sessions.find(s => !s.end);
  if (!session) { document.title = 'Tikkit'; return; }
  document.title = `${fmtTabTimer(Date.now() - session.start)} · ${cur.name} · Tikkit`;
}

function liveUpdate() {
  document.querySelectorAll('[data-live]').forEach(el => {
    const t = data.tasks.find(x => x.id === el.dataset.live);
    if (t) el.textContent = fmt(taskTodayMs(t));
  });
  document.querySelectorAll('[data-live-range]').forEach(el => {
    const s = JSON.parse(el.dataset.liveRange);
    el.textContent = fmt((Date.now()) - s);
  });
  const tot = document.getElementById('total-time');
  if (tot) tot.textContent = fmt(allTodayMs());
  const wk = document.getElementById('week-total-time');
  if (wk) wk.textContent = fmt(allWeekMs());
  updateTabTitle();
}

// ── State ─────────────────────────────────────────────────────────────────────
let selIdx  = -1;
const expanded     = new Set();
const expandedDays = new Set();

const searchEl   = document.getElementById('search');
const listEl     = document.getElementById('task-list');
const totalRow   = document.getElementById('total-row');
const totalTime  = document.getElementById('total-time');
const hdRunning  = document.getElementById('hd-running');
const hdDate     = document.getElementById('hd-date');
const historyEl  = document.getElementById('history');

hdDate.textContent = new Date().toLocaleDateString('en-US', {
  weekday: 'short', month: 'short', day: 'numeric'
}).toLowerCase();

function query()   { return searchEl.value.trim(); }
function queryLC() { return query().toLowerCase(); }

function filtered() {
  const q = queryLC();
  if (!q) return data.tasks.filter(t => taskTodayMs(t) > 0 || t.sessions.some(s => !s.end));
  return data.tasks.filter(t => t.name.toLowerCase().includes(q));
}

// ── History helpers ────────────────────────────────────────────────────────────
function weekPastDays() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
  const days = [];
  const d = new Date(monday);
  while (d < today) {
    days.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return days.reverse();
}

function dayTotalMs(dateStr) {
  return data.tasks.reduce((total, t) =>
    total + t.sessions
      .filter(s => s.end && new Date(s.start).toISOString().slice(0, 10) === dateStr)
      .reduce((a, s) => a + (s.end - s.start), 0)
  , 0);
}

function tasksForDay(dateStr) {
  return data.tasks
    .map(t => ({
      id: t.id,
      name: t.name,
      ms: t.sessions
        .filter(s => s.end && new Date(s.start).toISOString().slice(0, 10) === dateStr)
        .reduce((a, s) => a + (s.end - s.start), 0)
    }))
    .filter(t => t.ms > 0)
    .sort((a, b) => b.ms - a.ms);
}

function deleteTaskDay(taskId, dateStr) {
  const task = data.tasks.find(t => t.id === taskId);
  if (!task) return;
  if (!confirm(`Delete all "${task.name}" sessions for ${dateStr}?`)) return;
  task.sessions = task.sessions.filter(s =>
    new Date(s.start).toISOString().slice(0, 10) !== dateStr
  );
  persist();
  render();
}

function renderHistory() {
  const days = weekPastDays().filter(d => dayTotalMs(d) > 0);
  if (days.length === 0) { historyEl.innerHTML = ''; return; }

  const weekTotal = allWeekMs();

  historyEl.innerHTML = days.map(dateStr => {
    const isExp  = expandedDays.has(dateStr);
    const total  = dayTotalMs(dateStr);
    const d      = new Date(dateStr + 'T12:00:00');
    const name   = d.toLocaleDateString('en-US', { weekday: 'short' }).toLowerCase();
    const date   = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toLowerCase();
    const tasks  = isExp ? tasksForDay(dateStr) : [];

    return `
      <div class="day-row" data-date="${dateStr}">
        <span class="day-label"><span class="day-name">${name}</span> <span class="day-date">${date}</span></span>
        <span class="day-total">${fmt(total)}</span>
        <span class="day-chevron">${isExp ? '▲' : '▼'}</span>
      </div>
      ${isExp ? `<div class="day-tasks">${
        tasks.map(t => `
          <div class="day-task-row" data-task-id="${t.id}" data-date="${dateStr}">
            <span class="dt-name">${esc(t.name)}</span>
            <span class="dt-time">${fmt(t.ms)}</span>
            <button class="dt-del" tabindex="-1">✕</button>
          </div>`).join('')
      }</div>` : ''}
    `;
  }).join('') + `
    <div class="total-row week-total-row">
      <span class="total-label">week</span>
      <span class="total-time" id="week-total-time">${fmt(weekTotal)}</span>
    </div>
  `;
}

historyEl.addEventListener('click', e => {
  const dtDel = e.target.closest('.dt-del');
  if (dtDel) {
    const taskRow = dtDel.closest('.day-task-row');
    deleteTaskDay(taskRow.dataset.taskId, taskRow.dataset.date);
    return;
  }

  const taskRow = e.target.closest('.day-task-row');
  if (taskRow) {
    const task = data.tasks.find(t => t.id === taskRow.dataset.taskId);
    if (task) {
      startTask(task);
      searchEl.focus();
    }
    return;
  }

  const row = e.target.closest('.day-row');
  if (!row) return;
  const date = row.dataset.date;
  expandedDays.has(date) ? expandedDays.delete(date) : expandedDays.add(date);
  renderHistory();
});

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  const q      = query();
  const qLC    = q.toLowerCase();
  const tasks  = filtered();
  const running = runningTask();

  // clamp selection
  selIdx = Math.max(-1, Math.min(selIdx, tasks.length - 1));

  // header indicator
  hdRunning.classList.toggle('visible', !!running);

  listEl.innerHTML = '';

  // create hint
  const exactMatch = tasks.find(t => t.name.toLowerCase() === qLC);
  if (q && !exactMatch) {
    const li = document.createElement('li');
    li.className = 'create-hint';
    li.innerHTML = `↵ &nbsp;create <em>"${esc(q)}"</em>`;
    listEl.appendChild(li);
  }

  // empty state
  if (!q && tasks.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty-state';
    li.textContent = 'type a task name and press ↵ to begin';
    listEl.appendChild(li);
  }

  tasks.forEach((task, i) => {
    const isRunning  = task.sessions.some(s => !s.end);
    const isSel      = i === selIdx;
    const isExp      = expanded.has(task.id);
    const todaySess  = task.sessions.filter(s => isToday(s.start));
    const hasLog     = todaySess.length > 0;

    const li = document.createElement('li');
    li.className = ['task-row', isRunning ? 'running' : '', isSel ? 'selected' : ''].join(' ').trim();
    li.dataset.id = task.id;

    const sessionHTML = isExp && hasLog ? `
      <div class="session-log open">
        <div class="sl-date">today</div>
        ${todaySess.map(s => {
          const live = !s.end;
          const dur  = (s.end ?? Date.now()) - s.start;
          return `<div class="sl-entry${live ? ' live' : ' editable'}"
              data-task-id="${task.id}" data-session-start="${s.start}">
            <span class="sl-range">${fmtClock(s.start)} – ${live ? 'now' : fmtClock(s.end)}</span>
            <span class="sl-dur"${live ? ` data-live-range="${s.start}"` : ''}>${fmt(dur)}</span>
            ${live ? '' : `<button class="sl-del" tabindex="-1">✕</button>`}
          </div>`;
        }).join('')}
      </div>` : '';

    li.innerHTML = `
      <div class="task-main">
        <span class="t-dot"></span>
        <span class="t-name">${esc(task.name)}</span>
        <span class="t-time"${isRunning ? ` data-live="${task.id}"` : ''}>${fmt(taskTodayMs(task))}</span>
        <span class="t-expand">${hasLog ? (isExp ? '▲' : '▼') : ''}</span>
        <button class="t-del" data-id="${task.id}" tabindex="-1">✕</button>
      </div>
      ${sessionHTML}
    `;

    listEl.appendChild(li);
  });

  // total
  const hasData = data.tasks.some(t => t.sessions.some(s => isToday(s.start)));
  totalRow.style.display = hasData ? 'flex' : 'none';
  totalTime.textContent  = fmt(allTodayMs());

  renderHistory();
  ensureTick();
  updateTabTitle();
}

// ── Keyboard ──────────────────────────────────────────────────────────────────
searchEl.addEventListener('input', () => { selIdx = -1; render(); });

searchEl.addEventListener('blur', () => {
  searchEl.value = '';
  selIdx = -1;
  render();
});

searchEl.addEventListener('keydown', e => {
  const tasks = filtered();
  const q     = query();

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selIdx = Math.min(selIdx + 1, tasks.length - 1);
    render();

  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selIdx = Math.max(selIdx - 1, -1);
    render();

  } else if (e.key === 'Tab') {
    e.preventDefault();
    const idx  = selIdx >= 0 ? selIdx : 0;
    const task = tasks[idx];
    if (task) {
      expanded.has(task.id) ? expanded.delete(task.id) : expanded.add(task.id);
      render();
    }

  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (!q && selIdx < 0) return;

    let task;
    if (selIdx >= 0) {
      task = tasks[selIdx];
    } else if (tasks.length > 0) {
      const exact = tasks.find(t => t.name.toLowerCase() === q.toLowerCase());
      task = exact ?? tasks[0];
    }

    if (!task && q) {
      task = { id: crypto.randomUUID(), name: q, sessions: [] };
      data.tasks.unshift(task);
    }

    if (task) {
      startTask(task);
      searchEl.value = '';
      selIdx = -1;
      render();
    }
  }
});

// ── Inline session editing ─────────────────────────────────────────────────────
function beginEditSession(entry, taskId, sessionStart) {
  const task = data.tasks.find(t => t.id === taskId);
  const session = task?.sessions.find(s => s.start === sessionStart);
  if (!session || !session.end) return;

  const rangeEl = entry.querySelector('.sl-range');
  rangeEl.innerHTML = `
    <input class="sl-time-input" type="time" value="${toTimeInput(session.start)}" data-role="start">
    <span class="sl-dash"> – </span>
    <input class="sl-time-input" type="time" value="${toTimeInput(session.end)}" data-role="end">
  `;
  rangeEl.querySelector('[data-role="start"]').focus();

  let saved = false;
  function save() {
    if (saved) return;
    saved = true;
    const startInput = rangeEl.querySelector('[data-role="start"]');
    const endInput   = rangeEl.querySelector('[data-role="end"]');
    if (!startInput || !endInput) return;
    const newStart = fromTimeInput(startInput.value, session.start);
    const newEnd   = fromTimeInput(endInput.value,   session.end);
    if (newEnd > newStart) {
      session.start = newStart;
      session.end   = newEnd;
      persist();
    }
    render();
  }

  entry.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!entry.contains(document.activeElement)) save();
    }, 0);
  });

  entry.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); e.stopPropagation(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); render(); }
  });
}

// ── Click ─────────────────────────────────────────────────────────────────────
listEl.addEventListener('click', e => {
  const slRange = e.target.closest('.sl-range');
  if (slRange && slRange.closest('.sl-entry.editable')) {
    const entry = slRange.closest('.sl-entry');
    if (!entry.querySelector('.sl-time-input')) {
      beginEditSession(entry, entry.dataset.taskId, parseInt(entry.dataset.sessionStart));
    }
    return;
  }

  const slDel = e.target.closest('.sl-del');
  if (slDel) {
    const entry = slDel.closest('.sl-entry');
    deleteSession(entry.dataset.taskId, parseInt(entry.dataset.sessionStart));
    return;
  }

  const delBtn = e.target.closest('.t-del');
  if (delBtn) { deleteTask(delBtn.dataset.id); return; }

  const expandBtn = e.target.closest('.t-expand');
  if (expandBtn) {
    const row  = expandBtn.closest('.task-row');
    const task = data.tasks.find(t => t.id === row?.dataset.id);
    if (task) {
      expanded.has(task.id) ? expanded.delete(task.id) : expanded.add(task.id);
      render();
    }
    return;
  }

  const main = e.target.closest('.task-main');
  if (main) {
    const row  = main.closest('.task-row');
    const task = data.tasks.find(t => t.id === row?.dataset.id);
    if (task) startTask(task);
  }
});

// ── Global shortcuts ──────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'n' && document.activeElement === document.body) {
    e.preventDefault();
    searchEl.focus();
    return;
  }
  if (e.key !== 'Escape') return;
  if (searchEl.value) {
    searchEl.blur(); // blur handler clears text and resets state
  } else {
    const cur = runningTask();
    if (cur) {
      cur.sessions.find(s => !s.end).end = Date.now();
      persist();
      render();
    }
    searchEl.blur();
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
window.onGoogleLibraryLoad = initGoogleButton; // fires when GIS script finishes loading
loadGoogleAuth();                               // fetches client_id from backend
load();
