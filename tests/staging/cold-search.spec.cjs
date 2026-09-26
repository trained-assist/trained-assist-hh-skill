const { test, expect } = require('@playwright/test');
const { createFixture } = require('../support/hh-fixture.cjs');

test('MCP discovery → HH + LLM → durable result → browser → recall and failure recovery', async ({ page }) => {
  const f = await createFixture({ llm: true });
  const pageErrors = [], blocked = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === f.baseUrl) return route.continue();
    blocked.push(route.request().url()); return route.abort('blockedbyclient');
  });
  try {
    const catalog = (await f.client.request('tools/list')).result.tools;
    expect(catalog.map(t => t.name)).toContain('hh_proactive_search');
    const vacancies = await f.client.call('hh_list_vacancies');
    expect(vacancies.vacancies[0].manager).toBe('Тестовый рекрутер');
    const result = await f.client.call('hh_proactive_search', { vacancy_id: vacancies.vacancies[0].id });
    expect(result.error).toBeUndefined(); expect(result.count).toBe(2); expect(result.ok).toBe(true);
    expect(f.llmRequests().length).toBe(3); // query generation + two candidate assessments
    expect(f.llmRequests()[0].messages[0].content).toContain('Инженер Node.js');
    const hhSearch = f.requests.filter(r => r.path === '/resumes');
    expect(hhSearch).toHaveLength(1); expect(hhSearch[0].query).toMatchObject({ area: '2', text: 'Инженер Node.js' });
    expect(f.requests.every(r => r.method === 'GET')).toBe(true);
    expect(new URL(result.url).searchParams.get('vacancy_id')).toBe('100');
    const response = await page.goto(result.url);
    expect(response.status()).toBe(200);
    await expect(page.locator('.card')).toHaveCount(2);
    await expect(page.locator('.card').first()).toContainText('Опыт соответствует тестовой вакансии');
    await expect(page.locator('.btn-hh').first()).toHaveAttribute('href', /https:\/\/hh.ru\/resume\/r/);
    await page.locator('#nameSearch').fill('Инженер');
    await expect(page.locator('.card:visible')).toHaveCount(1);
    await page.reload(); // filter and candidates survive reload
    await expect(page.locator('#nameSearch')).toHaveValue('Инженер');
    await expect(page.locator('.card:visible')).toHaveCount(1);
    await page.locator('#nameSearch').fill('нет-такого-кандидата');
    await expect(page.locator('#emptyState')).toBeVisible();
    await page.locator('#nameSearch').fill('');
    await expect(page.locator('.card:visible')).toHaveCount(2);
    const beforeRecall = f.requests.filter(r => r.path === '/resumes').length;
    await f.restart(); // recall must survive provider process death, not only a browser reload
    const recalled = await f.client.call('hh_proactive_view', { vacancy_id: '100' });
    expect(recalled.url).toBe(result.url); expect(recalled.count).toBe(2);
    expect(f.requests.filter(r => r.path === '/resumes').length).toBe(beforeRecall);
    f.setSearchStatus(403);
    const dialog = page.waitForEvent('dialog');
    await page.locator('#searchBtn').click();
    const errorDialog = await dialog;
    expect(errorDialog.message()).toContain('403'); await errorDialog.accept();
    await expect(page.locator('#searchBtn')).toBeEnabled();
    await page.reload(); await expect(page.locator('.card')).toHaveCount(2);
    f.setSearchStatus(200);
    await page.locator('#searchBtn').click();
    await expect(page.locator('#searchBtn')).toHaveText(/Новый поиск/);
    await expect(page.locator('.card')).toHaveCount(2);
    expect((await f.client.call('hh_proactive_search', { vacancy_id: '100' })).new_count).toBe(0);
    expect(pageErrors).toEqual([]); expect(blocked).toEqual([]); expect(f.unexpected).toEqual([]);
  } finally { await f.close(); }
});
