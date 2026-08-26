/**
 * E2E tests for aggregate totals showing both total (plain sum) and net
 * (union of session intervals — parallel time counted once).
 * Run: npx playwright test tests/e2e/aggregate-net.e2e.mjs
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

// Fixed mid-week moment (Wednesday noon, local) so "yesterday" is always
// inside the current Monday-based week, regardless of when tests run.
const FAKE_NOW = new Date(2026, 7, 19, 12, 0, 0).getTime();
const min = 60_000, hour = 3_600_000;

async function seedTasks(page, tasks) {
  await page.clock.install({ time: FAKE_NOW });
  await page.goto(BASE);
  await page.evaluate((t) => {
    localStorage.clear();
    localStorage.setItem('tt_guest_tasks', JSON.stringify({ tasks: t }));
    localStorage.setItem('tt_tasks_visible', 'true');
    localStorage.setItem('tt_week_visible', 'true');
  }, tasks);
  await page.reload();
  await page.waitForSelector('#task-list', { state: 'visible', timeout: 5000 });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Today total and net', () => {

  test('shows both total and net when today has overlapping sessions', async ({ page }) => {
    const now = FAKE_NOW;
    await seedTasks(page, [
      // 30m + 30m summed, but 15m of it overlaps → net 45m
      { id: 'a', name: 'Alpha', sessions: [{ start: now - 60 * min, end: now - 30 * min }] },
      { id: 'b', name: 'Beta',  sessions: [{ start: now - 45 * min, end: now - 15 * min }] },
    ]);

    await expect(page.locator('#total-time')).toHaveText('1:00:00');
    await expect(page.locator('#total-net-time')).toHaveText('0:45:00');
  });

  test('shows only the total when today has no overlap', async ({ page }) => {
    const now = FAKE_NOW;
    await seedTasks(page, [
      { id: 'a', name: 'Alpha', sessions: [{ start: now - 60 * min, end: now - 40 * min }] },
      { id: 'b', name: 'Beta',  sessions: [{ start: now - 30 * min, end: now - 10 * min }] },
    ]);

    await expect(page.locator('#total-time')).toHaveText('0:40:00');
    await expect(page.locator('#total-net-time')).toHaveCount(0);
  });
});

test.describe('Week and day totals and net', () => {

  test('week row shows total and net across the week', async ({ page }) => {
    const y10 = FAKE_NOW - 26 * hour; // yesterday 10:00
    await seedTasks(page, [
      // yesterday: 1h + 1h summed, 30m overlap → net 1h30m
      { id: 'a', name: 'Alpha', sessions: [{ start: y10, end: y10 + hour }] },
      { id: 'b', name: 'Beta',  sessions: [{ start: y10 + 30 * min, end: y10 + 90 * min }] },
    ]);

    await expect(page.locator('#week-total-time')).toHaveText('2:00:00');
    await expect(page.locator('#week-net-time')).toHaveText('1:30:00');
  });

  test('day row shows total and net for that day', async ({ page }) => {
    const y10 = FAKE_NOW - 26 * hour;
    await seedTasks(page, [
      { id: 'a', name: 'Alpha', sessions: [{ start: y10, end: y10 + hour }] },
      { id: 'b', name: 'Beta',  sessions: [{ start: y10 + 30 * min, end: y10 + 90 * min }] },
    ]);

    const dayTotal = page.locator('.day-row .day-total');
    await expect(dayTotal).toContainText('2:00:00');
    await expect(dayTotal.locator('.net-time')).toHaveText('1:30:00');
  });

  test('day row shows only the total when that day has no overlap', async ({ page }) => {
    const y10 = FAKE_NOW - 26 * hour;
    await seedTasks(page, [
      { id: 'a', name: 'Alpha', sessions: [{ start: y10, end: y10 + hour }] },
      { id: 'b', name: 'Beta',  sessions: [{ start: y10 + 2 * hour, end: y10 + 3 * hour }] },
    ]);

    await expect(page.locator('.day-row .day-total')).toContainText('2:00:00');
    await expect(page.locator('.day-row .day-total .net-time')).toHaveCount(0);
  });
});

test.describe('Report labels', () => {

  test('report labels the overlap-free total "Net"', async ({ page }) => {
    const base = FAKE_NOW - 2 * 24 * hour;
    await seedTasks(page, [
      { id: 'a', name: 'Alpha', sessions: [{ start: base, end: base + hour }] },
      { id: 'b', name: 'Beta',  sessions: [{ start: base + hour / 2, end: base + 1.5 * hour }] },
    ]);

    await page.goto(`${BASE}/report`);
    await page.waitForSelector('.report-total', { timeout: 5000 });

    await expect(page.locator('.report-total:not(.report-total-secondary) .report-total-label')).toHaveText('Total');
    await expect(page.locator('.report-total-secondary .report-total-label')).toHaveText('Net');
  });
});
