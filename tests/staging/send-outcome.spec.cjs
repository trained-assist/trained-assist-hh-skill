const { test, expect } = require('@playwright/test');
const { generateReviewPageHtml } = require('../../src/hh-review-page-html');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

// The three complaints from the 01.10 recruiter report, asserted against the real
// generated page (the HH endpoints are stubbed at the network layer):
//   1. "интерфейс замирает при отправке"      → the button keeps working / always restores
//   2. "сообщение не появилось, надо сразу"   → the sent message lands in the thread instantly
//   3. "guard ловил повторное представление"  → the block is an inline choice, not a frozen modal

const NEG = 'n-guard-1';
const INTRO = 'Здравствуйте, Элла! Меня зовут Владимир, я рекрутер агентства HR Stalker.';

function pageHtml(dir, history) {
  fs.mkdirSync(path.join(dir, 'hh', 'alice', 'candidates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'hh', 'alice', 'candidates', `${NEG}.json`), JSON.stringify(history));
  const negotiation = { id: NEG, resume: { first_name: 'Элла' }, created_at: '2026-09-11', updated_at: '2026-09-30' };
  // Absolute callback base: a relative fetch from about:blank never reaches the route stub.
  return generateReviewPageHtml([negotiation], 'Финансовый советник', 'alice', 'https://hh.test', dir, { vacancyId: 'v1' });
}

async function stubSend(page, handler) {
  await page.route('**/hh/send', async route => {
    const data = await handler(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
}

test('a delivered message shows up in the thread at once, without a reload', async ({ page }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-ok-'));
  try {
    const html = pageHtml(dir, { messages: [{ hh_id: '1', role: 'applicant', text: 'Здравствуйте!', timestamp: '2026-09-11T05:38:49.635Z' }] });
    await stubSend(page, () => ({ ok: true }));
    await page.setContent(html);

    const thread = page.locator(`#tab-all .card[data-neg="${NEG}"] .hist-thread .hist-msg`);
    await expect(thread).toHaveCount(1);

    await page.locator(`#tab-all .card[data-neg="${NEG}"] .msg-area`).fill('Спасибо за отклик! Готовы созвониться.');
    await page.locator(`#tab-all .card[data-neg="${NEG}"] .btn-send`).click();

    // No reload: the delivered text is in the thread and in the counter.
    await expect(thread).toHaveCount(2);
    await expect(thread.last()).toContainText('Готовы созвониться.');
    await expect(thread.last()).toHaveClass(/just-sent/);
    await expect(page.locator(`#tab-all .card[data-neg="${NEG}"] .msg-meta`)).toContainText('1 от нас');
    await expect(page.locator(`#tab-all .card[data-neg="${NEG}"]`)).toHaveClass(/done/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a guard block offers both ways out and leaves the page usable', async ({ page }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-blocked-'));
  try {
    const html = pageHtml(dir, { messages: [{ hh_id: '1', role: 'employer', text: INTRO, timestamp: '2026-09-11T05:38:49.635Z' }] });
    let calls = 0;
    await stubSend(page, body => {
      calls++;
      return body.force ? { ok: true } : { ok: false, blocked: true, reason: 'Рекрутер снова представился' };
    });
    await page.setContent(html);

    const card = page.locator(`#tab-all .card[data-neg="${NEG}"]`);
    await card.locator('.msg-area').fill(INTRO);
    await card.locator('.btn-send').click();

    const panel = card.locator('.guard-block');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Рекрутер снова представился');
    await expect(panel.getByRole('button', { name: 'Исправить текст' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Всё равно отправить' })).toBeVisible();
    // No native modal blocked the page — the rest of the UI is still clickable.
    await expect(card.locator('.btn-gen')).toBeEnabled();

    // The send button recovered after the block (it used to stay stuck on "⏳...").
    await expect(card.locator('.btn-send')).toBeEnabled();
    await expect(card.locator('.btn-send')).toHaveText('✓ Отправить');

    // Force path sends and the message lands in the thread.
    await panel.getByRole('button', { name: 'Всё равно отправить' }).click();
    await expect(panel).toHaveCount(0);
    await expect(card.locator('.hist-thread .hist-msg')).toHaveCount(2);
    expect(calls).toBe(2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a slow request shows elapsed seconds and restores the button when it times out', async ({ page }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-slow-'));
  try {
    const html = pageHtml(dir, { messages: [] });
    await page.route('**/hh/send', async route => { await new Promise(r => setTimeout(r, 30_000)); });
    await page.setContent(html);
    await page.evaluate(() => { window.HH_ACTION_TIMEOUT_MS = 1500; });

    await page.locator(`#tab-all .card[data-neg="${NEG}"] .msg-area`).fill('Спасибо за отклик!');
    const btn = page.locator(`#tab-all .card[data-neg="${NEG}"] .btn-send`);
    await btn.click();
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveText(/Проверка и отправка \d+с/);

    // Client deadline fires and the button comes back — the page is not stuck forever.
    await expect(btn).toBeEnabled({ timeout: 20_000 });
    await expect(page.locator('.toast-err')).toContainText('проверьте переписку');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Report of 01.10: "отправил ей щас. вся запись стала серой. это чтобы я второй раз не
// отправил?" — the anti-double-send guard was a whole card frozen grey (which read as a
// broken page), while sendOne's finally block re-enabled the button anyway, so a second
// send still went through. The guard is now a visible countdown on the button itself.
test('a second send is blocked by a visible countdown, then the button comes back', async ({ page }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-cooldown-'));
  try {
    const html = pageHtml(dir, { messages: [{ hh_id: '1', role: 'applicant', text: 'Здравствуйте!', timestamp: '2026-09-11T05:38:49.635Z' }] });
    let calls = 0;
    await stubSend(page, () => {
      calls++;
      return { ok: true };
    });
    await page.setContent(html);
    // 3 s instead of the shipped 15 s so the gate stays fast; the default is pinned
    // in tests/unit/review-page-html-source.test.js.
    await page.evaluate(() => { window.HH_SEND_COOLDOWN_MS = 3000; });

    const card = page.locator(`#tab-all .card[data-neg="${NEG}"]`);
    const btn = card.locator('.btn-send');
    await card.locator('.msg-area').fill('Спасибо за отклик! Готовы созвониться.');
    await btn.click();

    // The block is visible and counted down, not a silent dead card.
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveClass(/cooldown/);
    await expect(btn).toHaveText(/Отправлено · [123]с/);
    await expect(page.locator('.toast').first()).toContainText('заблокирована');
    expect(calls).toBe(1);

    // The sent card is still readable/clickable — "серый" no longer means "frozen".
    await expect(card).not.toHaveCSS('pointer-events', 'none');
    await expect(card.locator('.msg-area')).toBeVisible();

    // …and the button is released again, so a deliberate follow-up is possible.
    await expect(btn).toBeEnabled({ timeout: 10_000 });
    await expect(btn).toHaveText('✓ Отправить');
    expect(calls).toBe(1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
