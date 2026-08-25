/**
 * E2E tests for tracking multiple tasks in parallel.
 * Run: npx playwright test tests/e2e/parallel-tasks.e2e.mjs
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
    // Mirror the backend: page routes all serve index.html
    const isPageRoute = req.url === '/' || req.url === '/report';
    let fp = path.join(ROOT, isPageRoute ? 'index.html' : req.url);
    if (!existsSync(fp)) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(fp);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(readFileSync(fp));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(() => { server?.close(); });

// ── Helpers ───────────────────────────────────────────────────────────────────

async function seedTasks(page, tasks) {
  await page.goto(BASE);
  await page.evaluate((t) => {
    localStorage.clear();
    localStorage.setItem('tt_guest_tasks', JSON.stringify({ tasks: t }));
    localStorage.setItem('tt_tasks_visible', 'true');
  }, tasks);
  await page.reload();
  await page.waitForSelector('#task-list', { state: 'visible', timeout: 5000 });
}

const hour = 3_600_000;

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Parallel task tracking', () => {

  test('Shift+Enter starts a task without stopping the running one', async ({ page }) => {
    const now = Date.now();
    await seedTasks(page, [
      { id: 'a', name: 'Alpha', sessions: [{ start: now - 100, end: null }] }, // running
      { id: 'b', name: 'Beta', sessions: [{ start: now - 2 * hour, end: now - hour }] },
    ]);

    const search = page.locator('#search');
    await search.fill('Beta');
    await search.press('Shift+Enter');

    await expect(page.locator('.task-row.running')).toHaveCount(2);
  });

  test('plain Enter still switches: stops the running task', async ({ page }) => {
    const now = Date.now();
    await seedTasks(page, [
      { id: 'a', name: 'Alpha', sessions: [{ start: now - 100, end: null }] }, // running
      { id: 'b', name: 'Beta', sessions: [{ start: now - 2 * hour, end: now - hour }] },
    ]);

    const search = page.locator('#search');
    await search.fill('Beta');
    await search.press('Enter');

    await expect(page.locator('.task-row.running')).toHaveCount(1);
    await expect(page.locator('.task-row.running .t-name')).toHaveText('Beta');
  });

  test('shift-clicking play starts a second running task', async ({ page }) => {
    const now = Date.now();
    await seedTasks(page, [
      { id: 'a', name: 'Alpha', sessions: [{ start: now - 100, end: null }] }, // running
      { id: 'b', name: 'Beta', sessions: [{ start: now - 2 * hour, end: now - hour }] },
    ]);

    await page.locator('.task-row:not(.running) .t-play').click({ modifiers: ['Shift'] });

    await expect(page.locator('.task-row.running')).toHaveCount(2);
  });

  test('Escape stops all running tasks', async ({ page }) => {
    const now = Date.now();
    await seedTasks(page, [
      { id: 'a', name: 'Alpha', sessions: [{ start: now - 100, end: null }] },
      { id: 'b', name: 'Beta', sessions: [{ start: now - 200, end: null }] },
    ]);

    await expect(page.locator('.task-row.running')).toHaveCount(2);

    await page.keyboard.press('Escape');

    await expect(page.locator('.task-row.running')).toHaveCount(0);
  });
});

test.describe('Report overlap totals', () => {

  test('report shows summed total and overlap-free total', async ({ page }) => {
    const base = Date.now() - 2 * 24 * hour;
    await seedTasks(page, [
      { id: 'a', name: 'Alpha', sessions: [{ start: base, end: base + hour }] },
      { id: 'b', name: 'Beta', sessions: [{ start: base + hour / 2, end: base + 1.5 * hour }] },
    ]);

    await page.goto(`${BASE}/report`);
    await page.waitForSelector('.report-total', { timeout: 5000 });

    // 1h + 1h summed, but only 1.5h of wall-clock time
    await expect(page.locator('.report-total:not(.report-total-secondary) .report-total-time')).toHaveText('2h 0m');
    await expect(page.locator('.report-total-secondary .report-total-time')).toHaveText('1h 30m');
  });
});
