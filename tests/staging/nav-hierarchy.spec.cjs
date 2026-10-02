// Issue #121 — nav hierarchy, in a real browser.
// The recruiter's complaint: the vacancy picker sat BELOW the general menu, and the
// settings got pushed onto a second line by it. The picker is the scope control for
// every section link, so it (and the settings) belong on the TOP row, links below.
const { test, expect } = require('@playwright/test');
const { generateReviewPageHtml } = require('../../src/hh-review-page-html');
const { injectHhNav, NAV_ID } = require('../../src/hh-nav');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const VACANCIES = [
  { id: 'v1', title: 'Менеджер по продвижению на Wildberries', area: { name: 'Москва' } },
  { id: 'v2', title: 'Финансовый советник', area: { name: 'Москва' } },
];

function hubPage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-staging-'));
  const negotiation = { id: 'n1', resume: { first_name: 'Иван' }, created_at: '2026-09-05', updated_at: '2026-09-24' };
  const body = generateReviewPageHtml([negotiation], 'Менеджер WB', 'alice', '', dir, {
    vacancyId: 'v1', vacancies: VACANCIES, list: 'active',
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return injectHhNav(body, { pathname: '/hh/review', username: 'alice', token: 'tok', vacancyId: 'v1' });
}

test('vacancy picker + settings are the top nav row, section links below (#121)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.setContent(hubPage());

  const nav = page.locator(`#${NAV_ID}`);
  await expect(nav).toBeVisible();
  const picker = nav.locator('[data-testid="vacancy-picker"]');
  const settings = nav.locator('[data-testid="nav-settings"]');
  const linksRow = nav.locator('.hh-nav-links');
  await expect(picker).toBeVisible();
  await expect(settings).toBeVisible();
  await expect(linksRow).toBeVisible();

  // Exactly one picker — moved into the nav, not copied.
  await expect(nav.locator('[data-testid="vacancy-picker"]')).toHaveCount(1);

  const box = async (loc) => await loc.boundingBox();
  const p = await box(picker), s = await box(settings), l = await box(linksRow);
  // Top row: picker + settings share it (their tops differ by only a few px from
  // vertical centring). Links row starts clearly below both.
  expect(Math.abs(p.y - s.y)).toBeLessThan(20);
  expect(l.y).toBeGreaterThan(p.y + p.height - 4);
  // Scope control reads left of the menu it scopes.
  expect(p.x).toBeLessThan(l.x + 1);
});

test('the nav does not force a horizontal scroll on a phone (#121)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(hubPage());
  const nav = page.locator(`#${NAV_ID}`);
  await expect(nav).toBeVisible();
  const overflow = await nav.evaluate(el => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  // The picker is still reachable and usable at phone width.
  await expect(nav.locator('[data-testid="vacancy-picker"] select')).toBeVisible();
});

test('a page without a picker keeps the original single-row nav (#121)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const bare = '<!doctype html><html><body><main>page</main></body></html>';
  await page.setContent(injectHhNav(bare, { pathname: '/hh/plan', username: 'alice', token: 'tok' }));
  const nav = page.locator(`#${NAV_ID}`);
  await expect(nav).toBeVisible();
  await expect(nav.locator('[data-testid="vacancy-picker"]')).toHaveCount(0);
  await expect(nav.locator('.hh-nav-row')).toHaveCount(0);
  await expect(nav.locator('[data-testid="nav-settings"]')).toBeVisible();
});
