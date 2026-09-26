'use strict';

// Replay gate for the recruiting cold-search happy path: same flow as the
// browser journey, but deterministic and offline. Mock exactly two boundaries —
// the LLM (recorded Nock fixture) and the external HH platform (loopback HTTP
// fixture). The MCP server, registry, transport, snapshot store and the real
// generated HTML all run for real. No LLM judge here: CI is replay.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFixture } = require('../../tests/support/hh-fixture.cjs');

test('MCP cold search → HH + LLM fixtures → durable snapshot → real HTML → recall after restart', async () => {
  const f = await createFixture({ llm: true });
  try {
    const catalog = (await f.client.request('tools/list')).result.tools;
    assert.ok(catalog.map((t) => t.name).includes('hh_proactive_search'));

    const vacancies = await f.client.call('hh_list_vacancies');
    assert.equal(vacancies.vacancies[0].manager, 'Тестовый рекрутер');

    const result = await f.client.call('hh_proactive_search', { vacancy_id: vacancies.vacancies[0].id });
    assert.equal(result.error, undefined);
    assert.equal(result.ok, true);
    assert.equal(result.count, 2);

    // The LLM boundary was hit exactly for query generation + two assessments.
    assert.equal(f.llmRequests().length, 3);
    assert.ok(f.llmRequests()[0].messages[0].content.includes('Инженер Node.js'));

    // HH was queried through repeated query params, GET only.
    const searches = f.requests.filter((r) => r.path === '/resumes');
    assert.equal(searches.length, 1);
    assert.equal(searches[0].query.text, 'Инженер Node.js');
    assert.equal(searches[0].query.area, '2');
    assert.equal(searches[0].auth, 'Bearer fixture-only');
    assert.ok(f.requests.every((r) => r.method === 'GET'));
    assert.equal(new URL(result.url).searchParams.get('vacancy_id'), '100');

    // The generated page is real HTML served from the local boundary.
    const page = await fetch(result.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Опыт соответствует тестовой вакансии/);
    assert.match(html, /https:\/\/hh\.ru\/resume\/r/);

    // Recall survives provider process death, not only a browser reload.
    const before = f.requests.filter((r) => r.path === '/resumes').length;
    await f.restart();
    const recalled = await f.client.call('hh_proactive_view', { vacancy_id: '100' });
    assert.equal(recalled.url, result.url);
    assert.equal(recalled.count, 2);
    assert.equal(f.requests.filter((r) => r.path === '/resumes').length, before, 'recall must not re-query HH');

    // A forbidden search is reported as an error, and the provider recovers.
    f.setSearchStatus(403);
    const forbidden = await f.client.call('hh_proactive_search', { vacancy_id: '100' });
    assert.ok(/403|доступ/i.test(JSON.stringify(forbidden)), 'forbidden search must surface an error');
    f.setSearchStatus(200);
    const recovered = await f.client.call('hh_proactive_search', { vacancy_id: '100' });
    assert.equal(recovered.error, undefined);

    assert.deepEqual(f.unexpected, []);
  } finally {
    await f.close();
  }
});
