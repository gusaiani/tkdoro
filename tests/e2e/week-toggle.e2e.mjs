/**
 * E2E tests for WEEK row collapse/expand toggle.
 * Run: npx playwright test tests/week-toggle.e2e.mjs
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

// ── Helpers ───────────────────────────────────────────────────────────────────
const hour = 3_600_000;
const day  = 24 * hour;

/** A session that started N days ago (always in the past, never today). */
function sessYesterday(daysAgo = 1) {
  const start = Date.now() - daysAgo * day;
  return { start, end: start + hour };
}

async function seedWithHistory(page, weekVisibleOverride) {
  await page.goto(BASE);
  await page.evaluate(({ weekVisible, s }) => {
    localStorage.removeItem('tt_token');
    localStorage.setItem('tt_guest_tasks', JSON.stringify({
      tasks: [{ id: 'A', name: 'Alpha', sessions: [s] }],
    }));
    localStorage.setItem('tt_tasks_visible', 'true');
    if (weekVisible !== undefined) {
      localStorage.setItem('tt_week_visible', String(weekVisible));
    } else {
      localStorage.removeItem('tt_week_visible');
    }
  }, { weekVisible: weekVisibleOverride, s: sessYesterday(1) });
  await page.reload();
  await page.waitForSelector('#task-list', { state: 'visible', timeout: 5000 });
}

// ── Tests ─────────────────────────────────────────────────────────────────────
test.describe('Week toggle', () => {

  test('WEEK row renders with ▲ and day rows are visible by default', async ({ page }) => {
    await seedWithHistory(page);

    const chevron = page.locator('.week-chevron');
    await expect(chevron).toBeVisible();
    await expect(chevron).toHaveText('▲');

    await expect(page.locator('.day-row').first()).toBeVisible();
  });

  test('Clicking chevron hides day rows and flips to ▼', async ({ page }) => {
    await seedWithHistory(page);

    await page.locator('.week-chevron').click();

    await expect(page.locator('.week-chevron')).toHaveText('▼');
    await expect(page.locator('.day-row')).toHaveCount(0);
  });

  test('Clicking chevron again shows day rows and flips back to ▲', async ({ page }) => {
    await seedWithHistory(page);

    const chevron = page.locator('.week-chevron');
    await chevron.click();
    await expect(chevron).toHaveText('▼');

    await chevron.click();
    await expect(chevron).toHaveText('▲');
    await expect(page.locator('.day-row').first()).toBeVisible();
  });

  test('Collapsed state persists across reload', async ({ page }) => {
    await seedWithHistory(page);

    await page.locator('.week-chevron').click();
    await expect(page.locator('.week-chevron')).toHaveText('▼');

    await page.reload();
    await page.waitForSelector('#task-list', { state: 'visible', timeout: 5000 });

    await expect(page.locator('.week-chevron')).toHaveText('▼');
    await expect(page.locator('.day-row')).toHaveCount(0);
  });

  test('Expanded state persists across reload', async ({ page }) => {
    await seedWithHistory(page, true);

    await page.reload();
    await page.waitForSelector('#task-list', { state: 'visible', timeout: 5000 });

    await expect(page.locator('.week-chevron')).toHaveText('▲');
    await expect(page.locator('.day-row').first()).toBeVisible();
  });

  test('WEEK row total time is always visible regardless of toggle state', async ({ page }) => {
    await seedWithHistory(page);

    const weekTime = page.locator('#week-total-time');
    await expect(weekTime).toBeVisible();

    await page.locator('.week-chevron').click();
    await expect(weekTime).toBeVisible();
  });
});
