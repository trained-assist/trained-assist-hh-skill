// Issue #126, slices 3+4 in a real browser: the recruiter pressed "✦ Сгенерировать" on
// vacancy 137012564 and NOTHING happened — no text change, no error, no hint that the
// cause was a missing ATS config. Asserted against the real generated page with the HH
// endpoints stubbed at the network layer.
const { test, expect } = require('@playwright/test');
const { generateReviewPageHtml } = require('../../src/hh-review-page-html');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const NEG = '5610867713';
const VAC = '137012564';

// Absolute callback base: a relative fetch from about:blank never reaches the route stub.
function reviewPage(dir, history) {
  fs.mkdirSync(path.join(dir, 'hh', 'alice', 'candidates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'hh', 'alice', 'candidates', `${NEG}.json`), JSON.stringify({ messages: history }));
  const negotiation = {
    id: NEG, resume: { first_name: 'Леван', last_name: 'Бахтадзе' },
    created_at: '2026-09-28', updated_at: '2026-10-02',
    counters: { unread_messages: 0, messages: 5 }, has_updates: false, _state: 'response',
  };
  return generateReviewPageHtml([negotiation], 'Финансовый советник', 'alice', 'https://hh.test', dir, { vacancyId: VAC });
}

const THREAD = [
  { hh_id: '1', role: 'employer', text: 'Здравствуйте!', timestamp: '2026-09-28T10:00:00+03:00' },
  { hh_id: '2', role: 'applicant', text: '500 клиентов, портфель 6 млн, AUM почти 3 млрд', timestamp: '2026-10-01T10:00:00+03:00' },
];

test('a failed generation shows the error and leaves the page usable (#126)', async ({ page }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-fail-'));
  try {
    const draft = 'Здравствуйте! Уточните, пожалуйста, ваше «да» относится ко всем моим вопросам.';
    const candDir = path.join(dir, 'hh', 'alice', 'candidates');
    fs.mkdirSync(candDir, { recursive: true });
    fs.writeFileSync(path.join(candDir, `${NEG}.json`), JSON.stringify({
      messages: THREAD, ats_result: { draft_message: draft },
    }));
    const negotiation = {
      id: NEG, resume: { first_name: 'Леван', last_name: 'Бахтадзе' },
      created_at: '2026-09-28', updated_at: '2026-10-02',
      counters: { unread_messages: 0, messages: 5 }, has_updates: false, _state: 'response',
    };
    const html = generateReviewPageHtml([negotiation], 'Финансовый советник', 'alice', 'https://hh.test', dir, { vacancyId: VAC });
    // The route used to fail with 500 "Cannot read properties of null (reading 'required')".
    await page.route('**/hh/generate-message', async route => {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Cannot read properties of null (reading \'required\')' }) });
    });
    await page.setContent(html);

    const card = page.locator(`#tab-all .card[data-neg="${NEG}"]`);
    const btn = card.locator('.btn-gen');
    await expect(btn).toBeEnabled();
    await btn.click();

    // Visible failure, not a silent no-op.
    await expect(page.locator('.toast-err')).toContainText('Ошибка генерации');
    await expect(page.locator('.toast-err')).toContainText("reading 'required'");
    // The button came back, so the page is still usable.
    await expect(btn).toBeEnabled();
    // The draft the recruiter had is untouched — a failure must not wipe their text.
    await expect(card.locator('.msg-area')).toHaveValue(/Уточните, пожалуйста/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the no-criteria banner links into the editor with extract=1 (#126)', async ({ page }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-banner-'));
  try {
    await page.setContent(reviewPage(dir, THREAD));

    const banner = page.locator('#no-ats-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('не обновляются');
    // The extraction runs in the editor: the public edge only proxies part of the HH
    // routes, so a fetch straight from this page is 401 before reaching the agent.
    const collect = banner.locator('a[href*="extract=1"]');
    await expect(collect).toBeVisible();
    await expect(collect).toContainText('Собрать критерии');
    expect(collect).toHaveAttribute('href', /vacancy_id=137012564/);
    await expect(banner.locator('a[href*="/hh/ats-editor"]')).toHaveCount(2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the editor collects criteria on ?extract=1 and loads them into the form (#126)', async ({ page }) => {
  const { atsEditorHtml } = require('../../src/hh-ats-editor-html');
  const html = atsEditorHtml(null, null, { callbackBase: 'https://hh.test/agent', username: 'alice', pageToken: 'tok', vacancies: [{ id: 'v1', title: 'Финансовый советник' }], activeVacancyId: 'v1' });
  // The page must carry ?extract=1 in its real URL — init() reads location.search.
  await page.route('**/hh/ats-editor*', route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await page.route('**/hh/ats-extract', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ok: true,
      config: { vacancy_title: 'Финансовый советник', vacancy_context: 'private banking', required: [{ name: 'AUM от 1 млн USD на клиента', weight: 2 }], preferred: [], pass_threshold: 6.5, review_threshold: 4.0, filters: {}, interview_config: {} },
      dropped_criteria: ['аналитический склад ума'],
    }) });
  });
  await page.goto('https://hh.test/hh/ats-editor?username=alice&token=t&vacancy_id=v1&extract=1');
  // The fetched criteria land in the form and the recruiter is told to review them.
  await expect(page.locator('#fTitle')).toHaveValue('Финансовый советник');
  await expect(page.locator('#fContext')).toHaveValue('private banking');
  await expect(page.locator('#toast')).toContainText('Критерии собраны');
  await expect(page.locator('#toast')).toContainText('убрано неизмеримых: 1');
});
