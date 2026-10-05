'use strict';
// Epic #168 (P0 from audit #166): on /hh/review the bulk send used to leave for
// real candidates with no confirmation at all unless a draft was stale, the
// score buttons read as ratings, and nothing said that a bulk action covers only
// the open tab. Real rendered page, stubbed HH endpoints — nothing reaches HH.
//
// The same journey is asserted at 360 / 390 / desktop: a recruiter on a phone
// must see the same scope and the same confirmation as on a wide screen.
const { test, expect } = require('@playwright/test');
const { generateReviewPageHtml } = require('../../src/hh-review-page-html');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const WIDTHS = [{ name: '360', width: 360, height: 740 }, { name: '390', width: 390, height: 844 }, { name: 'desktop', width: 1280, height: 900 }];

function buildPage(dir) {
  fs.mkdirSync(path.join(dir, 'hh', 'bob', 'candidates'), { recursive: true });
  const negotiation = { id: 'neg-1', resume: { first_name: 'Мария' }, created_at: '2026-09-28', updated_at: '2026-10-01' };
  fs.writeFileSync(path.join(dir, 'hh', 'bob', 'candidates', 'neg-1.json'), JSON.stringify({
    ats_result: { draft_message: 'Готовы обсудить условия', verdict: 'ПРОПУСТИТЬ', score: 9 },
    messages: [{ hh_id: '1', role: 'applicant', text: 'Здравствуйте!', timestamp: '2026-09-28T05:38:49.635Z' }],
  }));
  return generateReviewPageHtml([negotiation], 'Финансовый советник', 'bob', 'https://hh.test', dir, { vacancyId: 'v1', communicationEnabled: true });
}

for (const view of WIDTHS) {
  test(`a recruiter on ${view.name}px confirms who receives the bulk letters (#168)`, async ({ page }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bulk-${view.name}-`));
    try {
      await page.setViewportSize({ width: view.width, height: view.height });
      const sent = [];
      await page.route('**/hh/send', async route => {
        sent.push(route.request().postDataJSON());
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      });
      await page.setContent(buildPage(dir));

      // The scope is stated on the page itself, not only in a dialog nobody sees
      // until after the letters are gone.
      await expect(page.locator('#bulkScopeHint')).toContainText('только на открытой вкладке');
      await expect(page.locator('#sendAllBtn')).toContainText('на вкладке');

      // Score buckets read as a selection.
      await expect(page.locator('.score-btn[data-bucket="9"]')).toHaveAttribute('aria-label', 'Выбрать со скором 9');
      await page.locator('.score-btn[data-bucket="9"]').click();
      await expect(page.locator('#tab-all .card[data-neg="neg-1"] .card-cb')).toBeChecked();

      // Nothing leaves before an explicit "yes, these N people". A draft that
      // HH marked stale asks twice (scope first, then the override) — both are
      // captured, the first is the one #168 is about.
      const questions = [];
      let answerFirst = false;
      page.on('dialog', async dialog => {
        questions.push(dialog.message());
        if (answerFirst) await dialog.accept(); else await dialog.dismiss();
      });
      await page.locator('#sendAllBtn').click();
      expect(questions[0]).toContain('Отправить 1 письмо');
      expect(sent).toHaveLength(0);
      await expect(page.locator('#tab-all .card[data-neg="neg-1"]')).not.toHaveClass(/done/);

      // Same question, this time accepted.
      answerFirst = true;
      await page.locator('#sendAllBtn').click();
      await expect.poll(() => sent.length).toBe(1);
      expect(sent[0]).toMatchObject({ negotiation_id: 'neg-1', message: 'Готовы обсудить условия' });
      await expect(page.locator('#tab-all .card[data-neg="neg-1"]')).toHaveClass(/done/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test(`bulk rejection is selected explicitly at ${view.name}px (#168)`, async ({ page }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bulk-reject-${view.name}-`));
    try {
      await page.setViewportSize({ width: view.width, height: view.height });
      await page.route('**/hh/send-and-reject', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }));
      await page.setContent(buildPage(dir));

      const rejectBox = page.locator('#tab-all .card[data-neg="neg-1"] .reject-cb');
      await expect(rejectBox).not.toBeChecked();

      let question = '';
      let acceptSelection = false;
      page.on('dialog', async dialog => {
        question = dialog.message();
        if (acceptSelection) await dialog.accept(); else await dialog.dismiss();
      });
      await page.locator('#selectRejectAllBtn').click();
      expect(question).toContain('Отметить 1 кандидатов');
      await expect(rejectBox).not.toBeChecked();

      acceptSelection = true;
      await page.locator('#selectRejectAllBtn').click();
      await expect(rejectBox).toBeChecked();
      await expect(page.locator('#rejectAllBtn')).toContainText('Отказать (1) на вкладке');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}