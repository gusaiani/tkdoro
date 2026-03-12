/**
 * E2E tests for session move using Playwright.
 * Run: npx playwright test
 */
import { test, expect } from '@playwright/test';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

const ROOT = path.resolve('.');
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.png':'image/png' };

let server, BASE;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let fp = path.join(ROOT, req.url === '/' ? 'index.html' : req.url);
    if (!existsSync(fp)) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(fp);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(readFileSync(fp));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(() => { server?.close(); });

// ── Helpers ──────────────────────────────────────────────────────────────────
const hour = 3_600_000;
function todayAt(hoursAgo) { return Date.now() - hoursAgo * hour; }
function sess(start, dur = hour) { return { start, end: start + dur }; }

async function seedData(page, data) {
  await page.goto(BASE);
  await page.evaluate((d) => {
    localStorage.removeItem('tt_token');
    localStorage.setItem('tt_guest_tasks', JSON.stringify(d));
    localStorage.setItem('tt_tasks_visible', 'true');
  }, data);
  await page.reload();
  await page.waitForSelector('#task-list', { state: 'visible', timeout: 5000 });
}

async function expandTask(page, taskName) {
  const row = page.locator('.task-row', { has: page.locator(`.t-name:text-is("${taskName}")`) });
  await row.locator('.t-expand').click();
}

async function clickMove(page, sessionStart) {
  const entry = page.locator(`.sl-entry[data-session-start="${sessionStart}"]`);
  // Hover to make the move button visible (opacity: 0 → 1 on hover)
  await entry.hover();
  await entry.locator('.sl-move').click();
}

async function selectMoveTarget(page, taskName) {
  const dropdown = page.locator('.sl-move-dropdown');
  await expect(dropdown).toBeVisible();
  await dropdown.locator(`.sl-move-option:text-is("${taskName}")`).click();
}

async function getPersistedSessions(page, taskId) {
  return page.evaluate((id) => {
    const d = JSON.parse(localStorage.getItem('tt_guest_tasks'));
    const task = d.tasks.find(t => t.id === id);
    return task ? task.sessions : [];
  }, taskId);
}

async function getTotalSessionCount(page) {
  return page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('tt_guest_tasks'));
    return d.tasks.reduce((sum, t) => sum + t.sessions.length, 0);
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────
test.describe('Move session', () => {

  test('Move today session from A to B — visible and persisted', async ({ page }) => {
    const s1 = sess(todayAt(3));
    const s2 = sess(todayAt(1));
    const data = { tasks: [
      { id: 'A', name: 'Alpha', sessions: [s1, s2] },
      { id: 'B', name: 'Bravo', sessions: [sess(todayAt(5))] },
    ]};

    await seedData(page, data);
    await expandTask(page, 'Alpha');

    const alphaEntries = page.locator('.task-row:has(.t-name:text-is("Alpha")) .sl-entry');
    await expect(alphaEntries).toHaveCount(2);

    await clickMove(page, s2.start);
    await selectMoveTarget(page, 'Bravo');

    // Alpha: 1 session in DOM
    await expect(alphaEntries).toHaveCount(1);

    // Bravo: auto-expanded, 2 sessions in DOM
    const bravoEntries = page.locator('.task-row:has(.t-name:text-is("Bravo")) .sl-entry');
    await expect(bravoEntries).toHaveCount(2);

    // Persisted correctly
    expect((await getPersistedSessions(page, 'A')).length).toBe(1);
    expect((await getPersistedSessions(page, 'B')).length).toBe(2);
  });

  test('Two consecutive moves from the same task', async ({ page }) => {
    const s1 = sess(todayAt(4));
    const s2 = sess(todayAt(3));
    const s3 = sess(todayAt(2));
    const data = { tasks: [
      { id: 'A', name: 'Alpha', sessions: [s1, s2, s3] },
      { id: 'B', name: 'Bravo', sessions: [sess(todayAt(6))] },
      { id: 'C', name: 'Charlie', sessions: [sess(todayAt(7))] },
    ]};

    await seedData(page, data);
    await expandTask(page, 'Alpha');

    // First move: s2 → Bravo
    await clickMove(page, s2.start);
    await selectMoveTarget(page, 'Bravo');

    expect((await getPersistedSessions(page, 'A')).length).toBe(2);
    expect((await getPersistedSessions(page, 'B')).length).toBe(2);

    // Second move: s3 → Charlie (Alpha is still expanded)
    await clickMove(page, s3.start);
    await selectMoveTarget(page, 'Charlie');

    expect((await getPersistedSessions(page, 'A')).length).toBe(1);
    expect((await getPersistedSessions(page, 'C')).length).toBe(2);
    expect(await getTotalSessionCount(page)).toBe(5);
  });

  test('Chain move A→B→C (same session moved twice)', async ({ page }) => {
    const s1 = sess(todayAt(2));
    const data = { tasks: [
      { id: 'A', name: 'Alpha', sessions: [s1] },
      { id: 'B', name: 'Bravo', sessions: [sess(todayAt(5))] },
      { id: 'C', name: 'Charlie', sessions: [sess(todayAt(4))] },
    ]};

    await seedData(page, data);
    await expandTask(page, 'Alpha');

    // A → B
    await clickMove(page, s1.start);
    await selectMoveTarget(page, 'Bravo');

    expect((await getPersistedSessions(page, 'A')).length).toBe(0);
    expect((await getPersistedSessions(page, 'B')).length).toBe(2);

    // B → C (Bravo is auto-expanded, session has same start timestamp)
    await clickMove(page, s1.start);
    await selectMoveTarget(page, 'Charlie');

    expect((await getPersistedSessions(page, 'B')).length).toBe(1);
    expect((await getPersistedSessions(page, 'C')).length).toBe(2);
    expect(await getTotalSessionCount(page)).toBe(3);
  });

  test('Dismiss dropdown then re-open and move', async ({ page }) => {
    const s1 = sess(todayAt(2));
    const data = { tasks: [
      { id: 'A', name: 'Alpha', sessions: [s1] },
      { id: 'B', name: 'Bravo', sessions: [sess(todayAt(5))] },
    ]};

    await seedData(page, data);
    await expandTask(page, 'Alpha');

    // Open and dismiss
    await clickMove(page, s1.start);
    await expect(page.locator('.sl-move-dropdown')).toBeVisible();
    await page.mouse.click(10, 10);
    await expect(page.locator('.sl-move-dropdown')).toHaveCount(0);

    // Session unchanged
    expect((await getPersistedSessions(page, 'A')).length).toBe(1);

    // Re-open and complete the move
    await clickMove(page, s1.start);
    await selectMoveTarget(page, 'Bravo');

    expect((await getPersistedSessions(page, 'A')).length).toBe(0);
    expect((await getPersistedSessions(page, 'B')).length).toBe(2);
  });

  test('Dropdown excludes source task', async ({ page }) => {
    const data = { tasks: [
      { id: 'A', name: 'Alpha', sessions: [sess(todayAt(1))] },
      { id: 'B', name: 'Bravo', sessions: [sess(todayAt(2))] },
      { id: 'C', name: 'Charlie', sessions: [sess(todayAt(3))] },
    ]};

    await seedData(page, data);
    await expandTask(page, 'Alpha');
    await clickMove(page, data.tasks[0].sessions[0].start);

    const options = page.locator('.sl-move-option');
    const texts = await options.allTextContents();
    expect(texts).not.toContain('Alpha');
    expect(texts).toContain('Bravo');
    expect(texts).toContain('Charlie');
  });

  test('Backdrop blocks interaction and closes dropdown on click', async ({ page }) => {
    const s1 = sess(todayAt(3));
    const s2 = sess(todayAt(1));
    const data = { tasks: [
      { id: 'A', name: 'Alpha', sessions: [s1, s2] },
      { id: 'B', name: 'Bravo', sessions: [] },
    ]};

    await seedData(page, data);
    await expandTask(page, 'Alpha');

    // Open dropdown for s1
    await clickMove(page, s1.start);
    await expect(page.locator('.sl-move-dropdown')).toHaveCount(1);
    await expect(page.locator('.sl-move-backdrop')).toHaveCount(1);

    // Click backdrop to dismiss
    await page.locator('.sl-move-backdrop').click();
    await expect(page.locator('.sl-move-dropdown')).toHaveCount(0);
    await expect(page.locator('.sl-move-backdrop')).toHaveCount(0);

    // Now open dropdown for s2 — works since backdrop is gone
    await clickMove(page, s2.start);
    await expect(page.locator('.sl-move-dropdown')).toHaveCount(1);
  });
});
