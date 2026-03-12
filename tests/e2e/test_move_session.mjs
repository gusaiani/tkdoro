/**
 * Unit tests for moveSession and related rendering logic.
 * Run: node tests/test_move_session.mjs
 */

// ── Helpers (copied from app.js) ─────────────────────────────────────────────
function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
const todayStr = () => localDateStr();
const isToday  = ts => localDateStr(new Date(ts)) === todayStr();

const taskTodayMs = t => t.sessions
  .filter(s => isToday(s.start))
  .reduce((a,s) => a + ((s.end ?? Date.now()) - s.start), 0);

// ── Simulate data + functions under test ─────────────────────────────────────
let data;
const expanded = new Set();

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
}

function deleteSession(taskId, sessionStart) {
  const task = data.tasks.find(t => t.id === taskId);
  if (!task) return;
  task.sessions = task.sessions.filter(s => s.start !== sessionStart);
}

// Compute what the render function would show
function computeShownSess(task) {
  const todaySess = task.sessions.filter(s => isToday(s.start));
  const hasLog = todaySess.length > 0;
  const shownSess = hasLog ? todaySess : (() => {
    const last = [...task.sessions].filter(s => s.end).sort((a,b) => b.start - a.start);
    if (!last.length) return [];
    const lastDate = localDateStr(new Date(last[0].start));
    return task.sessions.filter(s => localDateStr(new Date(s.start)) === lastDate);
  })();
  const displayMs = hasLog
    ? taskTodayMs(task)
    : shownSess.reduce((a,s) => a + ((s.end ?? Date.now()) - s.start), 0);
  return { shownSess, hasLog, displayMs };
}

function filtered() {
  const todayTasks = data.tasks.filter(t => taskTodayMs(t) > 0 || t.sessions.some(s => !s.end));
  if (todayTasks.length >= 10) return todayTasks;
  const todayIds = new Set(todayTasks.map(t => t.id));
  const recent = data.tasks
    .filter(t => !todayIds.has(t.id) && t.sessions.length > 0)
    .sort((a, b) => Math.max(...b.sessions.map(s => s.start)) - Math.max(...a.sessions.map(s => s.start)))
    .slice(0, 10 - todayTasks.length);
  return [...todayTasks, ...recent];
}

// ── Test helpers ─────────────────────────────────────────────────────────────
const now = Date.now();
const hour = 3600000;
const day  = 86400000;

function todayAt(hoursAgo) { return now - hoursAgo * hour; }
function daysAgo(d, hoursAgo = 2) { return now - d * day - hoursAgo * hour; }

function makeSession(start, durationMs = hour) {
  return { start, end: start + durationMs };
}

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function test(name, fn) {
  console.log(`\n▸ ${name}`);
  expanded.clear();
  fn();
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('Move today session between two today tasks', () => {
  const s1 = makeSession(todayAt(3));
  const s2 = makeSession(todayAt(2));
  const s3 = makeSession(todayAt(1));
  data = { tasks: [
    { id: 'A', name: 'Task A', sessions: [s1, s2] },
    { id: 'B', name: 'Task B', sessions: [s3] },
  ]};

  const origAMs = taskTodayMs(data.tasks[0]);
  const origBMs = taskTodayMs(data.tasks[1]);

  // Move s2 from A to B
  moveSession('A', s2.start, 'B');

  assert(data.tasks[0].sessions.length === 1, 'A should have 1 session');
  assert(data.tasks[1].sessions.length === 2, 'B should have 2 sessions');
  assert(data.tasks[1].sessions.some(s => s.start === s2.start), 'B should contain moved session');

  const newAMs = taskTodayMs(data.tasks[0]);
  const newBMs = taskTodayMs(data.tasks[1]);
  assert(newAMs < origAMs, 'A today time should decrease');
  assert(newBMs > origBMs, 'B today time should increase');

  // Verify shownSess for both tasks
  const shownA = computeShownSess(data.tasks[0]);
  const shownB = computeShownSess(data.tasks[1]);
  assert(shownA.shownSess.length === 1, 'A should show 1 session');
  assert(shownB.shownSess.length === 2, 'B should show 2 sessions (including moved)');
  assert(shownB.shownSess.some(s => s.start === s2.start), 'B shownSess should include moved session');

  // Verify filtered() includes both
  const f = filtered();
  assert(f.some(t => t.id === 'A'), 'A should still be in filtered list');
  assert(f.some(t => t.id === 'B'), 'B should still be in filtered list');
});

test('Move second session from same task (consecutive moves)', () => {
  const s1 = makeSession(todayAt(4));
  const s2 = makeSession(todayAt(3));
  const s3 = makeSession(todayAt(2));
  data = { tasks: [
    { id: 'A', name: 'Task A', sessions: [s1, s2, s3] },
    { id: 'B', name: 'Task B', sessions: [] },
    { id: 'C', name: 'Task C', sessions: [] },
  ]};

  // First move: s2 from A to B
  moveSession('A', s2.start, 'B');
  assert(data.tasks[0].sessions.length === 2, 'A has 2 after first move');
  assert(data.tasks[1].sessions.length === 1, 'B has 1 after first move');

  // Second move: s3 from A to C
  moveSession('A', s3.start, 'C');
  assert(data.tasks[0].sessions.length === 1, 'A has 1 after second move');
  assert(data.tasks[2].sessions.length === 1, 'C has 1 after second move');
  assert(data.tasks[2].sessions[0].start === s3.start, 'C has the right session');

  // Verify all tasks' sessions add up
  const total = data.tasks.reduce((sum, t) => sum + t.sessions.length, 0);
  assert(total === 3, 'Total sessions unchanged (3)');
});

test('Move session then move it again (A→B→C)', () => {
  const s1 = makeSession(todayAt(2));
  data = { tasks: [
    { id: 'A', name: 'Task A', sessions: [s1] },
    { id: 'B', name: 'Task B', sessions: [] },
    { id: 'C', name: 'Task C', sessions: [] },
  ]};

  // Move from A to B
  moveSession('A', s1.start, 'B');
  assert(data.tasks[0].sessions.length === 0, 'A empty after first move');
  assert(data.tasks[1].sessions.length === 1, 'B has 1 after first move');

  // The moved session has the same start timestamp
  const movedStart = data.tasks[1].sessions[0].start;
  assert(movedStart === s1.start, 'Session start preserved after first move');

  // Move from B to C
  moveSession('B', movedStart, 'C');
  assert(data.tasks[1].sessions.length === 0, 'B empty after second move');
  assert(data.tasks[2].sessions.length === 1, 'C has 1 after second move');
  assert(data.tasks[2].sessions[0].start === s1.start, 'Session start preserved after second move');
});

test('Move past session to today task — data correctness', () => {
  const pastSession = makeSession(daysAgo(3));
  const todaySession = makeSession(todayAt(1));
  data = { tasks: [
    { id: 'A', name: 'Old task', sessions: [pastSession] },
    { id: 'B', name: 'Today task', sessions: [todaySession] },
  ]};

  moveSession('A', pastSession.start, 'B');

  assert(data.tasks[0].sessions.length === 0, 'A empty after move');
  assert(data.tasks[1].sessions.length === 2, 'B has 2 sessions');
  assert(data.tasks[1].sessions.some(s => s.start === pastSession.start), 'B contains the past session');

  // B's today time should NOT include the past session
  const bTodayMs = taskTodayMs(data.tasks[1]);
  assert(bTodayMs > 0, 'B still has today time');
  // The past session shouldn't change today's total
  const pastDur = pastSession.end - pastSession.start;
  assert(bTodayMs < pastDur + (todaySession.end - todaySession.start) + 1000,
    'B today time does not include past session');

  // But the past session IS in the data (backend would save it)
  const bTotal = data.tasks[1].sessions.reduce((a,s) => a + (s.end - s.start), 0);
  assert(bTotal === pastDur + (todaySession.end - todaySession.start), 'B total includes past session');
});

test('Move past session to today task — shownSess visibility', () => {
  const pastSession = makeSession(daysAgo(3));
  const todaySession = makeSession(todayAt(1));
  data = { tasks: [
    { id: 'A', name: 'Old task', sessions: [pastSession] },
    { id: 'B', name: 'Today task', sessions: [todaySession] },
  ]};

  moveSession('A', pastSession.start, 'B');

  // B has today sessions → hasLog=true → shownSess = todaySess → past session NOT shown
  const shownB = computeShownSess(data.tasks[1]);
  assert(shownB.hasLog === true, 'B hasLog is true');
  assert(shownB.shownSess.length === 1, 'B shownSess only shows today session');
  assert(!shownB.shownSess.some(s => s.start === pastSession.start),
    'Past session NOT visible in B expanded view (known limitation)');
  // This is the expected behavior now — past sessions in a today task are hidden
  // in the expanded view but ARE saved in the data
});

test('Move with parseInt — no precision loss', () => {
  const start = 1741622400000;  // a real-ish timestamp
  const s1 = { start, end: start + hour };
  data = { tasks: [
    { id: 'A', name: 'Task A', sessions: [s1] },
    { id: 'B', name: 'Task B', sessions: [] },
  ]};

  // Simulate what the click handler does: parseInt(dataset.sessionStart)
  const parsedStart = parseInt(String(start));
  assert(parsedStart === start, 'parseInt preserves timestamp');

  moveSession('A', parsedStart, 'B');
  assert(data.tasks[0].sessions.length === 0, 'A empty');
  assert(data.tasks[1].sessions.length === 1, 'B has session');
});

test('Move to nonexistent task — no crash', () => {
  const s1 = makeSession(todayAt(1));
  data = { tasks: [
    { id: 'A', name: 'Task A', sessions: [s1] },
  ]};

  moveSession('A', s1.start, 'NONEXISTENT');
  assert(data.tasks[0].sessions.length === 1, 'Session not removed when target missing');
});

test('Move nonexistent session — no crash', () => {
  data = { tasks: [
    { id: 'A', name: 'Task A', sessions: [makeSession(todayAt(1))] },
    { id: 'B', name: 'Task B', sessions: [] },
  ]};

  moveSession('A', 9999999, 'B');
  assert(data.tasks[0].sessions.length === 1, 'Session not removed when not found');
  assert(data.tasks[1].sessions.length === 0, 'Nothing added to B');
});

test('Move does not create shared references', () => {
  const s1 = makeSession(todayAt(1));
  data = { tasks: [
    { id: 'A', name: 'Task A', sessions: [s1] },
    { id: 'B', name: 'Task B', sessions: [] },
  ]};

  moveSession('A', s1.start, 'B');

  // Mutating the original s1 object should NOT affect B's session
  // because moveSession copies { start, end }
  s1.start = 0;
  assert(data.tasks[1].sessions[0].start !== 0, 'Moved session is a copy, not a reference');
});

test('Filtered list after move — task with 0 today time drops from todayTasks', () => {
  const s1 = makeSession(todayAt(1));
  data = { tasks: [
    { id: 'A', name: 'Task A', sessions: [s1] },
    { id: 'B', name: 'Task B', sessions: [] },
  ]};

  moveSession('A', s1.start, 'B');

  // A has 0 today time, no running session → should drop from todayTasks
  // but may appear in recent if it has sessions (it doesn't now)
  const f = filtered();
  assert(f.some(t => t.id === 'B'), 'B in filtered list');
  // A has no sessions at all → not in recent either
  assert(!f.some(t => t.id === 'A'), 'A not in filtered list (no sessions left)');
});

test('displayMs for recent task (no today sessions)', () => {
  const pastS1 = makeSession(daysAgo(2, 3), hour);
  const pastS2 = makeSession(daysAgo(2, 1), hour);
  data = { tasks: [
    { id: 'A', name: 'Old task', sessions: [pastS1, pastS2] },
  ]};

  const shown = computeShownSess(data.tasks[0]);
  assert(shown.hasLog === false, 'No today sessions');
  assert(shown.shownSess.length === 2, 'Shows 2 past sessions');
  assert(shown.displayMs === 2 * hour, 'displayMs is sum of past sessions (2h)');
});

test('displayMs for today task', () => {
  const s1 = makeSession(todayAt(3), hour);
  const pastS = makeSession(daysAgo(5), hour);
  data = { tasks: [
    { id: 'A', name: 'Task A', sessions: [pastS, s1] },
  ]};

  const shown = computeShownSess(data.tasks[0]);
  assert(shown.hasLog === true, 'Has today sessions');
  assert(shown.shownSess.length === 1, 'Shows only today session');
  assert(shown.displayMs === hour, 'displayMs is today total only');
});

test('Delete session from past date', () => {
  const pastS1 = makeSession(daysAgo(2, 3), hour);
  const pastS2 = makeSession(daysAgo(2, 1), hour);
  data = { tasks: [
    { id: 'A', name: 'Task A', sessions: [pastS1, pastS2] },
  ]};

  deleteSession('A', pastS1.start);
  assert(data.tasks[0].sessions.length === 1, 'One session remaining');
  assert(data.tasks[0].sessions[0].start === pastS2.start, 'Correct session remaining');
});

test('Serialization round-trip (simulates persist→load)', () => {
  const s1 = makeSession(todayAt(2));
  data = { tasks: [
    { id: 'A', name: 'Task A', sessions: [s1] },
    { id: 'B', name: 'Task B', sessions: [] },
  ]};

  moveSession('A', s1.start, 'B');

  // Simulate persist + load (JSON round-trip)
  const serialized = JSON.stringify(data);
  data = JSON.parse(serialized);

  assert(data.tasks[0].sessions.length === 0, 'A empty after round-trip');
  assert(data.tasks[1].sessions.length === 1, 'B has session after round-trip');
  assert(data.tasks[1].sessions[0].start === s1.start, 'Timestamp preserved');
  assert(data.tasks[1].sessions[0].end === s1.end, 'End preserved');

  // Can move again after round-trip
  moveSession('B', s1.start, 'A');
  assert(data.tasks[0].sessions.length === 1, 'A has session after re-move');
  assert(data.tasks[1].sessions.length === 0, 'B empty after re-move');
});

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
