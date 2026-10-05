const { test, expect } = require('@playwright/test');
const { generateReviewPageHtml } = require('../../src/hh-review-page-html');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

test('300-candidate regeneration runs through a persistent server queue and keeps hand edits', async ({ page }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-regeneration-300-'));
  try {
    const negotiations = Array.from({ length: 300 }, (_, i) => ({
      id: `neg-${i}`, resume: { first_name: `Candidate${i}` }, created_at: '2026-10-01', updated_at: '2026-10-05',
    }));
    const historyDir = path.join(dir, 'hh', 'alice', 'candidates');
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(path.join(historyDir, 'neg-1.json'), JSON.stringify({ ats_result: {
      verdict: 'ПРОПУСТИТЬ', score: 9.2, draft_message: 'Old stale draft',
    }, messages: [] }));
    const html = generateReviewPageHtml(negotiations, 'Vacancy', 'alice', 'https://hh.test', dir, { vacancyId: 'vac1', communicationEnabled: true });
    let startPayload, statusReads = 0;
    await page.route('https://hh.test/hh/review-regeneration-start', async route => {
      startPayload = route.request().postDataJSON();
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ job_id: 'job-300', status: 'running', total: startPayload.negotiation_ids.length, concurrency: 3 }) });
    });
    await page.route('https://hh.test/hh/review-regeneration-status**', async route => {
      statusReads += 1;
      if (statusReads === 1) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          id: 'job-300', status: 'running', revision: 2, total: 299, concurrency: 3,
          counts: { queued: 296, running: 3, succeeded: 0, failed: 0 }, average_duration_ms: 50_000,
          changes: [{ negotiation_id: 'neg-1', status: 'running' }],
        }) });
      } else {
        const changes = startPayload.negotiation_ids.map(id => ({ negotiation_id: id, status: 'succeeded', message: `Draft for ${id}`, funnel_action: 'ask_skills' }));
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          id: 'job-300', status: 'completed', revision: 303, total: 299, concurrency: 3,
          counts: { queued: 0, running: 0, succeeded: 299, failed: 0 }, average_duration_ms: 50_000, changes,
        }) });
      }
    });
    let sendPayload;
    await page.route('https://hh.test/hh/send', async route => {
      sendPayload = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    let dialogCount = 0;
    page.on('dialog', dialog => { dialogCount += 1; dialog.accept(); });
    await page.setContent(html);
    await page.locator('#tab-all .card[data-neg="neg-0"] .msg-area').fill('Recruiter hand edit stays here');
    await page.locator('#regenAllBtn').click();
    await expect.poll(() => startPayload?.negotiation_ids.length).toBe(299);
    expect(startPayload.negotiation_ids).not.toContain('neg-0');
    await expect(page.locator('#bulkGenerationStatus')).toContainText('Можно закрыть страницу');
    await expect(page.locator('#bulkGenerationStatus')).toContainText('Перегенерация завершена: 299/299 успешно', { timeout: 8000 });
    await expect(page.locator('#tab-all .card[data-neg="neg-0"] .msg-area')).toHaveValue('Recruiter hand edit stays here');
    await expect(page.locator('#tab-all .card[data-neg="neg-1"] .msg-area')).toHaveValue('Draft for neg-1');
    await expect(page.locator('#tab-all .card[data-neg="neg-1"] .draft-stale')).toHaveCount(0);
    await expect(page.locator('#tab-all .card[data-neg="neg-1"] .card-cb')).toBeChecked();
    await page.locator('#tab-all .card[data-neg="neg-1"] .btn-send').click();
    await expect.poll(() => sendPayload?.message).toBe('Draft for neg-1');
    expect(dialogCount).toBe(1);
    expect(statusReads).toBeGreaterThanOrEqual(2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
