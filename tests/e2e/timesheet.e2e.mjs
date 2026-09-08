/**
 * E2E tests for the per-tag timesheet page (/timesheet/<token>): the read-only
 * view a client opens to follow hours worked on one #tag.
 * Run: npx playwright test tests/e2e/timesheet.e2e.mjs
 */
import { test, expect } from '@playwright/test';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

const ROOT = path.resolve('.');
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.png':'image/png' };
const TOKEN = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const hour = 3_600_000, min = 60_000;

let server, BASE, timesheet;

function fixture({ running = 0 } = {}) {
  const now = Date.now();
  return {
    tag: 'acme',
    now,
    running_count: running,
    week: {
      start: '2026-09-07', end: '2026-09-09',
      total_ms: 5 * hour, net_ms: 5 * hour,
      tasks: [
        { name: 'Landing page', total_ms: 3 * hour, session_count: 4 },
        { name: 'Client calls', total_ms: 2 * hour, session_count: 2 },
      ],
    },
    month: {
      start: '2026-09-01', end: '2026-09-09',
      total_ms: 12 * hour, net_ms: 11 * hour,
      tasks: [{ name: 'Landing page', total_ms: 12 * hour, session_count: 9 }],
    },
    year: {
      start: '2026-01-01', end: '2026-09-09',
      total_ms: 40 * hour, net_ms: 40 * hour,
      tasks: [{ name: 'Landing page', total_ms: 40 * hour, session_count: 30 }],
    },
    days: [
      { date: '2026-08-14', total_ms: 28 * hour, net_ms: 28 * hour },
      { date: '2026-09-07', total_ms: 2 * hour, net_ms: 2 * hour },
      { date: '2026-09-08', total_ms: 3 * hour, net_ms: 3 * hour },
    ],
  };
}

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === `/timesheet/${TOKEN}/data`) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(timesheet));
      return;
    }
    const isPageRoute = url === '/' || url === `/timesheet/${TOKEN}`;
    const fp = path.join(ROOT, isPageRoute ? 'index.html' : url);
    if (!existsSync(fp)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(readFileSync(fp));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(() => { server?.close(); });

test.beforeEach(() => { timesheet = fixture(); });

test('shows the tag and hours for week, month and year', async ({ page }) => {
  await page.goto(`${BASE}/timesheet/${TOKEN}`);
  await expect(page.locator('.ts-title')).toHaveText('#acme');
  await expect(page.locator('#ts-total-week')).toHaveText('5h 0m');
  await expect(page.locator('#ts-decimal-week')).toHaveText('5.00 h');
  await expect(page.locator('#ts-total-month')).toHaveText('12h 0m');
  await expect(page.locator('#ts-total-year')).toHaveText('40h 0m');
});

test('shows net only where parallel tracking makes it differ', async ({ page }) => {
  await page.goto(`${BASE}/timesheet/${TOKEN}`);
  await expect(page.locator('#ts-net-month')).toHaveText('net 11h 0m');
  await expect(page.locator('#ts-net-week')).toHaveCount(0);
});

test('breaks the week down by task and by day, and the year by month', async ({ page }) => {
  await page.goto(`${BASE}/timesheet/${TOKEN}`);
  const names = page.locator('.report-task-name');
  await expect(names.first()).toHaveText('Landing page');
  // Week view: only the two days inside the week window
  await expect(names.filter({ hasText: 'Sep 7' })).toHaveCount(1);
  await expect(names.filter({ hasText: 'Aug 14' })).toHaveCount(0);

  await page.click('[data-ts-period="year"]');
  await expect(page.locator('.ts-section-title').last()).toHaveText('By month');
  await expect(names.filter({ hasText: 'August 2026' })).toHaveCount(1);
});

test('marks the tag as tracking while a session is running', async ({ page }) => {
  timesheet = fixture({ running: 1 });
  await page.goto(`${BASE}/timesheet/${TOKEN}`);
  await expect(page.locator('.ts-live-dot')).toBeVisible();
  await expect(page.locator('.ts-sub')).toContainText('tracking now');
});

test('reports a revoked link', async ({ page }) => {
  await page.route(`**/timesheet/${TOKEN}/data*`, route => route.fulfill({ status: 404, body: '{}' }));
  await page.goto(`${BASE}/timesheet/${TOKEN}`);
  await expect(page.locator('.done-empty')).toContainText('no longer active');
});
