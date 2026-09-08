// ── Theme ─────────────────────────────────────────────────────────────────────
const THEME_KEY = 'tt_theme';
const THEME_CYCLE = ['light', 'dark', 'system'];

const THEME_ICONS = {
  system: '<span data-icon="system" class="theme-system"><span class="theme-os-label">OS</span><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" /></svg></span>',
  light:  '<svg data-icon="light" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z" /></svg>',
  dark:   '<svg data-icon="dark" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" /></svg>',
};

function applyTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const theme = saved || 'light';
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.innerHTML = THEME_ICONS[theme];
}

function cycleTheme() {
  const current = localStorage.getItem(THEME_KEY) || 'light';
  const idx = THEME_CYCLE.indexOf(current);
  const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
  if (next === 'light') {
    localStorage.removeItem(THEME_KEY);
  } else {
    localStorage.setItem(THEME_KEY, next);
  }
  applyTheme();
  persistTheme();
}

function persistTheme() {
  const token = localStorage.getItem('tt_token');
  if (!token) return;
  const theme = localStorage.getItem(THEME_KEY) || null;
  fetch('/preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ theme }),
  }).catch(() => {});
}

applyTheme();

// ── Shared view ──────────────────────────────────────────────────────────────
const SHARED_MATCH = location.pathname.match(/^\/shared\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
const SHARED_TOKEN = SHARED_MATCH ? SHARED_MATCH[1] : null;
const IS_SHARED = !!SHARED_TOKEN;

// ── Per-tag timesheet ────────────────────────────────────────────────────────
const TIMESHEET_MATCH = location.pathname.match(/^\/timesheet\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
const TIMESHEET_TOKEN = TIMESHEET_MATCH ? TIMESHEET_MATCH[1] : null;
const IS_TIMESHEET = !!TIMESHEET_TOKEN;

// ── Persistence ───────────────────────────────────────────────────────────────
const GUEST_KEY        = 'tt_guest_tasks';
const GUEST_DONE_KEY   = 'tt_guest_done';
const GUEST_TRIAL_KEY  = 'tt_guest_trial_start';
const TAG_TIP_DISMISS_KEY = 'doingit_tag_tip_dismissals';
const TAG_TIP_DISMISS_KEY_LEGACY = 'doingit_project_tag_tip_dismissals';
const TAG_TIP_THRESHOLD   = 3;
const TAG_TIP_MAX_SHOWS   = 2;
const FREE_LIMIT       = 5;
const MAX_TAG_SUGGESTIONS = 6;
let data = { tasks: [], later: [], projects: [] };
/** While `confirm()` is open, blur has no meaningful relatedTarget — skip clearing the search draft. */
let suppressSearchBlurClear = false;

function normalizeTagName(name = '') {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

function ensureDataShape() {
  if (!data || typeof data !== 'object') data = {};
  if (!Array.isArray(data.tasks)) data.tasks = [];
  if (!Array.isArray(data.later)) data.later = [];
  if (!Array.isArray(data.projects)) data.projects = [];

  const byNormalized = new Map();
  data.projects.forEach(tagDef => {
    if (!tagDef || typeof tagDef !== 'object') return;
    const normalizedName = normalizeTagName(tagDef.normalizedName || tagDef.name || '');
    if (!normalizedName || byNormalized.has(normalizedName)) return;
    byNormalized.set(normalizedName, {
      id: tagDef.id || crypto.randomUUID(),
      name: normalizeTagName(tagDef.name || normalizedName),
      normalizedName,
      createdAt: tagDef.createdAt || Date.now(),
    });
  });
  data.projects = Array.from(byNormalized.values());

  const validTagIds = new Set(data.projects.map(t => t.id));
  data.tasks.forEach(task => {
    if (!Array.isArray(task.sessions)) task.sessions = [];
    if (!task.projectId || !validTagIds.has(task.projectId)) task.projectId = null;
  });
}

function getTagById(projectId) {
  if (!projectId) return null;
  return data.projects.find(t => t.id === projectId) || null;
}

function tagNameForTask(task) {
  return getTagById(task.projectId)?.name || null;
}

function taskLabel(task) {
  const tag = tagNameForTask(task);
  return tag ? `${task.name} #${tag}` : task.name;
}

function upsertTagByName(rawName) {
  const normalizedName = normalizeTagName(rawName);
  if (!normalizedName) return null;
  const existing = data.projects.find(t => t.normalizedName === normalizedName);
  if (existing) return existing.id;
  const tagDef = {
    id: crypto.randomUUID(),
    name: normalizedName,
    normalizedName,
    createdAt: Date.now(),
  };
  data.projects.push(tagDef);
  return tagDef.id;
}

function linkedTasksCount(projectId) {
  return data.tasks.filter(task => task.projectId === projectId).length;
}

function deleteTagById(projectId) {
  const tag = getTagById(projectId);
  if (!tag) return;
  const affected = linkedTasksCount(projectId);
  const suffix = affected
    ? ` ${affected} task${affected === 1 ? '' : 's'} will keep their history without a tag.`
    : '';
  const searchInput = document.getElementById('search');
  const searchSnapshot = searchInput ? searchInput.value : '';

  suppressSearchBlurClear = true;
  let confirmed = false;
  try {
    confirmed = confirm(`Delete tag "#${tag.name}"?${suffix}`);
  } finally {
    suppressSearchBlurClear = false;
  }

  if (!confirmed) {
    if (searchInput) {
      searchInput.value = searchSnapshot;
      searchInput.focus();
    }
    return;
  }

  data.projects = data.projects.filter(item => item.id !== projectId);
  data.tasks.forEach(task => {
    if (task.projectId === projectId) task.projectId = null;
  });

  if (searchInput) {
    const ctx = parseTagAutocompleteContext(searchSnapshot);
    // Back to “only task name”: drop the #… fragment after removing a tag from the list.
    searchInput.value = ctx ? (ctx.taskPart || '') : searchSnapshot;
    searchInput.focus();
  }
  persist();
}

function parseTaskInput(rawInput) {
  const input = (rawInput || '').trim();
  if (!input) return { taskName: '', tagName: null, hasTag: false };
  const match = input.match(/^(.*?)\s*#(.*)$/);
  if (!match) return { taskName: input, tagName: null, hasTag: false };
  const taskName = match[1].trim();
  const tagName = normalizeTagName(match[2] || '');
  if (!tagName) return { taskName, tagName: null, hasTag: false };
  return {
    taskName,
    tagName,
    hasTag: true,
  };
}

function parseTagAutocompleteContext(rawInput) {
  const input = rawInput || '';
  const match = input.match(/^(.*?)\s*#(.*)$/);
  if (!match) return null;
  return {
    taskPart: match[1].trim(),
    typedTag: normalizeTagName(match[2] || ''),
  };
}

let untaggedCreatesSinceLastTip = 0;
let tagTipOpen = false;
let tagTipOutsideBound = false;

function tagTipDismissCount() {
  let raw = localStorage.getItem(TAG_TIP_DISMISS_KEY);
  if (raw == null) {
    raw = localStorage.getItem(TAG_TIP_DISMISS_KEY_LEGACY);
    if (raw != null) {
      localStorage.setItem(TAG_TIP_DISMISS_KEY, raw);
      localStorage.removeItem(TAG_TIP_DISMISS_KEY_LEGACY);
    }
  }
  const n = parseInt(raw || '0', 10);
  return Number.isFinite(n) ? Math.min(TAG_TIP_MAX_SHOWS, Math.max(0, n)) : 0;
}

function noteUntaggedTaskCreated() {
  if (tagTipDismissCount() >= TAG_TIP_MAX_SHOWS) return;
  if (tagTipOpen) return;
  untaggedCreatesSinceLastTip += 1;
  if (untaggedCreatesSinceLastTip >= TAG_TIP_THRESHOLD) {
    tagTipOpen = true;
    untaggedCreatesSinceLastTip = 0;
  }
}

function tagTipOutsideHandler(e) {
  const tip = document.getElementById('tag-tip');
  const prompt = document.querySelector('.search-prompt');
  if (tip?.contains(e.target) || prompt?.contains(e.target)) return;
  dismissTagTip();
}

function dismissTagTip() {
  if (!tagTipOpen) return;
  tagTipOpen = false;
  const next = tagTipDismissCount() + 1;
  localStorage.setItem(TAG_TIP_DISMISS_KEY, String(next));
  syncTagTip();
}

/** User created a task with a #tag — hide tip and never show it again. */
function suppressTagTipUserLearned() {
  tagTipOpen = false;
  untaggedCreatesSinceLastTip = 0;
  localStorage.setItem(TAG_TIP_DISMISS_KEY, String(TAG_TIP_MAX_SHOWS));
  syncTagTip();
}

function syncTagTip() {
  const el = document.getElementById('tag-tip');
  if (!el) return;
  const dismissals = tagTipDismissCount();
  const show = tagTipOpen && dismissals < TAG_TIP_MAX_SHOWS;
  const textEl = el.querySelector('.tag-tip-text');
  if (show) {
    el.classList.add('visible');
    el.setAttribute('aria-hidden', 'false');
    if (textEl) {
      textEl.textContent = 'add a tag like this: task #work';
    }
    if (!tagTipOutsideBound) {
      document.addEventListener('mousedown', tagTipOutsideHandler, true);
      tagTipOutsideBound = true;
    }
  } else {
    el.classList.remove('visible');
    el.setAttribute('aria-hidden', 'true');
    if (tagTipOutsideBound) {
      document.removeEventListener('mousedown', tagTipOutsideHandler, true);
      tagTipOutsideBound = false;
    }
  }
}

function createOrFindTaskFromQuery(rawInput) {
  const parsed = parseTaskInput(rawInput);
  if (!parsed.taskName) return null;
  const projectId = parsed.hasTag ? upsertTagByName(parsed.tagName) : null;
  const existing = data.tasks.find(task =>
    task.name.toLowerCase() === parsed.taskName.toLowerCase() &&
    (task.projectId || null) === (projectId || null)
  );
  if (existing) return existing;
  const task = { id: crypto.randomUUID(), name: parsed.taskName, sessions: [], projectId };
  data.tasks.unshift(task);
  if (!projectId) noteUntaggedTaskCreated();
  else suppressTagTipUserLearned();
  return task;
}

// ── Billing state ─────────────────────────────────────────────────────────────
let subscriptionStatus = 'free';
let isComped = false;

async function load() {
  if (location.pathname === '/billing/success') {
    history.replaceState(null, '', '/');
    document.getElementById('billing-success-banner').style.display = 'flex';
  }

  const resetToken = new URLSearchParams(location.search).get('token');
  if (resetToken) { showAuth(); showResetView(); return; }
  const token = localStorage.getItem('tt_token');
  if (!token) {
    loadGuestData();
    showGuestMode();
    render();
    ensureTick();
    return;
  }
  try {
    const r = await fetch('/data', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (r.status === 401) {
      localStorage.removeItem('tt_token');
      loadGuestData(); showGuestMode(); render(); ensureTick();
      return;
    }
    data = await r.json();
    ensureDataShape();
    if (data.theme) {
      localStorage.setItem(THEME_KEY, data.theme);
    } else if (data.theme === null && localStorage.getItem(THEME_KEY)) {
      persistTheme();
    }
    applyTheme();
  } catch { data = { tasks: [], later: [], projects: [] }; }
  await fetchBillingStatus();
  showUserMode();
  hideAuth();
  render();
  ensureTick();
}

const bc = new BroadcastChannel('tt');

bc.onmessage = e => {
  data = e.data;
  ensureDataShape();
  render();
  ensureTick();
};

function persist() {
  if (IS_SHARED) return;
  const token = localStorage.getItem('tt_token');
  if (!token) {
    localStorage.setItem(GUEST_KEY, JSON.stringify(data));
    bc.postMessage(data);
    return;
  }
  bc.postMessage(data);
  fetch('/data', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(data)
  }).then(r => {
    if (r.status === 401) { localStorage.removeItem('tt_token'); loadGuestData(); showGuestMode(); }
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
    const guestRaw = localStorage.getItem(GUEST_KEY);
    if (guestRaw) {
      await fetch('/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${body.token}` },
        body: guestRaw
      });
      localStorage.removeItem(GUEST_KEY);
      data = JSON.parse(guestRaw);
      ensureDataShape();
      showUserMode();
      hideAuth();
      render();
      ensureTick();
      return;
    }
    data = { tasks: [], later: [], projects: [] };
    ensureDataShape();
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
  document.getElementById('auth-submit').textContent = authMode === 'login' ? 'sign in' : 'sign up';
  document.getElementById('auth-toggle').textContent = authMode === 'login'
    ? 'no account? sign up'
    : 'have an account? sign in';
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

function loadGuestData() {
  const raw = localStorage.getItem(GUEST_KEY);
  data = raw ? JSON.parse(raw) : { tasks: [], later: [], projects: [] };
  ensureDataShape();
}

function showGuestMode() {
  document.getElementById('guest-banner').style.display = 'block';
  document.getElementById('header-signin').style.display = '';
  document.getElementById('header-logout').style.display = 'none';
  document.getElementById('header-share').style.display = 'none';
  document.getElementById('theme-bar-sep').style.display = 'none';
  document.getElementById('theme-bar-sep2').style.display = 'none';
  subscriptionStatus = 'free';
  isComped = false;
  updateBillingUI();
}

function showUserMode() {
  document.getElementById('guest-banner').style.display = 'none';
  document.getElementById('header-signin').style.display = 'none';
  document.getElementById('header-logout').style.display = '';
  document.getElementById('header-share').style.display = '';
  document.getElementById('theme-bar-sep').style.display = '';
  document.getElementById('theme-bar-sep2').style.display = '';
  loadShareState();
  updateBillingUI();
}

async function fetchBillingStatus() {
  const token = localStorage.getItem('tt_token');
  if (!token) return;
  try {
    const r = await fetch('/billing/status', { headers: { 'Authorization': `Bearer ${token}` } });
    if (r.ok) {
      const s = await r.json();
      subscriptionStatus = s.subscription_status;
      isComped = s.is_comped;
    }
  } catch {}
  updateBillingUI();
}

function updateBillingUI() {
  const token = localStorage.getItem('tt_token');
  const subscribed = subscriptionStatus === 'active' || isComped;
  document.getElementById('header-upgrade').style.display = (token && !subscribed)           ? '' : 'none';
  document.getElementById('header-manage').style.display  = (token && subscribed && !isComped) ? '' : 'none';
  document.getElementById('header-vip').style.display     = (token && isComped)               ? '' : 'none';
}

function showUpgradeModal(message) {
  document.getElementById('upgrade-message').textContent =
    message || "You've reached your 5 free sessions for today.";
  document.getElementById('upgrade-modal').style.display = 'flex';
}

function hideUpgradeModal() {
  document.getElementById('upgrade-modal').style.display = 'none';
}

async function startCheckout() {
  const token = localStorage.getItem('tt_token');
  if (!token) {
    hideUpgradeModal();
    authMode = 'signup';
    showLoginView();
    showAuth();
    return;
  }
  try {
    const guestTrialStart = localStorage.getItem(GUEST_TRIAL_KEY);
    const body = guestTrialStart ? { guest_trial_start: parseInt(guestTrialStart) } : {};
    const r = await fetch('/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      const json = await r.json();
      window.location.href = json.url;
    }
  } catch {}
}

async function openBillingPortal() {
  const token = localStorage.getItem('tt_token');
  if (!token) return;
  try {
    const r = await fetch('/billing/portal', { headers: { 'Authorization': `Bearer ${token}` } });
    if (r.ok) {
      const json = await r.json();
      window.location.href = json.url;
    }
  } catch {}
}

async function canStartSession() {
  const token = localStorage.getItem('tt_token');
  if (token) {
    try {
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000));
      const r = await Promise.race([
        fetch('/sessions/start', { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } }),
        timeout,
      ]);
      if (r.status === 402) {
        const body = await r.json();
        showUpgradeModal(body.detail);
        return false;
      }
      return r.ok;
    } catch {
      return true; // network error or timeout: allow optimistically
    }
  } else {
    // Guest: client-side trial + rate limit
    let trialStart = localStorage.getItem(GUEST_TRIAL_KEY);
    if (!trialStart) {
      trialStart = Date.now();
      localStorage.setItem(GUEST_TRIAL_KEY, trialStart);
    }
    const withinTrial = Date.now() - parseInt(trialStart) < 30 * 24 * 60 * 60 * 1000;
    if (withinTrial) return true;
    const today = localDateStr();
    const todayCount = data.tasks.reduce((n, t) =>
      n + t.sessions.filter(s => localDateStr(new Date(s.start)) === today).length, 0);
    if (todayCount >= FREE_LIMIT) {
      showUpgradeModal("You've reached your 5 free sessions for today.");
      return false;
    }
    return true;
  }
}

function showAuth() {
  document.getElementById('auth-screen').style.display = '';
}

function hideAuth() {
  document.getElementById('auth-screen').style.display = 'none';
}

function showTracker() { hideAuth(); }

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
    console.log('[sync] authMode=', authMode, 'GUEST_KEY=', localStorage.getItem(GUEST_KEY));
    if (authMode === 'signup') {
      const guestRaw = localStorage.getItem(GUEST_KEY);
      if (guestRaw) {
        console.log('[sync] syncing guest tasks to server…');
        const syncRes = await fetch('/data', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${body.token}` },
          body: guestRaw
        });
        console.log('[sync] POST /data status=', syncRes.status);
        localStorage.removeItem(GUEST_KEY);
        data = JSON.parse(guestRaw);
        ensureDataShape();
        showUserMode();
        hideAuth();
        render();
        ensureTick();
        return;
      } else {
        console.log('[sync] no guest tasks in localStorage — skipping sync');
      }
    } else {
      console.log('[sync] authMode is not signup — skipping sync');
    }
    data = { tasks: [], later: [], projects: [] };
    ensureDataShape();
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
  const running = runningTasks();
  if (running.length) {
    const now = Date.now();
    running.forEach(t => { t.sessions.find(s => !s.end).end = now; });
    persist();
  }
  if (ticker) { clearInterval(ticker); ticker = null; }
  clearAllPomodoroTimers();
  localStorage.removeItem('tt_token');
  subscriptionStatus = 'free';
  isComped = false;
  loadGuestData();
  showGuestMode();
  render();
  ensureTick();
}

document.getElementById('header-logout').addEventListener('click', logout);

document.getElementById('guest-signup-btn').addEventListener('click', () => {
  authMode = 'signup'; showLoginView(); showAuth();
});

document.getElementById('header-signin').addEventListener('click', () => {
  authMode = 'login'; showLoginView(); showAuth();
});

document.getElementById('auth-close').addEventListener('click', hideAuth);

let _shareToken = null;
let _shareEnabled = false;

async function loadShareState() {
  const token = localStorage.getItem('tt_token');
  if (!token) return;
  try {
    const r = await fetch('/share/status', { headers: { 'Authorization': `Bearer ${token}` } });
    if (r.ok) {
      const s = await r.json();
      _shareEnabled = s.enabled;
      _shareToken = s.share_token || null;
    }
  } catch {}
  await loadTagShares();
}

// project id → share token, for the per-tag timesheet links
let _tagShares = new Map();

async function loadTagShares() {
  const token = localStorage.getItem('tt_token');
  if (!token) return;
  try {
    const r = await fetch('/share/tags', { headers: { 'Authorization': `Bearer ${token}` } });
    if (!r.ok) return;
    const { shares } = await r.json();
    _tagShares = new Map(shares.map(s => [s.project_id, s.token]));
  } catch {}
}

function timesheetUrl(shareToken) {
  return `${location.origin}/timesheet/${shareToken}`;
}

function renderTagShares() {
  const listEl = document.getElementById('share-tag-list');
  if (!listEl) return;
  const tags = [...data.projects].sort((a, b) => a.name.localeCompare(b.name));
  if (!tags.length) {
    listEl.innerHTML = '<div class="share-tag-empty">Tag a task with <code>#something</code> to share its timesheet.</div>';
    return;
  }
  listEl.innerHTML = tags.map(tag => {
    const shareToken = _tagShares.get(tag.id);
    const linkRow = shareToken ? `
      <div class="share-popover-link-row">
        <input class="share-popover-url" value="${esc(timesheetUrl(shareToken))}" readonly>
        <button class="share-popover-copy" data-copy-tag="${esc(tag.id)}">Copy</button>
      </div>` : '';
    return `
      <div class="share-tag-item" data-tag-id="${esc(tag.id)}">
        <div class="share-popover-row">
          <span class="share-tag-name">#${esc(tag.name)}</span>
          <button class="share-popover-toggle share-tag-toggle${shareToken ? ' active' : ''}" data-toggle-tag="${esc(tag.id)}">${shareToken ? 'Disable' : 'Enable'}</button>
        </div>
        ${linkRow}
      </div>`;
  }).join('');
}

async function toggleTagShare(projectId) {
  const token = localStorage.getItem('tt_token');
  if (!token) return;
  const enabled = _tagShares.has(projectId);
  const path = `/share/tags/${encodeURIComponent(projectId)}/${enabled ? 'disable' : 'enable'}`;
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
    if (!r.ok) return;
    if (enabled) {
      _tagShares.delete(projectId);
    } else {
      _tagShares.set(projectId, (await r.json()).token);
    }
    renderTagShares();
  } catch {}
}

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const tmp = document.createElement('textarea');
    tmp.value = text;
    document.body.appendChild(tmp);
    tmp.select();
    document.execCommand('copy');
    tmp.remove();
  }
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
}

function updateSharePopover() {
  const popover = document.getElementById('share-popover');
  const toggleBtn = document.getElementById('share-toggle');
  const linkRow = document.getElementById('share-link-row');
  const urlInput = document.getElementById('share-url');

  if (_shareEnabled && _shareToken) {
    toggleBtn.textContent = 'Disable';
    toggleBtn.classList.add('active');
    linkRow.style.display = 'flex';
    urlInput.value = `${location.origin}/shared/${_shareToken}`;
  } else {
    toggleBtn.textContent = 'Enable';
    toggleBtn.classList.remove('active');
    linkRow.style.display = 'none';
  }
  renderTagShares();
}

document.getElementById('header-share').addEventListener('click', () => {
  const popover = document.getElementById('share-popover');
  const visible = popover.style.display !== 'none';
  popover.style.display = visible ? 'none' : 'block';
  if (!visible) updateSharePopover();
});

document.getElementById('share-toggle').addEventListener('click', async () => {
  const token = localStorage.getItem('tt_token');
  if (!token) return;
  try {
    if (!_shareEnabled) {
      const r = await fetch('/share/enable', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!r.ok) return;
      const { share_token } = await r.json();
      _shareToken = share_token;
      _shareEnabled = true;
    } else {
      const r = await fetch('/share/disable', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!r.ok) return;
      _shareEnabled = false;
    }
    updateSharePopover();
  } catch {}
});

document.getElementById('share-copy').addEventListener('click', async () => {
  const urlInput = document.getElementById('share-url');
  try {
    await navigator.clipboard.writeText(urlInput.value);
  } catch {
    urlInput.select();
    document.execCommand('copy');
  }
  const btn = document.getElementById('share-copy');
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
});

document.getElementById('share-tag-list').addEventListener('click', e => {
  const toggle = e.target.closest('[data-toggle-tag]');
  if (toggle) { toggleTagShare(toggle.dataset.toggleTag); return; }
  const copy = e.target.closest('[data-copy-tag]');
  if (copy) {
    const url = copy.closest('.share-popover-link-row').querySelector('.share-popover-url').value;
    copyToClipboard(url, copy);
  }
});

// Close popover when clicking outside
document.addEventListener('click', e => {
  const popover = document.getElementById('share-popover');
  const shareBtn = document.getElementById('header-share');
  if (popover.style.display !== 'none' && !popover.contains(e.target) && e.target !== shareBtn) {
    popover.style.display = 'none';
  }
});

// ── Pomodoro ──────────────────────────────────────────────────────────────────
let pomodoroActive = localStorage.getItem('tt_pomodoro_active') === 'true';
const pomodoroTimers = new Map(); // task id → timeout handle, one per running task

const pomodoroBtn  = document.getElementById('header-pomodoro');
const pomodoroMins = document.getElementById('header-pomodoro-mins');
pomodoroBtn.classList.toggle('active', pomodoroActive);

// Persist the minutes value across sessions
pomodoroMins.value = localStorage.getItem('tt_pomodoro_mins') ?? '25';
pomodoroMins.addEventListener('change', () => {
  const v = Math.min(60, Math.max(1, parseInt(pomodoroMins.value) || 25));
  pomodoroMins.value = v;
  localStorage.setItem('tt_pomodoro_mins', v);
});

pomodoroBtn.addEventListener('click', () => {
  pomodoroActive = !pomodoroActive;
  localStorage.setItem('tt_pomodoro_active', pomodoroActive);
  pomodoroBtn.classList.toggle('active', pomodoroActive);
  if (pomodoroActive) {
    getAudioCtx().resume(); // warm up while we have a user gesture
    if (Notification.permission === 'default') Notification.requestPermission();
    // If tasks are already running, arm each from its current session start
    for (const running of runningTasks()) {
      const session = running.sessions.find(s => !s.end);
      if (session) armPomodoroTimer(running.id, taskLabel(running), session.start);
    }
  } else {
    clearAllPomodoroTimers();
  }
});

function clearPomodoroTimer(taskId) {
  const handle = pomodoroTimers.get(taskId);
  if (handle) { clearTimeout(handle); pomodoroTimers.delete(taskId); }
  pomodoroBtn.classList.remove('ringing');
}

function clearAllPomodoroTimers() {
  pomodoroTimers.forEach(handle => clearTimeout(handle));
  pomodoroTimers.clear();
  pomodoroBtn.classList.remove('ringing');
}

let _audioCtx = null;

function getAudioCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _audioCtx;
}

function playPomodoroChime() {
  try {
    const ctx = getAudioCtx();
    ctx.resume().then(() => {
      function ding(freq, delay, dur, vol = 0.35) {
        const t = ctx.currentTime + delay;
        [freq, freq * 2.4].forEach((f, i) => {
          const osc  = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.type = 'sine';
          osc.frequency.value = f;
          gain.gain.setValueAtTime(0, t);
          gain.gain.linearRampToValueAtTime(i === 0 ? vol : vol * 0.3, t + 0.006);
          gain.gain.exponentialRampToValueAtTime(0.001, t + (i === 0 ? dur : dur * 0.5));
          osc.start(t);
          osc.stop(t + dur);
        });
      }
      ding(784,  0,   1.8); // G5
      ding(1047, 0.3, 1.5); // C6 — perfect fourth, classic bell interval
    });
  } catch {}
}

function armPomodoroTimer(taskId, taskName, sessionStart) {
  clearPomodoroTimer(taskId);
  if (!pomodoroActive) return;
  const totalMs   = (parseInt(pomodoroMins.value) || 25) * 60 * 1000;
  const remaining = totalMs - (Date.now() - sessionStart);
  if (remaining <= 0) return; // session already exceeded pomodoro duration
  pomodoroTimers.set(taskId, setTimeout(() => {
    pomodoroTimers.delete(taskId);
    playPomodoroChime();
    // In-app: bounce the tomato
    pomodoroBtn.classList.remove('ringing');
    void pomodoroBtn.offsetWidth; // reflow to restart animation
    pomodoroBtn.classList.add('ringing');
    pomodoroBtn.addEventListener('animationend', () => pomodoroBtn.classList.remove('ringing'), { once: true });
    // Browser notification
    if (Notification.permission === 'granted') {
      new Notification('Doing It — pomodoro done 🍅', { body: `Time to stop "${taskName}" and take a break.` });
    }
  }, remaining));
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
const todayStr = () => localDateStr();
const isToday  = ts => localDateStr(new Date(ts)) === todayStr();

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

function toDateInput(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function fromDateTimeInput(dateStr, timeStr) {
  const [y, mo, da] = dateStr.split('-').map(Number);
  const [h, m] = timeStr.split(':').map(Number);
  return new Date(y, mo - 1, da, h, m, 0, 0).getTime();
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function linkify(s) {
  return esc(s).replace(/(https?:\/\/[^\s<>&"]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

const taskTotalMs = t => t.sessions.reduce((a,s) => a + ((s.end ?? Date.now()) - s.start), 0);

const taskTodayMs = t => t.sessions
  .filter(s => isToday(s.start))
  .reduce((a,s) => a + ((s.end ?? Date.now()) - s.start), 0);

const allTodayMs = () => data.tasks.reduce((a,t) => a + taskTodayMs(t), 0);
const netTodayMs = () => mergedIntervalsMs(data.tasks.flatMap(t => t.sessions
  .filter(s => isToday(s.start))
  .map(s => [s.start, s.end ?? Date.now()])));
const runningTasks = () => data.tasks.filter(t => t.sessions.some(s => !s.end));
const runningTask  = () => runningTasks()[0] ?? null;

function weekStartTs() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
  return monday.getTime();
}

function allWeekMs() {
  const mondayTs = weekStartTs();
  return data.tasks.reduce((total, t) =>
    total + t.sessions
      .filter(s => s.start >= mondayTs)
      .reduce((a, s) => a + ((s.end ?? Date.now()) - s.start), 0)
  , 0);
}

function netWeekMs() {
  const mondayTs = weekStartTs();
  return mergedIntervalsMs(data.tasks.flatMap(t => t.sessions
    .filter(s => s.start >= mondayTs)
    .map(s => [s.start, s.end ?? Date.now()])));
}

// "· net H:MM:SS" suffix for aggregate rows — empty unless parallel sessions
// made the net (overlap counted once) smaller than the plain sum
function netSuffixHTML(totalMs, netMs, id = '') {
  if (netMs >= totalMs) return '';
  return ` <span class="t-time-sep">·</span> <span class="t-time-label">net</span> <span class="net-time"${id ? ` id="${id}"` : ''}>${fmt(netMs)}</span>`;
}

// ── Actions ───────────────────────────────────────────────────────────────────
let _startingTask = false;
async function startTask(task, { parallel = false } = {}) {
  if (IS_SHARED || _startingTask) return;
  _startingTask = true;
  try {
  const isRunning = task.sessions.some(s => !s.end);

  if (!isRunning) {
    const allowed = await canStartSession();
    if (!allowed) return;
  }

  // Plain start switches tasks; a parallel start leaves other tasks running
  if (!parallel) {
    for (const cur of runningTasks()) {
      if (cur.id === task.id) continue;
      cur.sessions.find(s => !s.end).end = Date.now();
      clearPomodoroTimer(cur.id);
    }
  }
  if (isRunning) {
    task.sessions.find(s => !s.end).end = Date.now();
    clearPomodoroTimer(task.id);
  } else {
    const sessionStart = Date.now();
    task.sessions.push({ start: sessionStart, end: null });
    armPomodoroTimer(task.id, taskLabel(task), sessionStart);
  }
  persist();
  render();
  ensureTick();
  } finally {
    _startingTask = false;
  }
}

function deleteTask(id) {
  if (IS_SHARED) return;
  const task = data.tasks.find(t => t.id === id);
  if (!task) return;
  if (!confirm(`Delete "${taskLabel(task)}" and all its history?`)) return;
  data.tasks = data.tasks.filter(t => t.id !== id);
  expanded.delete(id);
  persist();
  render();
}

function deleteSession(taskId, sessionStart) {
  if (IS_SHARED) return;
  const task = data.tasks.find(t => t.id === taskId);
  if (!task) return;
  if (!confirm('Delete this time entry?')) return;
  task.sessions = task.sessions.filter(s => s.start !== sessionStart);
  persist();
  render();
}

function moveSession(fromTaskId, sessionStart, toTaskId) {
  const fromTask = data.tasks.find(t => t.id === fromTaskId);
  const toTask   = data.tasks.find(t => t.id === toTaskId);
  if (!fromTask || !toTask) return;
  const idx = fromTask.sessions.findIndex(s => s.start === sessionStart);
  if (idx === -1) return;
  const session = fromTask.sessions[idx];
  toTask.sessions.push({ start: session.start, end: session.end });
  fromTask.sessions.splice(idx, 1);
  expanded.add(toTaskId);
  persist();
  render();
}

let _moveDropdown = null;
let _moveBackdrop = null;

function closeMoveDropdown() {
  if (_moveDropdown) { _moveDropdown.remove(); _moveDropdown = null; }
  if (_moveBackdrop) { _moveBackdrop.remove(); _moveBackdrop = null; }
}

function showMoveDropdown(trigger, fromTaskId, sessionStart) {
  closeMoveDropdown();

  const tasks = data.tasks
    .filter(t => t.id !== fromTaskId)
    .sort((a, b) => {
      const aLast = a.sessions.length ? Math.max(...a.sessions.map(s => s.start)) : 0;
      const bLast = b.sessions.length ? Math.max(...b.sessions.map(s => s.start)) : 0;
      return bLast - aLast;
    });
  if (!tasks.length) return;

  // Invisible backdrop catches clicks outside the dropdown
  const backdrop = document.createElement('div');
  backdrop.className = 'sl-move-backdrop';
  backdrop.addEventListener('click', () => closeMoveDropdown());
  document.body.appendChild(backdrop);
  _moveBackdrop = backdrop;

  const dd = document.createElement('div');
  dd.className = 'sl-move-dropdown';
  dd.innerHTML = tasks.map(t =>
    `<div class="sl-move-option" data-task-id="${t.id}">${esc(t.name)}</div>`
  ).join('');
  document.body.appendChild(dd);
  _moveDropdown = dd;

  const rect = trigger.getBoundingClientRect();
  const ddRect = dd.getBoundingClientRect();
  let top = rect.bottom + 4;
  if (top + ddRect.height > window.innerHeight - 8) {
    top = rect.top - ddRect.height - 4;
  }
  dd.style.top  = `${top}px`;
  dd.style.right = `${window.innerWidth - rect.right}px`;

  dd.addEventListener('click', e => {
    const opt = e.target.closest('.sl-move-option');
    if (!opt) return;
    closeMoveDropdown();
    moveSession(fromTaskId, sessionStart, opt.dataset.taskId);
  });
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
  const running = runningTasks()
    .map(t => ({ task: t, start: t.sessions.find(s => !s.end)?.start }))
    .filter(r => r.start != null)
    .sort((a, b) => a.start - b.start);
  if (!running.length) { document.title = 'Doing It'; return; }
  const extra = running.length > 1 ? ` +${running.length - 1}` : '';
  document.title = `${fmtTabTimer(Date.now() - running[0].start)} · ${taskLabel(running[0].task)}${extra} · Doing It`;
}

function liveUpdate() {
  document.querySelectorAll('[data-live]').forEach(el => {
    const t = data.tasks.find(x => x.id === el.dataset.live);
    if (t) el.textContent = fmt(taskTodayMs(t));
  });
  document.querySelectorAll('[data-live-session]').forEach(el => {
    el.textContent = fmt(Date.now() - parseInt(el.dataset.liveSession));
  });
  document.querySelectorAll('[data-live-range]').forEach(el => {
    const s = JSON.parse(el.dataset.liveRange);
    el.textContent = fmt((Date.now()) - s);
  });
  const tot = document.getElementById('total-time');
  if (tot) tot.textContent = fmt(allTodayMs());
  const totNet = document.getElementById('total-net-time');
  if (totNet) totNet.textContent = fmt(netTodayMs());
  const wk = document.getElementById('week-total-time');
  if (wk) wk.textContent = fmt(allWeekMs());
  const wkNet = document.getElementById('week-net-time');
  if (wkNet) wkNet.textContent = fmt(netWeekMs());
  updateTabTitle();
}

// ── State ─────────────────────────────────────────────────────────────────────
let selIdx  = -1;
let navIdx  = -1;   // keyboard navigation index (-1 = inactive)
let tasksVisible = localStorage.getItem('tt_tasks_visible') !== 'false';
let weekVisible  = localStorage.getItem('tt_week_visible')  !== 'false';
const expanded         = new Set();
const expandedDays     = new Set();
const expandedDayTasks = new Set();
let   laterVisible     = localStorage.getItem('tt_later_visible') !== 'false';

// ── Keyboard navigation ───────────────────────────────────────────────────────
function navItems() {
  const items = [];
  items.push({ type: 'today' });
  const tasks = filtered();
  const listShown = tasksVisible || !!query();
  if (listShown) {
    tasks.forEach(t => items.push({ type: 'task', taskId: t.id }));
  }
  const days = weekPastDays().filter(d => dayTotalMs(d) > 0);
  if (days.length > 0) {
    items.push({ type: 'week' });
    if (weekVisible) {
      days.forEach(dateStr => {
        items.push({ type: 'day', date: dateStr });
        if (expandedDays.has(dateStr)) {
          tasksForDay(dateStr).forEach(t => {
            items.push({ type: 'day-task', date: dateStr, taskId: t.id });
          });
        }
      });
    }
  }
  items.push({ type: 'later' });
  if (laterVisible) {
    items.push({ type: 'later-input' });
    if (data.later && data.later.length > 0) {
      [...data.later].reverse().forEach(item => {
        items.push({ type: 'later-item', id: item.id });
      });
    }
  }
  return items;
}

function activeNavItem() {
  if (navIdx < 0) return null;
  const items = navItems();
  return navIdx < items.length ? items[navIdx] : null;
}

function navToggle(item) {
  if (item.type === 'today') {
    tasksVisible = !tasksVisible;
    localStorage.setItem('tt_tasks_visible', tasksVisible);
  } else if (item.type === 'task') {
    const task = data.tasks.find(t => t.id === item.taskId);
    if (task && task.sessions.length) {
      expanded.has(task.id) ? expanded.delete(task.id) : expanded.add(task.id);
    }
  } else if (item.type === 'week') {
    weekVisible = !weekVisible;
    localStorage.setItem('tt_week_visible', weekVisible);
  } else if (item.type === 'day') {
    expandedDays.has(item.date) ? expandedDays.delete(item.date) : expandedDays.add(item.date);
  } else if (item.type === 'day-task') {
    const dtKey = `${item.date}::${item.taskId}`;
    expandedDayTasks.has(dtKey) ? expandedDayTasks.delete(dtKey) : expandedDayTasks.add(dtKey);
  } else if (item.type === 'later') {
    laterVisible = !laterVisible;
    localStorage.setItem('tt_later_visible', laterVisible);
  }
  render();
}

function navExpand(item) {
  if (item.type === 'today') { tasksVisible = true; localStorage.setItem('tt_tasks_visible', 'true'); }
  else if (item.type === 'task') { expanded.add(item.taskId); }
  else if (item.type === 'week') { weekVisible = true; localStorage.setItem('tt_week_visible', 'true'); }
  else if (item.type === 'day') { expandedDays.add(item.date); }
  else if (item.type === 'day-task') { expandedDayTasks.add(`${item.date}::${item.taskId}`); }
  else if (item.type === 'later') { laterVisible = true; localStorage.setItem('tt_later_visible', 'true'); }
  render();
}

function navCollapse(item) {
  if (item.type === 'today') { tasksVisible = false; localStorage.setItem('tt_tasks_visible', 'false'); }
  else if (item.type === 'task') { expanded.delete(item.taskId); }
  else if (item.type === 'week') { weekVisible = false; localStorage.setItem('tt_week_visible', 'false'); }
  else if (item.type === 'day') { expandedDays.delete(item.date); }
  else if (item.type === 'day-task') { expandedDayTasks.delete(`${item.date}::${item.taskId}`); }
  else if (item.type === 'later') { laterVisible = false; localStorage.setItem('tt_later_visible', 'false'); }
  render();
}

async function navEnter(item, parallel = false) {
  if (item.type === 'task' || item.type === 'day-task') {
    const task = data.tasks.find(t => t.id === item.taskId);
    if (task) await startTask(task, { parallel });
    render();
  } else if (item.type === 'later-input') {
    document.getElementById('later-input').focus();
  } else if (item.type === 'later-item') {
    await promoteToTask(item.id);
  } else {
    navToggle(item);
  }
}

function scrollNavIntoView() {
  const el = document.querySelector('.nav-highlight, .task-row.selected');
  if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

const searchEl   = document.getElementById('search');
const listEl     = document.getElementById('task-list');
const totalRow   = document.getElementById('total-row');
const hdRunning  = document.getElementById('header-running');
const hdDate     = document.getElementById('header-date');
const historyEl  = document.getElementById('history');
const tagAutocompleteEl = document.getElementById('tag-autocomplete');
let tagSuggestions = [];
let tagSelIdx = -1;

hdDate.textContent = new Date().toLocaleDateString('en-US', {
  weekday: 'short', month: 'short', day: 'numeric'
}).toLowerCase();

function query()   { return searchEl.value.trim(); }
function queryLC() { return query().toLowerCase(); }

function filtered() {
  const q = queryLC();
  if (!q) {
    const todayTasks = data.tasks.filter(t => taskTodayMs(t) > 0 || t.sessions.some(s => !s.end));
    if (todayTasks.length >= 5) return sortRunningFirst(todayTasks);
    const todayIds = new Set(todayTasks.map(t => t.id));
    const recent = data.tasks
      .filter(t => !todayIds.has(t.id) && t.sessions.length > 0)
      .sort((a, b) => Math.max(...b.sessions.map(s => s.start)) - Math.max(...a.sessions.map(s => s.start)))
      .slice(0, 5 - todayTasks.length);
    return sortRunningFirst([...todayTasks, ...recent]);
  }
  const tagContext = parseTagAutocompleteContext(query());
  if (tagContext) {
    return data.tasks.filter(task => {
      const taskNameMatch = task.name.toLowerCase().includes(tagContext.taskPart.toLowerCase());
      const taskTag = (tagNameForTask(task) || '').toLowerCase();
      const tagMatch = !tagContext.typedTag || taskTag.startsWith(tagContext.typedTag);
      return taskNameMatch && tagMatch;
    });
  }
  return data.tasks.filter(t => t.name.toLowerCase().includes(q));
}

function tagSuggestionsForInput(rawInput) {
  const context = parseTagAutocompleteContext(rawInput);
  if (!context) return [];

  const typed = context.typedTag;
  const existing = data.projects
    .filter(t => !typed || t.normalizedName.startsWith(typed))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_TAG_SUGGESTIONS)
    .map(t => ({ kind: 'existing', tagName: t.normalizedName, label: t.name, tagId: t.id }));

  const hasExact = data.projects.some(t => t.normalizedName === typed);
  if (typed && !hasExact) {
    existing.unshift({
      kind: 'create',
      tagName: typed,
      label: `create tag "${typed}"`,
    });
  }
  return existing;
}

function closeTagAutocomplete() {
  tagSuggestions = [];
  tagSelIdx = -1;
  tagAutocompleteEl.innerHTML = '';
  tagAutocompleteEl.style.display = 'none';
}

function renderTagAutocomplete() {
  if (!tagSuggestions.length) {
    closeTagAutocomplete();
    return;
  }
  tagAutocompleteEl.style.display = 'block';
  tagAutocompleteEl.innerHTML = tagSuggestions.map((suggestion, idx) => `
    <div class="tag-row${idx === tagSelIdx ? ' selected' : ''}">
      <button class="tag-option${idx === tagSelIdx ? ' selected' : ''}" data-tag-name="${esc(suggestion.tagName)}" type="button">
        ${suggestion.kind === 'create' ? `<span class="po-create">${esc(suggestion.label)}</span>` : `<span class="po-hash">#</span>${esc(suggestion.label)}`}
      </button>
      ${suggestion.kind === 'existing' ? `
        <button class="tag-delete-btn" data-tag-delete-id="${esc(suggestion.tagId)}" type="button" title="delete tag">✕</button>
      ` : ''}
    </div>
  `).join('');
}

function updateTagAutocomplete(resetSelection = false) {
  tagSuggestions = tagSuggestionsForInput(searchEl.value);
  if (!tagSuggestions.length) {
    closeTagAutocomplete();
    return;
  }
  if (resetSelection || tagSelIdx < 0) {
    tagSelIdx = 0;
  } else {
    tagSelIdx = Math.min(tagSelIdx, tagSuggestions.length - 1);
  }
  renderTagAutocomplete();
}

function applyTagSuggestion(suggestion) {
  const context = parseTagAutocompleteContext(searchEl.value);
  if (!context || !context.taskPart) return;
  searchEl.value = `${context.taskPart} #${suggestion.tagName}`;
  closeTagAutocomplete();
}

function selectedTagSuggestion() {
  if (!tagSuggestions.length) return null;
  return tagSuggestions[Math.max(tagSelIdx, 0)] || tagSuggestions[0] || null;
}

function sortRunningFirst(tasks) {
  const running = tasks.filter(t => t.sessions.some(s => !s.end));
  const rest = tasks.filter(t => !t.sessions.some(s => !s.end))
    .sort((a, b) => {
      const todayStart = new Date(); todayStart.setHours(0,0,0,0);
      const ts = todayStart.getTime();
      const aLatest = Math.max(0, ...a.sessions.filter(s => s.end && s.start >= ts).map(s => s.end));
      const bLatest = Math.max(0, ...b.sessions.filter(s => s.end && s.start >= ts).map(s => s.end));
      return bLatest - aLatest;
    });
  return [...running, ...rest];
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
    days.push(localDateStr(d));
    d.setDate(d.getDate() + 1);
  }
  return days.reverse();
}

function dayTotalMs(dateStr) {
  return data.tasks.reduce((total, t) =>
    total + t.sessions
      .filter(s => s.end && localDateStr(new Date(s.start)) === dateStr)
      .reduce((a, s) => a + (s.end - s.start), 0)
  , 0);
}

function netDayMs(dateStr) {
  return mergedIntervalsMs(data.tasks.flatMap(t => t.sessions
    .filter(s => s.end && localDateStr(new Date(s.start)) === dateStr)
    .map(s => [s.start, s.end])));
}

function tasksForDay(dateStr) {
  return data.tasks
    .map(t => {
      const sessions = t.sessions.filter(s => s.end && localDateStr(new Date(s.start)) === dateStr);
      return {
        id: t.id,
        name: t.name,
        tagName: tagNameForTask(t),
        sessions,
        ms: sessions.reduce((a, s) => a + (s.end - s.start), 0)
      };
    })
    .filter(t => t.ms > 0)
    .sort((a, b) => b.ms - a.ms);
}

function deleteTaskDay(taskId, dateStr) {
  if (IS_SHARED) return;
  const task = data.tasks.find(t => t.id === taskId);
  if (!task) return;
  if (!confirm(`Delete all "${taskLabel(task)}" sessions for ${dateStr}?`)) return;
  task.sessions = task.sessions.filter(s =>
    localDateStr(new Date(s.start)) !== dateStr
  );
  persist();
  render();
}

function renderHistory() {
  const days = weekPastDays().filter(d => dayTotalMs(d) > 0);
  if (days.length === 0) { historyEl.innerHTML = ''; return; }

  const weekTotal = allWeekMs();
  const nav = activeNavItem();

  const dayRows = weekVisible ? days.map(dateStr => {
    const isExp  = expandedDays.has(dateStr);
    const total  = dayTotalMs(dateStr);
    const d      = new Date(dateStr + 'T12:00:00');
    const name   = d.toLocaleDateString('en-US', { weekday: 'short' }).toLowerCase();
    const date   = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toLowerCase();
    const tasks  = isExp ? tasksForDay(dateStr) : [];
    const dayHL  = nav && nav.type === 'day' && nav.date === dateStr ? ' nav-highlight' : '';

    return `
      <div class="day-row${dayHL}" data-date="${dateStr}">
        <span class="day-label"><span class="day-name">${name}</span> <span class="day-date">${date}</span></span>
        <span class="day-total">${fmt(total)}${netSuffixHTML(total, netDayMs(dateStr))}</span>
        <span class="day-chevron${isExp ? ' expanded' : ''}"></span>
      </div>
      ${isExp ? `<div class="day-tasks">${
        tasks.map(t => {
          const dtKey = `${dateStr}::${t.id}`;
          const dtExp = expandedDayTasks.has(dtKey);
          const dtHL  = nav && nav.type === 'day-task' && nav.date === dateStr && nav.taskId === t.id ? ' nav-highlight' : '';
          const sessionsHTML = dtExp ? `<div class="session-log open">${
            t.sessions.map(s => {
              const dur = s.end - s.start;
              return `<div class="sl-entry editable" data-task-id="${t.id}" data-session-start="${s.start}">
                <span class="sl-range">${fmtClock(s.start)} – ${fmtClock(s.end)}</span>
                <span class="sl-dur">${fmt(dur)}</span>
                <button class="sl-del" tabindex="-1">✕</button>
              </div>`;
            }).join('')
          }</div>` : '';
          return `
          <div class="day-task-row${dtExp ? ' expanded' : ''}${dtHL}" data-task-id="${t.id}" data-date="${dateStr}">
            <span class="dt-name">${esc(t.name)}${t.tagName ? ` <span class="dt-tag">#${esc(t.tagName)}</span>` : ''}</span>
            <span class="dt-time">${fmt(t.ms)}</span>
            <span class="dt-chevron${dtExp ? ' expanded' : ''}"></span>
            <button class="dt-del" tabindex="-1">✕</button>
          </div>${sessionsHTML}`;
        }).join('')
      }</div>` : ''}
    `;
  }).join('') : '';

  const weekHL = nav && nav.type === 'week' ? ' nav-highlight' : '';
  historyEl.innerHTML = `
    <div class="total-row week-total-row${weekHL}">
      <span class="total-label">week</span>
      <span class="total-time"><span id="week-total-time">${fmt(weekTotal)}</span>${netSuffixHTML(weekTotal, netWeekMs(), 'week-net-time')}</span>
      <span class="week-chevron${weekVisible ? ' expanded' : ''}"></span>
    </div>
  ` + dayRows;
}

historyEl.addEventListener('mousedown', e => {
  if (!e.target.closest('.sl-time-input')) e.preventDefault();
});

historyEl.addEventListener('click', async e => {
  // Session time editing
  const slRange = e.target.closest('.sl-range');
  if (slRange && slRange.closest('.sl-entry.editable')) {
    const entry = slRange.closest('.sl-entry');
    if (!entry.querySelector('.sl-time-input')) {
      beginEditSession(entry, entry.dataset.taskId, parseInt(entry.dataset.sessionStart));
    }
    return;
  }

  // Session delete
  const slDel = e.target.closest('.sl-del');
  if (slDel) {
    const entry = slDel.closest('.sl-entry');
    deleteSession(entry.dataset.taskId, parseInt(entry.dataset.sessionStart));
    return;
  }

  const dtDel = e.target.closest('.dt-del');
  if (dtDel) {
    const taskRow = dtDel.closest('.day-task-row');
    deleteTaskDay(taskRow.dataset.taskId, taskRow.dataset.date);
    return;
  }

  const taskRow = e.target.closest('.day-task-row');
  if (taskRow) {
    const dtKey = `${taskRow.dataset.date}::${taskRow.dataset.taskId}`;
    expandedDayTasks.has(dtKey) ? expandedDayTasks.delete(dtKey) : expandedDayTasks.add(dtKey);
    renderHistory();
    return;
  }

  if (e.target.closest('.week-chevron')) {
    weekVisible = !weekVisible;
    localStorage.setItem('tt_week_visible', weekVisible);
    renderHistory();
    return;
  }

  const row = e.target.closest('.day-row');
  if (!row) return;
  const date = row.dataset.date;
  expandedDays.has(date) ? expandedDays.delete(date) : expandedDays.add(date);
  renderHistory();
});

// ── Later list ────────────────────────────────────────────────────────────────
function addLaterItem(text) {
  if (IS_SHARED) return;
  data.later.push({ id: crypto.randomUUID(), text });
  persist();
  render();
}

function deleteLaterItem(id) {
  if (IS_SHARED) return;
  data.later = data.later.filter(i => i.id !== id);
  persist();
  render();
}

function markLaterDone(id) {
  if (IS_SHARED) return;
  const item = data.later.find(i => i.id === id);
  if (!item) return;
  data.later = data.later.filter(i => i.id !== id);
  const token = localStorage.getItem('tt_token');
  if (token) {
    fetch('/done', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ id: item.id, text: item.text }),
    }).catch(() => {});
  } else {
    const done = JSON.parse(localStorage.getItem(GUEST_DONE_KEY) || '[]');
    done.unshift({ id: item.id, text: item.text, done_at: new Date().toISOString() });
    localStorage.setItem(GUEST_DONE_KEY, JSON.stringify(done));
  }
  persist();
  render();
}

async function promoteToTask(id) {
  if (IS_SHARED) return;
  const item = data.later.find(i => i.id === id);
  if (!item) return;
  const task = createOrFindTaskFromQuery(item.text);
  if (!task) return;
  data.later = data.later.filter(i => i.id !== id);
  await startTask(task); // stops any running task, persists, renders
}

function renderLater() {
  const nav = activeNavItem();
  const headerEl = document.getElementById('later-header');
  const inputEl  = document.getElementById('later-input');
  const ul       = document.getElementById('later-list');

  const laterHL = nav && nav.type === 'later' ? ' nav-highlight' : '';
  headerEl.className = laterHL.trim();
  headerEl.innerHTML = `<span class="later-label">later</span><span class="later-chevron${laterVisible ? ' expanded' : ''}"></span>`;

  const inputHL = nav && nav.type === 'later-input';
  inputEl.style.display = laterVisible ? '' : 'none';
  inputEl.classList.toggle('nav-highlight', !!inputHL);
  ul.style.display      = laterVisible ? '' : 'none';

  if (laterVisible) {
    const items = [...data.later].reverse();
    ul.innerHTML = items.map(item => {
      const itemHL = nav && nav.type === 'later-item' && nav.id === item.id ? ' nav-highlight' : '';
      return `
      <li class="later-item${itemHL}" data-id="${item.id}" draggable="true">
        <span class="later-drag" title="Drag to reorder">⠿</span>
        <span class="later-text">${linkify(item.text)}</span>
        <button class="later-promote" data-id="${item.id}" title="start task">▶</button>
        <button class="later-done" data-id="${item.id}" title="mark done">✓</button>
        <button class="later-del" data-id="${item.id}">✕</button>
      </li>`;
    }).join('');
    initLaterDragDrop();
  }

  const doneLink = document.getElementById('later-done-link');
  if (doneLink) doneLink.style.display = laterVisible ? '' : 'none';
}

// ── Later drag-and-drop ─────────────────────────────────────────────────────
function initLaterDragDrop() {
  const ul = document.getElementById('later-list');
  let dragId = null;

  ul.querySelectorAll('.later-item').forEach(li => {
    li.addEventListener('dragstart', e => {
      dragId = li.dataset.id;
      li.classList.add('later-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('later-dragging');
      dragId = null;
      ul.querySelectorAll('.later-drop-above').forEach(el => el.classList.remove('later-drop-above'));
      ul.querySelectorAll('.later-drop-below').forEach(el => el.classList.remove('later-drop-below'));
    });
    li.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = li.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        li.classList.add('later-drop-above');
        li.classList.remove('later-drop-below');
      } else {
        li.classList.add('later-drop-below');
        li.classList.remove('later-drop-above');
      }
    });
    li.addEventListener('dragleave', () => {
      li.classList.remove('later-drop-above', 'later-drop-below');
    });
    li.addEventListener('drop', e => {
      e.preventDefault();
      if (!dragId || dragId === li.dataset.id) return;
      // data.later is stored oldest-first, display is reversed (newest first)
      const items = [...data.later].reverse();
      const fromIdx = items.findIndex(i => i.id === dragId);
      const toIdx = items.findIndex(i => i.id === li.dataset.id);
      if (fromIdx === -1 || toIdx === -1) return;
      const rect = li.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const insertBefore = e.clientY < midY;
      const [moved] = items.splice(fromIdx, 1);
      const finalIdx = items.findIndex(i => i.id === li.dataset.id);
      items.splice(insertBefore ? finalIdx : finalIdx + 1, 0, moved);
      data.later = [...items].reverse(); // back to oldest-first storage
      persist();
      render();
    });
  });
}

// ── Hint row ──────────────────────────────────────────────────────────────────
const hintRowEl = document.getElementById('search-hint');
function updateHintRow() {
  const count       = filtered().length;
  const searchFocused = document.activeElement === searchEl;
  const hasRunning  = !!runningTask();
  const selectedTag = selectedTagSuggestion();

  const parts = [];
  if (count >= 1) {
    const last = count >= 10 ? '0' : String(count);
    const label = count === 1 ? '1' : `1-${last}`;
    parts.push(`<kbd>${label}</kbd> start`);
  }
  if (!hasRunning) parts.push(`<kbd>c</kbd> continue`);
  parts.push(`<kbd>n</kbd> new`);
  parts.push(`<kbd>N</kbd> later`);
  if (searchFocused) {
    if (tagSuggestions.length) {
      parts.push(`<kbd>↑↓</kbd> tags`);
      parts.push(`<kbd>←</kbd> close tags`);
      if (selectedTag?.kind === 'existing') {
        parts.push(`<kbd>→</kbd> delete tag`);
      }
    } else {
      parts.push(`<kbd><span class="char-up">↵</span></kbd> start / stop`);
      if (hasRunning) parts.push(`<kbd>⇧+start</kbd> parallel`);
      parts.push(`<kbd>↑↓</kbd> select`);
      parts.push(`<kbd>tab</kbd> log`);
    }
  } else if (hasRunning) {
    parts.push(`<kbd>⇧+start</kbd> parallel`);
  }
  if (navIdx >= 0) {
    parts.length = 0;
    parts.push(`<kbd>j/↓ k/↑</kbd> navigate`);
    parts.push(`<kbd>space</kbd> toggle`);
    parts.push(`<kbd>→/←</kbd> expand`);
    parts.push(`<kbd><span class="char-up">↵</span></kbd> start`);
    parts.push(`<kbd>n</kbd> search`);
    parts.push(`<kbd>esc</kbd> exit`);
  } else {
    if (!searchFocused) parts.push(`<kbd>j/↓</kbd> navigate`);
    if (hasRunning && !tagSuggestions.length) parts.push(`<kbd>esc</kbd> clear`);
  }

  hintRowEl.innerHTML = parts.join(' &nbsp;·&nbsp; ');
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  closeMoveDropdown();
  const q      = query();
  const tasks  = filtered();
  const runningList = runningTasks();
  const running = runningList[0] ?? null;

  // clamp nav index
  if (navIdx >= 0) {
    const items = navItems();
    navIdx = Math.min(navIdx, items.length - 1);
    if (navIdx < 0) navIdx = 0;
  }
  const nav = activeNavItem();

  // clamp selection
  selIdx = Math.max(-1, Math.min(selIdx, tasks.length - 1));

  // header indicator
  hdRunning.classList.toggle('visible', !!running);

  listEl.innerHTML = '';

  // create hint (inline in search row)
  const parsedQuery = parseTaskInput(q);
  const canCreateFromInput = parsedQuery.taskName && (!q.includes('#') || parsedQuery.hasTag);
  const exactMatch = tasks.find(task =>
    task.name.toLowerCase() === parsedQuery.taskName.toLowerCase() &&
    (
      !parsedQuery.hasTag
        ? !task.projectId
        : (tagNameForTask(task) || '') === parsedQuery.tagName
    )
  );
  const showCreateHint = !!(canCreateFromInput && !exactMatch);
  document.getElementById('search-create-hint').classList.toggle('visible', showCreateHint);
  document.getElementById('search-parallel-hint').classList.toggle('visible', showCreateHint && !!runningTask());

  updateHintRow();

  // empty state
  if (!q && tasks.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty-state';
    li.textContent = 'type a task name and press ↵ to begin';
    listEl.appendChild(li);
  }

  tasks.forEach((task, i) => {
    const isRunning  = task.sessions.some(s => !s.end);
    const isSel      = i === selIdx || (nav && nav.type === 'task' && nav.taskId === task.id);
    const isExp      = expanded.has(task.id);
    const todaySess  = task.sessions.filter(s => isToday(s.start));
    const hasLog     = todaySess.length > 0;

    const li = document.createElement('li');
    li.className = ['task-row', isRunning ? 'running' : '', isSel ? 'selected' : ''].join(' ').trim();
    li.dataset.id = task.id;

    // Which sessions to show in the expanded view (single date)
    const shownSess = hasLog ? todaySess : (() => {
      const last = [...task.sessions].filter(s => s.end).sort((a,b) => b.start - a.start);
      if (!last.length) return [];
      const lastDate = localDateStr(new Date(last[0].start));
      return task.sessions.filter(s => localDateStr(new Date(s.start)) === lastDate);
    })();
    const shownDate = hasLog ? '' : (() => {
      if (!shownSess.length) return '';
      const d = new Date(shownSess[0].start);
      return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toLowerCase();
    })();
    const displayMs = hasLog
      ? taskTodayMs(task)
      : shownSess.reduce((a,s) => a + ((s.end ?? Date.now()) - s.start), 0);

    // Recent tasks (no today activity, not running) show as plain rows — no time, no expand
    const isRecent = !hasLog && !isRunning;

    const sessionHTML = !isRecent && isExp && shownSess.length ? `
      <div class="session-log open">
        ${shownDate ? `<div class="sl-date">${shownDate}</div>` : ''}
        ${shownSess.map(s => {
          const live = !s.end;
          const dur  = (s.end ?? Date.now()) - s.start;
          return `<div class="sl-entry${live ? ' live' : (hasLog ? ' editable' : '')}"
              data-task-id="${task.id}" data-session-start="${s.start}">
            <span class="sl-range">${fmtClock(s.start)} – ${live ? 'now' : fmtClock(s.end)}</span>
            ${!live ? `<span class="sl-move">move</span><span class="sl-move-sep"> · </span>` : ''}<span class="sl-dur"${live ? ` data-live-range="${s.start}"` : ''}>${fmt(dur)}</span>
            ${!live ? `<button class="sl-del" tabindex="-1">✕</button>` : ''}
          </div>`;
        }).join('')}
      </div>` : '';

    li.innerHTML = `
      <div class="task-main${isRecent ? ' not-expandable' : ''}">
        <span class="t-shortcut">${i < 9 ? i + 1 : i === 9 ? 0 : ''}</span>
        <button class="t-play${isRunning ? ' pausing' : ''}" data-id="${task.id}" tabindex="-1">${isRunning ? '⏸' : '▶'}</button>
        <span class="t-name">${linkify(task.name)}</span>
        ${tagNameForTask(task) ? `<span class="t-tag">#${esc(tagNameForTask(task))}</span>` : ''}
        <span class="t-dot"></span>
        ${isRecent ? '' : (() => {
          if (isRunning) {
            const sessionStart = task.sessions.find(s => !s.end).start;
            return `<span class="t-time"><span class="t-time-label">session</span> <span data-live-session="${sessionStart}">${fmt(Date.now() - sessionStart)}</span> <span class="t-time-sep">·</span> <span class="t-time-label">today</span> <span data-live="${task.id}">${fmt(taskTodayMs(task))}</span></span>`;
          }
          return `<span class="t-time">${fmt(displayMs)}</span>`;
        })()}
        ${isRecent ? '' : `<span class="t-expand${task.sessions.length && isExp ? ' expanded' : ''}"${task.sessions.length ? '' : ' style="visibility:hidden"'}></span>`}
        <button class="t-del" data-id="${task.id}" tabindex="-1">✕</button>
      </div>
      ${sessionHTML}
    `;

    listEl.appendChild(li);
  });

  // total row — always visible as the "today" anchor
  const listShown = tasksVisible || !!q;
  totalRow.style.display = 'flex';
  totalRow.classList.toggle('nav-highlight', !!(nav && nav.type === 'today'));
  listEl.style.display   = listShown ? '' : 'none';
  if (!listShown && running) {
    const names = runningList.map(t => esc(taskLabel(t))).join(' &nbsp;·&nbsp; ');
    const sessionPart = runningList.length === 1
      ? `<span class="t-time-label">session</span> <span data-live-session="${running.sessions.find(s => !s.end).start}">${fmt(Date.now() - running.sessions.find(s => !s.end).start)}</span>
        <span class="t-time-sep">·</span>`
      : '';
    totalRow.innerHTML = `
      <span class="total-label">today &nbsp;·&nbsp; <span class="total-active-name">${names}</span></span>
      <span class="total-time total-time-running">
        ${sessionPart}
        <span class="t-time-label">today</span> <span id="total-time">${fmt(allTodayMs())}</span>${netSuffixHTML(allTodayMs(), netTodayMs(), 'total-net-time')}
      </span>
      <span class="total-expand expanded"></span>`;
  } else {
    totalRow.innerHTML = `
      <span class="total-label">today</span>
      <span class="total-time"><span id="total-time">${fmt(allTodayMs())}</span>${netSuffixHTML(allTodayMs(), netTodayMs(), 'total-net-time')}</span>
      <span class="total-expand${listShown ? ' expanded' : ''}"></span>`;
  }

  renderHistory();
  renderLater();
  ensureTick();
  updateTabTitle();
  syncTagTip();
}

// ── Keyboard ──────────────────────────────────────────────────────────────────
async function startFromQuery(rawQuery, { parallel = false } = {}) {
  const parsed = parseTaskInput(rawQuery);
  if (!parsed.taskName) return false;

  if (rawQuery.includes('#')) {
    if (!parsed.hasTag) return false;
    const taggedTask = createOrFindTaskFromQuery(rawQuery);
    if (!taggedTask) return false;
    await startTask(taggedTask, { parallel });
    return true;
  }

  const tasks = filtered();
  let targetTask = null;
  if (selIdx >= 0) {
    targetTask = tasks[selIdx];
  } else if (tasks.length > 0) {
    const exact = tasks.find(task => task.name.toLowerCase() === parsed.taskName.toLowerCase() && !task.projectId);
    targetTask = exact ?? tasks[0];
  }

  if (!targetTask && parsed.taskName) {
    targetTask = createOrFindTaskFromQuery(parsed.taskName);
  }
  if (!targetTask) return false;

  await startTask(targetTask, { parallel });
  return true;
}

async function startFromCreateHint(parallel) {
  const q = query();
  if (!q) return;
  if (q.includes('#') && !parseTaskInput(q).hasTag) return;
  const task = createOrFindTaskFromQuery(q);
  if (!task) return;
  await startTask(task, { parallel });
  searchEl.value = '';
  selIdx = -1;
  closeTagAutocomplete();
  render();
}

document.getElementById('search-create-hint').addEventListener('mousedown', async e => {
  e.preventDefault(); // keep focus on input
  await startFromCreateHint(e.shiftKey);
});

document.getElementById('search-parallel-hint').addEventListener('mousedown', async e => {
  e.preventDefault(); // keep focus on input
  await startFromCreateHint(true);
});

searchEl.addEventListener('input', () => {
  selIdx = -1;
  updateTagAutocomplete(true);
  render();
});

searchEl.addEventListener('focus', () => {
  navIdx = -1;
  updateTagAutocomplete(true);
  updateHintRow();
});
searchEl.addEventListener('blur', e => {
  updateHintRow();
  if (suppressSearchBlurClear) return;
  // Focus moved into the tag menu (✕ or row) — keep draft until click/confirm finishes.
  const rt = e.relatedTarget;
  if (rt && tagAutocompleteEl?.contains(rt)) return;

  searchEl.value = '';
  selIdx = -1;
  closeTagAutocomplete();
  render();
});

searchEl.addEventListener('keydown', async e => {
  const q     = query();
  const tasks = filtered();

  if (tagSuggestions.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    tagSelIdx = (tagSelIdx + step + tagSuggestions.length) % tagSuggestions.length;
    renderTagAutocomplete();
    return;
  }

  if (tagSuggestions.length && (e.key === 'Enter' || e.key === 'Tab')) {
    e.preventDefault();
    const suggestion = selectedTagSuggestion();
    if (!suggestion) return;
    applyTagSuggestion(suggestion);
    render();
    return;
  }

  if (tagSuggestions.length && e.key === 'ArrowRight') {
    e.preventDefault();
    const suggestion = selectedTagSuggestion();
    if (!suggestion || suggestion.kind !== 'existing') return;
    deleteTagById(suggestion.tagId);
    updateTagAutocomplete(true);
    render();
    return;
  }

  if (tagSuggestions.length && e.key === 'ArrowLeft') {
    e.preventDefault();
    e.stopPropagation();
    const context = parseTagAutocompleteContext(searchEl.value);
    if (context) searchEl.value = context.taskPart;
    selIdx = -1;
    closeTagAutocomplete();
    render();
    return;
  }

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
    if (!q) {
      // Empty search → enter nav mode
      navIdx = 0;
      searchEl.blur(); // blur handler will call render()
    } else {
      const idx  = selIdx >= 0 ? selIdx : 0;
      const task = tasks[idx];
      if (task) {
        expanded.has(task.id) ? expanded.delete(task.id) : expanded.add(task.id);
        render();
      }
    }

  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (!q && selIdx < 0) return;
    const started = await startFromQuery(q, { parallel: e.shiftKey });
    if (started) {
      searchEl.value = '';
      selIdx = -1;
      closeTagAutocomplete();
      render();
    }
  }
});

tagAutocompleteEl.addEventListener('mousedown', e => e.preventDefault());
tagAutocompleteEl.addEventListener('click', e => {
  const deleteBtn = e.target.closest('[data-tag-delete-id]');
  if (deleteBtn) {
    deleteTagById(deleteBtn.dataset.tagDeleteId);
    updateTagAutocomplete(true);
    render();
    return;
  }

  const option = e.target.closest('[data-tag-name]');
  if (!option) return;
  applyTagSuggestion({ tagName: option.dataset.tagName });
  searchEl.focus();
  render();
});

// ── Inline session editing ─────────────────────────────────────────────────────
function beginEditSession(entry, taskId, sessionStart) {
  const task = data.tasks.find(t => t.id === taskId);
  const session = task?.sessions.find(s => s.start === sessionStart);
  if (!session || !session.end) return;

  const crossDay = localDateStr(new Date(session.start)) !== localDateStr(new Date(session.end));
  const rangeEl = entry.querySelector('.sl-range');
  rangeEl.innerHTML = crossDay
    ? `<input class="sl-date-input" type="date" value="${toDateInput(session.start)}" data-role="start-date">
       <input class="sl-time-input" type="time" value="${toTimeInput(session.start)}" data-role="start">
       <span class="sl-dash"> – </span>
       <input class="sl-date-input" type="date" value="${toDateInput(session.end)}" data-role="end-date">
       <input class="sl-time-input" type="time" value="${toTimeInput(session.end)}" data-role="end">`
    : `<input class="sl-time-input" type="time" value="${toTimeInput(session.start)}" data-role="start">
       <span class="sl-dash"> – </span>
       <input class="sl-time-input" type="time" value="${toTimeInput(session.end)}" data-role="end">`;
  rangeEl.querySelector('[data-role="start"]').focus();

  let saved = false;
  function save() {
    if (saved) return;
    saved = true;
    const startInput     = rangeEl.querySelector('[data-role="start"]');
    const endInput       = rangeEl.querySelector('[data-role="end"]');
    const startDateInput = rangeEl.querySelector('[data-role="start-date"]');
    const endDateInput   = rangeEl.querySelector('[data-role="end-date"]');
    if (!startInput || !endInput) return;
    const newStart = startDateInput
      ? fromDateTimeInput(startDateInput.value, startInput.value)
      : fromDateTimeInput(toDateInput(session.start), startInput.value);
    const newEnd = endDateInput
      ? fromDateTimeInput(endDateInput.value, endInput.value)
      : fromDateTimeInput(toDateInput(session.end), endInput.value);
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
// Clear nav mode on any mouse interaction
document.addEventListener('mousedown', () => {
  if (navIdx >= 0) {
    navIdx = -1;
    // Re-render on next frame so click handlers can finish with current DOM
    requestAnimationFrame(() => render());
  }
});

// Prevent mousedown from blurring the search input — click still fires normally
listEl.addEventListener('mousedown', e => {
  if (!e.target.closest('.sl-time-input')) e.preventDefault();
});

listEl.addEventListener('click', async e => {
  const slRange = e.target.closest('.sl-range');
  if (slRange && slRange.closest('.sl-entry.editable')) {
    const entry = slRange.closest('.sl-entry');
    if (!entry.querySelector('.sl-time-input')) {
      beginEditSession(entry, entry.dataset.taskId, parseInt(entry.dataset.sessionStart));
    }
    return;
  }

  const slMove = e.target.closest('.sl-move');
  if (slMove) {
    const entry = slMove.closest('.sl-entry');
    showMoveDropdown(slMove, entry.dataset.taskId, parseInt(entry.dataset.sessionStart));
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

  const playBtn = e.target.closest('.t-play');
  if (playBtn) {
    const task = data.tasks.find(t => t.id === playBtn.dataset.id);
    if (task) { await startTask(task, { parallel: e.shiftKey }); searchEl.blur(); }
    return;
  }

  const main = e.target.closest('.task-main');
  if (main && !main.classList.contains('not-expandable')) {
    const row  = main.closest('.task-row');
    const task = data.tasks.find(t => t.id === row?.dataset.id);
    if (task && task.sessions.length) {
      expanded.has(task.id) ? expanded.delete(task.id) : expanded.add(task.id);
      render();
    }
  }
});

// ── Later clicks ──────────────────────────────────────────────────────────────
document.getElementById('later-list').addEventListener('click', e => {
  if (e.target.classList.contains('later-promote')) {
    promoteToTask(e.target.dataset.id);
    return;
  }
  if (e.target.classList.contains('later-done')) {
    markLaterDone(e.target.dataset.id);
    return;
  }
  if (e.target.classList.contains('later-del')) {
    deleteLaterItem(e.target.dataset.id);
  }
});

// ── Global shortcuts ──────────────────────────────────────────────────────────
document.addEventListener('keydown', async e => {
  const onInput = document.activeElement && (
    document.activeElement.tagName === 'INPUT' ||
    document.activeElement.tagName === 'TEXTAREA' ||
    document.activeElement.isContentEditable
  );

  // ── Nav mode active ──
  if (!onInput && navIdx >= 0) {
    const items = navItems();
    const item  = items[navIdx];
    if (!item) { navIdx = -1; render(); return; }

    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      navIdx = Math.min(navIdx + 1, items.length - 1);
      render();
      scrollNavIntoView();
      return;
    }
    if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      navIdx = Math.max(navIdx - 1, 0);
      render();
      scrollNavIntoView();
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      navToggle(item);
      scrollNavIntoView();
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      navExpand(item);
      scrollNavIntoView();
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      navCollapse(item);
      scrollNavIntoView();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      await navEnter(item, e.shiftKey);
      scrollNavIntoView();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (item.type === 'later-input') return; // stay highlighted
      navIdx = -1;
      render();
      return;
    }
    if (e.key === 'n' || e.key === '/') {
      e.preventDefault();
      navIdx = -1;
      searchEl.focus();
      render();
      return;
    }
    if (e.key === 'N') {
      e.preventDefault();
      navIdx = -1;
      if (!laterVisible) { laterVisible = true; localStorage.setItem('tt_later_visible', 'true'); }
      render();
      const laterInput = document.getElementById('later-input');
      laterInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      laterInput.focus();
      return;
    }
    return; // swallow other keys in nav mode
  }

  // ── Enter nav mode from bare screen ──
  if (!onInput && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      navIdx = 0;
      render();
      scrollNavIntoView();
      return;
    }
    // Shift+digit produces punctuation in e.key, so fall back to e.code
    const digit = /^Digit[0-9]$/.test(e.code ?? '')
      ? (e.code === 'Digit0' ? 10 : parseInt(e.code.slice(5)))
      : (e.key === '0' ? 10 : parseInt(e.key));
    if (digit >= 1 && digit <= 10) {
      const task = filtered()[digit - 1];
      if (task) { e.preventDefault(); await startTask(task, { parallel: e.shiftKey }); }
      return;
    }
  }
  if (e.key === 'c' && !onInput && !runningTask()) {
    const last = data.tasks
      .filter(t => t.sessions.length > 0)
      .sort((a, b) => Math.max(...b.sessions.map(s => s.end ?? 0)) - Math.max(...a.sessions.map(s => s.end ?? 0)))[0];
    if (last) { e.preventDefault(); await startTask(last); }
    return;
  }
  if ((e.key === 'n' || e.key === '/') && !onInput) {
    e.preventDefault();
    searchEl.focus();
    return;
  }
  if (e.key === 'N' && !onInput) {
    e.preventDefault();
    if (!laterVisible) { laterVisible = true; localStorage.setItem('tt_later_visible', 'true'); render(); }
    const laterInput = document.getElementById('later-input');
    laterInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    laterInput.focus();
    return;
  }
  if (e.key !== 'Escape') return;
  if (document.getElementById('about-modal').style.display !== 'none') {
    hideAbout();
    return;
  }
  if (document.getElementById('auth-screen').style.display !== 'none') {
    hideAuth();
    return;
  }
  if (searchEl.value) {
    searchEl.blur(); // blur handler clears text and resets state
  } else {
    const running = runningTasks();
    if (running.length) {
      const now = Date.now();
      running.forEach(t => { t.sessions.find(s => !s.end).end = now; });
      clearAllPomodoroTimers();
      persist();
      render();
    }
    searchEl.blur();
  }
});

document.querySelector('.search-prompt').addEventListener('click', e => {
  if (e.target.closest('.tag-tip-close')) return;
  searchEl.focus();
});

const tagTipClose = document.querySelector('.tag-tip-close');
if (tagTipClose) {
  tagTipClose.addEventListener('click', e => {
    e.stopPropagation();
    e.preventDefault();
    dismissTagTip();
  });
}

totalRow.addEventListener('click', e => {
  if (e.target.closest('.total-expand')) {
    tasksVisible = !tasksVisible;
    localStorage.setItem('tt_tasks_visible', tasksVisible);
    render();
  }
});

// ── Later header collapse/expand ──────────────────────────────────────────────
document.getElementById('later-header').addEventListener('click', () => {
  laterVisible = !laterVisible;
  localStorage.setItem('tt_later_visible', laterVisible);
  render();
});

// ── Later input ───────────────────────────────────────────────────────────────
document.getElementById('later-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const val = e.target.value.trim();
    if (val) { addLaterItem(val); e.target.value = ''; }
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    e.target.blur();
    const items = navItems();
    const idx = items.findIndex(i => i.type === 'later-input');
    if (idx >= 0) { navIdx = idx; render(); }
  }
});

// Prevent later-input blur from interfering with task list focus
document.getElementById('later-input').addEventListener('blur', () => {});

// ── Billing UI events ─────────────────────────────────────────────────────────
document.getElementById('upgrade-cta').addEventListener('click', startCheckout);
document.getElementById('upgrade-dismiss').addEventListener('click', hideUpgradeModal);
document.getElementById('upgrade-backdrop').addEventListener('click', hideUpgradeModal);
document.getElementById('header-upgrade').addEventListener('click', startCheckout);
document.getElementById('header-manage').addEventListener('click', openBillingPortal);
document.getElementById('billing-success-close').addEventListener('click', () => {
  document.getElementById('billing-success-banner').style.display = 'none';
});

// ── About modal ──────────────────────────────────────────────────────────────
function showAbout()  { document.getElementById('about-modal').style.display = 'flex'; }
function hideAbout()  { document.getElementById('about-modal').style.display = 'none'; }
document.getElementById('header-about').addEventListener('click', showAbout);
document.getElementById('about-close').addEventListener('click', hideAbout);
document.getElementById('about-backdrop').addEventListener('click', hideAbout);

// ── Theme toggle ─────────────────────────────────────────────────────────────
document.getElementById('theme-toggle').addEventListener('click', cycleTheme);

// ── Done page ────────────────────────────────────────────────────────────────
function buildSparkline(weekly) {
  if (!weekly || weekly.length === 0) return '';
  const max = Math.max(...weekly, 1);
  const w = 120, h = 32, pad = 2;
  const step = weekly.length > 1 ? (w - pad * 2) / (weekly.length - 1) : 0;
  const points = weekly.map((v, i) => {
    const x = pad + i * step;
    const y = h - pad - ((v / max) * (h - pad * 2));
    return `${x},${y}`;
  });
  return `<svg class="done-sparkline" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <polyline fill="none" stroke="var(--dimmer)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" points="${points.join(' ')}"/>
  </svg>`;
}

function isDonePage() { return location.pathname === '/done-list'; }

async function initDonePage() {
  document.getElementById('app').innerHTML = `
    <div class="theme-bar theme-bar-sub">
      <a href="/" class="done-back">← Back</a>
      <button class="header-theme" id="theme-toggle-done" title="Toggle theme"></button>
    </div>
    <div class="done-page">
      <h1 class="done-title">Done</h1>
      <div class="done-stats" id="done-stats"></div>
      <ul class="done-list" id="done-list"></ul>
      <div class="done-loading" id="done-loading" style="display:none">Loading…</div>
      <div class="done-empty" id="done-empty" style="display:none">No items marked as done yet.</div>
    </div>`;

  document.getElementById('theme-toggle-done').innerHTML = document.getElementById('theme-toggle-done')?.innerHTML || '';
  const btn = document.getElementById('theme-toggle-done');
  const saved = localStorage.getItem(THEME_KEY) || 'light';
  btn.innerHTML = THEME_ICONS[saved];
  btn.addEventListener('click', () => { cycleTheme(); btn.innerHTML = THEME_ICONS[localStorage.getItem(THEME_KEY) || 'light']; });

  const token = localStorage.getItem('tt_token');
  const isGuest = !token;
  let allItems = [];
  let total = 0;
  let offset = 0;
  const PAGE = 50;

  async function loadStats() {
    const statsEl = document.getElementById('done-stats');
    if (isGuest) {
      const done = JSON.parse(localStorage.getItem(GUEST_DONE_KEY) || '[]');
      const now = new Date();
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1));
      weekStart.setHours(0, 0, 0, 0);
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const fourWeeksAgo = new Date(now.getTime() - 4 * 7 * 24 * 60 * 60 * 1000);

      const thisWeek = done.filter(d => new Date(d.done_at) >= weekStart).length;
      const thisMonth = done.filter(d => new Date(d.done_at) >= monthStart).length;
      const last4w = done.filter(d => new Date(d.done_at) >= fourWeeksAgo).length;
      const avg = Math.round(last4w / 4 * 10) / 10;

      statsEl.innerHTML = `
        <div class="done-stat"><span class="done-stat-value">${thisMonth}</span><span class="done-stat-label">this month</span></div>
        <div class="done-stat"><span class="done-stat-value">${thisWeek}</span><span class="done-stat-label">this week</span></div>
        <div class="done-stat"><span class="done-stat-value">${avg}</span><span class="done-stat-label">avg / week<span class="done-stat-sub">(last 4 weeks)</span></span></div>`;
      return;
    }
    try {
      const r = await fetch('/done/stats', { headers: { 'Authorization': `Bearer ${token}` } });
      if (!r.ok) return;
      const s = await r.json();
      statsEl.innerHTML = `
        <div class="done-stat"><span class="done-stat-value">${s.this_month}</span><span class="done-stat-label">this month</span></div>
        <div class="done-stat"><span class="done-stat-value">${s.this_week}</span><span class="done-stat-label">this week</span></div>
        <div class="done-stat"><span class="done-stat-value">${s.avg_per_week}</span><span class="done-stat-label">avg / week<span class="done-stat-sub">(last ${s.avg_weeks} week${s.avg_weeks === 1 ? '' : 's'})</span></span></div>
        <div class="done-stat done-stat-spark">${buildSparkline(s.weekly)}</div>`;
    } catch {}
  }

  function renderItems() {
    const ul = document.getElementById('done-list');
    ul.innerHTML = allItems.map(item => {
      const d = new Date(item.done_at);
      const dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      return `<li class="done-item"><span class="done-item-check">✓</span><span class="done-item-text">${linkify(item.text)}</span><span class="done-item-date">${dateStr}</span></li>`;
    }).join('');
  }

  async function loadMore() {
    const loadingEl = document.getElementById('done-loading');
    const emptyEl = document.getElementById('done-empty');
    loadingEl.style.display = 'block';

    if (isGuest) {
      const done = JSON.parse(localStorage.getItem(GUEST_DONE_KEY) || '[]');
      total = done.length;
      allItems = done.slice(0, offset + PAGE);
      offset = allItems.length;
    } else {
      try {
        const r = await fetch(`/done?offset=${offset}&limit=${PAGE}`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!r.ok) { loadingEl.style.display = 'none'; return; }
        const body = await r.json();
        total = body.total;
        allItems = allItems.concat(body.items);
        offset += body.items.length;
      } catch { loadingEl.style.display = 'none'; return; }
    }

    loadingEl.style.display = 'none';
    if (allItems.length === 0) { emptyEl.style.display = 'block'; return; }
    renderItems();
  }

  // Infinite scroll
  window.addEventListener('scroll', () => {
    if (!isDonePage()) return;
    if (offset >= total) return;
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 200) {
      loadMore();
    }
  });

  await Promise.all([loadStats(), loadMore()]);
}

// ── Report page ──────────────────────────────────────────────────────────────

function isReportPage() { return location.pathname === '/report'; }

function fmtHM(ms) {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

// Total length of the union of [start, end] intervals — overlap counted once
function mergedIntervalsMs(intervals) {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0, curStart = null, curEnd = null;
  for (const [start, end] of sorted) {
    if (curEnd === null || start > curEnd) {
      if (curEnd !== null) total += curEnd - curStart;
      curStart = start;
      curEnd = end;
    } else if (end > curEnd) {
      curEnd = end;
    }
  }
  if (curEnd !== null) total += curEnd - curStart;
  return total;
}

async function initReportPage() {
  document.getElementById('app').innerHTML = `
    <div class="theme-bar theme-bar-sub">
      <a href="/" class="done-back">← Back</a>
      <button class="header-theme" id="theme-toggle-report" title="Toggle theme"></button>
    </div>
    <div class="report-page">
      <h1 class="done-title">Monthly Report</h1>
      <div class="report-content" id="report-content">
        <div class="done-loading">Loading…</div>
      </div>
    </div>`;

  const btn = document.getElementById('theme-toggle-report');
  const saved = localStorage.getItem(THEME_KEY) || 'light';
  btn.innerHTML = THEME_ICONS[saved];
  btn.addEventListener('click', () => { cycleTheme(); btn.innerHTML = THEME_ICONS[localStorage.getItem(THEME_KEY) || 'light']; });

  const token = localStorage.getItem('tt_token');
  const contentEl = document.getElementById('report-content');

  if (!token) {
    // Guest mode: compute from localStorage
    const guestData = JSON.parse(localStorage.getItem(GUEST_KEY) || '{"tasks":[]}');
    const thirtyDaysAgo = Date.now() - 30 * 86400 * 1000;
    const tasks = guestData.tasks
      .map(t => {
        const sessions = (t.sessions || []).filter(s => s.end && s.start >= thirtyDaysAgo);
        const total_ms = sessions.reduce((a, s) => a + (s.end - s.start), 0);
        return { name: t.name, total_ms, session_count: sessions.length };
      })
      .filter(t => t.total_ms > 0)
      .sort((a, b) => b.total_ms - a.total_ms);
    const total_ms = tasks.reduce((a, t) => a + t.total_ms, 0);
    const no_overlap_ms = mergedIntervalsMs(guestData.tasks.flatMap(t =>
      (t.sessions || [])
        .filter(s => s.end && s.start >= thirtyDaysAgo)
        .map(s => [s.start, s.end])
    ));
    const period_start = new Date(thirtyDaysAgo).toISOString().slice(0, 10);
    const period_end = new Date().toISOString().slice(0, 10);
    renderReport(contentEl, { tasks, total_ms, no_overlap_ms, period_start, period_end });
    return;
  }

  try {
    const r = await fetch('/report/monthly', { headers: { 'Authorization': `Bearer ${token}` } });
    if (!r.ok) { contentEl.innerHTML = '<div class="done-empty">Could not load report.</div>'; return; }
    const data = await r.json();
    renderReport(contentEl, data);
  } catch {
    contentEl.innerHTML = '<div class="done-empty">Could not load report.</div>';
  }
}

const REPORT_COLORS = [
  '#4f86f7', '#f7694f', '#50c878', '#f7b84f', '#a66ff7',
  '#f74f9a', '#4fc8f7', '#f7d94f', '#6ff7a6', '#f74f4f',
  '#7b68ee', '#ff8c42', '#3cb371', '#e06cf7', '#42b0ff',
];

function renderReport(el, data) {
  if (data.tasks.length === 0) {
    el.innerHTML = '<div class="done-empty">No tracked time in the last 30 days.</div>';
    return;
  }

  const maxMs = data.tasks[0].total_ms;

  const rows = data.tasks.map((t, i) => {
    const pct = Math.max(2, Math.round(t.total_ms / maxMs * 100));
    const color = REPORT_COLORS[i % REPORT_COLORS.length];
    return `
      <div class="report-row">
        <div class="report-task-info">
          <span class="report-task-name">${esc(t.name)}</span>
          <span class="report-task-meta">${t.session_count} session${t.session_count === 1 ? '' : 's'}</span>
        </div>
        <div class="report-bar-wrap">
          <div class="report-bar" style="width:${pct}%;background:${color}"></div>
        </div>
        <span class="report-task-time">${fmtHM(t.total_ms)}</span>
      </div>`;
  }).join('');

  const fmtDate = iso => {
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  const periodLabel = data.period_start && data.period_end
    ? `${fmtDate(data.period_start)} – ${fmtDate(data.period_end)}`
    : 'Last 30 days';

  const noOverlapHTML = data.no_overlap_ms == null ? '' : `
    <div class="report-total report-total-secondary" title="Time spent tracking, with parallel tasks counted once">
      <span class="report-total-label">Net</span>
      <span class="report-total-time">${fmtHM(data.no_overlap_ms)}</span>
    </div>`;

  el.innerHTML = `
    <div class="report-period">${periodLabel}</div>
    <div class="report-total" title="Sum of all task time — parallel tasks each count in full">
      <span class="report-total-label">Total</span>
      <span class="report-total-time">${fmtHM(data.total_ms)}</span>
    </div>
    ${noOverlapHTML}
    <div class="report-rows">${rows}</div>`;
}

// ── Shared view ─────────────────────────────────────────────────────────────

function sharedSubPath() {
  return location.pathname.replace(`/shared/${SHARED_TOKEN}`, '') || '/';
}

function sharedCTABanner() {
  return `<div class="shared-cta">
    <span>You're viewing a shared profile.</span>
    <a href="/" class="shared-cta-link">Try Doing It — it's free</a>
  </div>`;
}

async function fetchSharedData() {
  try {
    const r = await fetch(`/shared/${SHARED_TOKEN}/data`);
    if (!r.ok) return false;
    data = await r.json();
    ensureDataShape();
    return true;
  } catch {
    return false;
  }
}

async function initSharedView() {
  document.body.classList.add('shared-view');
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('guest-banner').style.display = 'none';

  const ok = await fetchSharedData();
  if (!ok) {
    document.getElementById('app').innerHTML = sharedCTABanner() +
      '<div class="done-page"><div class="done-empty">Shared profile not found.</div></div>';
    return;
  }

  if (data.theme) {
    localStorage.setItem(THEME_KEY, data.theme);
    applyTheme();
  }

  // Insert CTA before the app content
  document.getElementById('app').insertAdjacentHTML('afterbegin', sharedCTABanner());

  // Update links to point to shared versions
  const reportLink = document.getElementById('report-link');
  if (reportLink) reportLink.href = `/shared/${SHARED_TOKEN}/report`;
  const doneLink = document.getElementById('later-done-link');
  if (doneLink) doneLink.href = `/shared/${SHARED_TOKEN}/done-list`;

  render();
  ensureTick();

  // Poll for live updates
  setInterval(async () => {
    if (await fetchSharedData()) { render(); }
  }, 5000);
}

async function initSharedDonePage() {
  document.body.classList.add('shared-view');
  document.getElementById('app').innerHTML = sharedCTABanner() + `
    <div class="theme-bar theme-bar-sub">
      <a href="/shared/${SHARED_TOKEN}" class="done-back">\u2190 Back</a>
      <button class="header-theme" id="theme-toggle-done" title="Toggle theme"></button>
    </div>
    <div class="done-page">
      <h1 class="done-title">Done</h1>
      <div class="done-stats" id="done-stats"></div>
      <ul class="done-list" id="done-list"></ul>
      <div class="done-loading" id="done-loading" style="display:none">Loading\u2026</div>
      <div class="done-empty" id="done-empty" style="display:none">No items marked as done yet.</div>
    </div>`;

  const btn = document.getElementById('theme-toggle-done');
  const saved = localStorage.getItem(THEME_KEY) || 'light';
  btn.innerHTML = THEME_ICONS[saved];
  btn.addEventListener('click', () => { cycleTheme(); btn.innerHTML = THEME_ICONS[localStorage.getItem(THEME_KEY) || 'light']; });

  let allItems = [];
  let total = 0;
  let offset = 0;
  const PAGE = 50;

  async function loadStats() {
    const statsEl = document.getElementById('done-stats');
    try {
      const r = await fetch(`/shared/${SHARED_TOKEN}/done/stats`);
      if (!r.ok) return;
      const s = await r.json();
      statsEl.innerHTML = `
        <div class="done-stat"><span class="done-stat-value">${s.this_month}</span><span class="done-stat-label">this month</span></div>
        <div class="done-stat"><span class="done-stat-value">${s.this_week}</span><span class="done-stat-label">this week</span></div>
        <div class="done-stat"><span class="done-stat-value">${s.avg_per_week}</span><span class="done-stat-label">avg / week<span class="done-stat-sub">(last ${s.avg_weeks} week${s.avg_weeks === 1 ? '' : 's'})</span></span></div>
        <div class="done-stat done-stat-spark">${buildSparkline(s.weekly)}</div>`;
    } catch {}
  }

  function renderItems() {
    const ul = document.getElementById('done-list');
    ul.innerHTML = allItems.map(item => {
      const d = new Date(item.done_at);
      const dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      return `<li class="done-item"><span class="done-item-check">\u2713</span><span class="done-item-text">${linkify(item.text)}</span><span class="done-item-date">${dateStr}</span></li>`;
    }).join('');
  }

  async function loadMore() {
    const loadingEl = document.getElementById('done-loading');
    const emptyEl = document.getElementById('done-empty');
    loadingEl.style.display = 'block';
    try {
      const r = await fetch(`/shared/${SHARED_TOKEN}/done?offset=${offset}&limit=${PAGE}`);
      if (!r.ok) { loadingEl.style.display = 'none'; return; }
      const body = await r.json();
      total = body.total;
      allItems = allItems.concat(body.items);
      offset += body.items.length;
    } catch { loadingEl.style.display = 'none'; return; }
    loadingEl.style.display = 'none';
    if (allItems.length === 0) { emptyEl.style.display = 'block'; return; }
    renderItems();
  }

  window.addEventListener('scroll', () => {
    if (sharedSubPath() !== '/done-list') return;
    if (offset >= total) return;
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 200) {
      loadMore();
    }
  });

  await Promise.all([loadStats(), loadMore()]);
}

async function initSharedReportPage() {
  document.body.classList.add('shared-view');
  document.getElementById('app').innerHTML = sharedCTABanner() + `
    <div class="theme-bar theme-bar-sub">
      <a href="/shared/${SHARED_TOKEN}" class="done-back">\u2190 Back</a>
      <button class="header-theme" id="theme-toggle-report" title="Toggle theme"></button>
    </div>
    <div class="report-page">
      <h1 class="done-title">Monthly Report</h1>
      <div class="report-content" id="report-content">
        <div class="done-loading">Loading\u2026</div>
      </div>
    </div>`;

  const btn = document.getElementById('theme-toggle-report');
  const saved = localStorage.getItem(THEME_KEY) || 'light';
  btn.innerHTML = THEME_ICONS[saved];
  btn.addEventListener('click', () => { cycleTheme(); btn.innerHTML = THEME_ICONS[localStorage.getItem(THEME_KEY) || 'light']; });

  const contentEl = document.getElementById('report-content');
  try {
    const r = await fetch(`/shared/${SHARED_TOKEN}/report/monthly`);
    if (!r.ok) { contentEl.innerHTML = '<div class="done-empty">Could not load report.</div>'; return; }
    const data = await r.json();
    renderReport(contentEl, data);
  } catch {
    contentEl.innerHTML = '<div class="done-empty">Could not load report.</div>';
  }
}

// ── Timesheet page ──────────────────────────────────────────────────────────
// Public, read-only view of one tag's hours: the page a client opens.

const TIMESHEET_PERIODS = [
  { key: 'week',  label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'year',  label: 'This year' },
];
const TIMESHEET_POLL_MS = 5000;

let tsData = null;
let tsPeriod = 'week';

// Decimal hours for invoicing. Derived from whole minutes so it always agrees
// with the H:MM figure beside it.
function fmtDecimalHours(ms) {
  return `${(Math.floor(ms / 60000) / 60).toFixed(2)} h`;
}

// Server figures are a snapshot taken at `now`; while something is running the
// clock keeps moving, so add the time elapsed since that snapshot.
function tsLive(period) {
  const elapsed = tsData.running_count ? Math.max(0, Date.now() - tsData.now) : 0;
  return {
    total: period.total_ms + tsData.running_count * elapsed,
    net: period.net_ms + elapsed,
  };
}

function fmtTimesheetDate(iso) {
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function timesheetBars(rows, labelKey, maxMs) {
  return rows.map((row, i) => {
    const pct = maxMs ? Math.max(2, Math.round(row.total_ms / maxMs * 100)) : 2;
    const color = REPORT_COLORS[i % REPORT_COLORS.length];
    return `
      <div class="report-row">
        <div class="report-task-info">
          <span class="report-task-name">${esc(row[labelKey])}</span>
          ${row.session_count ? `<span class="report-task-meta">${row.session_count} session${row.session_count === 1 ? '' : 's'}</span>` : ''}
        </div>
        <div class="report-bar-wrap">
          <div class="report-bar" style="width:${pct}%;background:${color}"></div>
        </div>
        <span class="report-task-time">${fmtHM(row.total_ms)}</span>
      </div>`;
  }).join('');
}

// Week and month break down by day; a year breaks down by month.
function timesheetPeriodRows(periodKey) {
  const period = tsData[periodKey];
  const days = tsData.days.filter(d => d.date >= period.start && d.date <= period.end);
  if (periodKey !== 'year') {
    return days.map(d => ({
      label: new Date(d.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
      total_ms: d.total_ms,
    }));
  }
  const byMonth = new Map();
  for (const d of days) {
    const key = d.date.slice(0, 7);
    byMonth.set(key, (byMonth.get(key) || 0) + d.total_ms);
  }
  return [...byMonth.entries()].map(([key, total_ms]) => ({
    label: new Date(key + '-01T12:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
    total_ms,
  }));
}

function renderTimesheet() {
  const el = document.getElementById('timesheet-page');
  if (!el || !tsData) return;

  const cards = TIMESHEET_PERIODS.map(({ key, label }) => {
    const period = tsData[key];
    const { total, net } = tsLive(period);
    const netLine = net < total
      ? `<div class="ts-card-net" id="ts-net-${key}" title="Parallel tasks counted once">net ${fmtHM(net)}</div>`
      : '';
    return `
      <div class="ts-card">
        <div class="ts-card-label">${label}</div>
        <div class="ts-card-total" id="ts-total-${key}">${fmtHM(total)}</div>
        <div class="ts-card-decimal" id="ts-decimal-${key}">${fmtDecimalHours(total)}</div>
        ${netLine}
        <div class="ts-card-range">${fmtTimesheetDate(period.start)} - ${fmtTimesheetDate(period.end)}</div>
      </div>`;
  }).join('');

  const tabs = TIMESHEET_PERIODS.map(({ key, label }) =>
    `<button class="ts-tab${key === tsPeriod ? ' active' : ''}" data-ts-period="${key}">${label}</button>`
  ).join('');

  const tasks = tsData[tsPeriod].tasks;
  const periodRows = timesheetPeriodRows(tsPeriod);
  const breakdown = tasks.length ? `
    <div class="ts-section">
      <div class="ts-section-title">By task</div>
      <div class="report-rows">${timesheetBars(tasks, 'name', tasks[0].total_ms)}</div>
    </div>
    <div class="ts-section">
      <div class="ts-section-title">${tsPeriod === 'year' ? 'By month' : 'By day'}</div>
      <div class="report-rows">${timesheetBars(periodRows, 'label', Math.max(...periodRows.map(r => r.total_ms)))}</div>
    </div>` : '<div class="done-empty">No tracked time in this period.</div>';

  el.innerHTML = `
    <h1 class="ts-title">#${esc(tsData.tag)}</h1>
    <div class="ts-sub">
      ${tsData.running_count
        ? `<span class="ts-live-dot">●</span> tracking now`
        : 'not tracking right now'}
      <span class="ts-sub-sep">·</span> live timesheet, updates automatically
    </div>
    <div class="ts-cards">${cards}</div>
    <div class="ts-tabs">${tabs}</div>
    ${breakdown}
    <div class="ts-footer">Tracked with <a href="/">Doing It</a>.</div>`;
}

// Keep the headline figures moving between polls
function tickTimesheet() {
  if (!tsData || !tsData.running_count) return;
  for (const { key } of TIMESHEET_PERIODS) {
    const { total, net } = tsLive(tsData[key]);
    const totalEl = document.getElementById(`ts-total-${key}`);
    if (totalEl) totalEl.textContent = fmtHM(total);
    const decimalEl = document.getElementById(`ts-decimal-${key}`);
    if (decimalEl) decimalEl.textContent = fmtDecimalHours(total);
    const netEl = document.getElementById(`ts-net-${key}`);
    if (netEl) netEl.textContent = `net ${fmtHM(net)}`;
  }
}

async function loadTimesheet() {
  const el = document.getElementById('timesheet-page');
  try {
    const r = await fetch(`/timesheet/${TIMESHEET_TOKEN}/data?tz=${new Date().getTimezoneOffset()}`);
    if (r.status === 404) {
      el.innerHTML = '<div class="done-empty">This timesheet link is no longer active.</div>';
      tsData = null;
      return false;
    }
    if (!r.ok) return true;
    tsData = await r.json();
    renderTimesheet();
  } catch {
    if (!tsData) el.innerHTML = '<div class="done-empty">Could not load this timesheet.</div>';
  }
  return true;
}

async function initTimesheetPage() {
  document.body.classList.add('shared-view');
  document.getElementById('app').innerHTML = `
    <div class="theme-bar theme-bar-sub">
      <a href="/" class="done-back">Doing It</a>
      <button class="header-theme" id="theme-toggle-timesheet" title="Toggle theme"></button>
    </div>
    <div class="report-page timesheet-page" id="timesheet-page">
      <div class="done-loading">Loading\u2026</div>
    </div>`;

  const btn = document.getElementById('theme-toggle-timesheet');
  btn.innerHTML = THEME_ICONS[localStorage.getItem(THEME_KEY) || 'light'];
  btn.addEventListener('click', () => { cycleTheme(); btn.innerHTML = THEME_ICONS[localStorage.getItem(THEME_KEY) || 'light']; });

  document.getElementById('timesheet-page').addEventListener('click', e => {
    const tab = e.target.closest('[data-ts-period]');
    if (!tab) return;
    tsPeriod = tab.dataset.tsPeriod;
    renderTimesheet();
  });

  if (!await loadTimesheet()) return;
  const poll = setInterval(async () => {
    if (!await loadTimesheet()) clearInterval(poll);
  }, TIMESHEET_POLL_MS);
  setInterval(tickTimesheet, 1000);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
window.onGoogleLibraryLoad = initGoogleButton; // fires when GIS script finishes loading
loadGoogleAuth();                               // fetches client_id from backend
if (IS_TIMESHEET) {
  applyTheme();
  initTimesheetPage();
} else if (IS_SHARED) {
  applyTheme();
  const sub = sharedSubPath();
  if (sub === '/done-list') {
    initSharedDonePage();
  } else if (sub === '/report') {
    initSharedReportPage();
  } else {
    initSharedView();
  }
} else if (isDonePage()) {
  applyTheme();
  initDonePage();
} else if (isReportPage()) {
  applyTheme();
  initReportPage();
} else {
  load();
}
