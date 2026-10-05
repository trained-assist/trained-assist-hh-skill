'use strict';
// Audit #166 — real-click verification of the review page selection model.
// Read-only: no sends, no rejections (bulk buttons are inspected, not clicked).

const { test, expect } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const nock = require('nock');

const { handleHhPublic } = require('../../src/hh-routes');
const { generateReviewPageHtml } = require('../../src/hh-review-page-html');
const { createMockHhServer } = require('../helpers/mock-hh-server');

const SECRET = 'audit-secret';
const USER = 'audit-recruiter';
const VACANCY = '138004863';
const TOKEN = crypto.createHmac('sha256', SECRET).update(USER).digest('hex').slice(0, 16);

const WB_VACANCY = {
  id: VACANCY, name: 'Менеджер по продвижению на Wildberries',
  area: { name: 'Москва' }, salary: { from: 120000, to: 140000, currency: 'RUR' },
  counters: { responses: 3 }, published_at: '2026-09-01T00:00:00+03:00',
  manager: { id: 'mgr-1', full_name: 'Анна Рекрутер' }, description: 'WB.',
};
const NEG_A = '111'; const NEG_B = '222'; const NEG_C = '333';
const mkNeg = (id, name) => ({
  id, resume: { first_name: name, last_name: 'Тестов' },
  created_at: '2026-09-28', updated_at: '2026-10-01',
  counters: { unread_messages: 0, messages: 2 }, has_updates: false, _state: 'response',
});

const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = s => new Promise(r => s.close(() => r()));

async function boot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-audit-click-'));
  const users = path.join(root, 'users');
  const ctx = { BASE_USERS_DIR: users, PORT: 0, secrets: {}, getSecretsCache: () => ({}), readChatId: () => null, runMcpTool: async () => JSON.stringify({ ok: true, enabled: false }) };
  const saved = Object.fromEntries(['AGENT_SECRET', 'AGENT_DATA_DIR', 'AGENT_TOKENS_DIR', 'USERS_DIR', 'LLM_LADDER_TOKEN', 'HH_API_BASE_URL'].map(k => [k, process.env[k]]));
  process.env.AGENT_SECRET = SECRET;
  process.env.AGENT_DATA_DIR = path.join(root, 'data');
  process.env.AGENT_TOKENS_DIR = path.join(root, 'tokens');
  process.env.USERS_DIR = users;
  process.env.LLM_LADDER_TOKEN = 'audit-ladder';
  nock.enableNetConnect(/127\.0\.0\.1|localhost/);
  nock('https://llm-ladder.trainedassist.store').persist().post('/v1/chat/completions')
    .reply(200, (_u, body) => ({ choices: [{ message: { content: '{"verdict":"pass","score":8}' }, model: body.model }], model: body.model }));

  const tokenDir = path.join(root, 'tokens', USER);
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(path.join(tokenDir, 'hh'), JSON.stringify({ access_token: 'audit-hh-token', employer_id: 'emp-1' }));
  fs.writeFileSync(path.join(tokenDir, 'hh-message-instructions-template'), 'Уточняй мастхевы.');
  const hhDir = path.join(users, USER, 'contexts', 'hh');
  fs.mkdirSync(hhDir, { recursive: true });
  fs.writeFileSync(path.join(hhDir, `ats_config:${VACANCY}.json`), JSON.stringify({
    value: { vacancy_id: VACANCY, vacancy_title: WB_VACANCY.name, vacancy_context: 'WB.',
      required: [{ name: 'опыт WB', weight: 3 }], preferred: [], pass_threshold: 7.5, review_threshold: 5, filters: {},
      interview_config: { invite_call_enabled: false } },
    updated_at: new Date().toISOString(),
  }, null, 2));

  const candDir = path.join(root, 'data', 'hh', USER, 'candidates');
  fs.mkdirSync(candDir, { recursive: true });
  const writeCand = (id, name, score, stale) => fs.writeFileSync(path.join(candDir, `${id}.json`), JSON.stringify({
    ats_result: score != null ? { score, verdict: 'pass', matched: [], gaps: [] } : null,
    message_draft: stale ? { text: 'Старый черновик до изменения сценария.', config_version: 'v1' } : null,
    communication_steps: null,
    messages: [
      { hh_id: '1', role: 'employer', text: 'Здравствуйте!', timestamp: '2026-09-28T10:00:00+03:00' },
      { hh_id: '2', role: 'applicant', text: 'Опыт с карточками на WB.', timestamp: '2026-10-01T10:00:00+03:00' },
    ],
  }, null, 2));
  writeCand(NEG_A, 'Анна', 10, false);
  writeCand(NEG_B, 'Борис', 8, false);
  writeCand(NEG_C, 'Вера', 9, true);

  const hh = createMockHhServer({ vacancies: [WB_VACANCY], negotiations: [mkNeg(NEG_A, 'Анна'), mkNeg(NEG_B, 'Борис'), mkNeg(NEG_C, 'Вера')] });
  await hh.start();
  process.env.HH_API_BASE_URL = hh.baseUrl;

  const agent = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (await handleHhPublic(req, url, res, ctx) === false) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not an hh route' })); }
  });
  const agentPort = await listen(agent);
  const agentBase = `http://127.0.0.1:${agentPort}`;
  const page = http.createServer((req, res) => {
    if (req.url.startsWith('/hh/review')) {
      const html = generateReviewPageHtml([mkNeg(NEG_A, 'Анна'), mkNeg(NEG_B, 'Борис'), mkNeg(NEG_C, 'Вера')], WB_VACANCY.name, USER, agentBase, path.join(root, 'data'), { vacancyId: VACANCY, communicationEnabled: true });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    const url = new URL(req.url, agentBase);
    const proxied = http.request({ hostname: '127.0.0.1', port: agentPort, path: url.pathname + url.search, method: req.method, headers: req.headers },
      up => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
    req.pipe(proxied);
    proxied.on('error', () => { res.writeHead(502); res.end(); });
  });
  const pagePort = await listen(page);
  return {
    reviewUrl: `http://127.0.0.1:${pagePort}/hh/review?username=${USER}&token=${TOKEN}&vacancy_id=${VACANCY}`,
    async stop() { await close(page); await close(agent); await hh.stop(); for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v); nock.cleanAll(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

// Active-tab-scoped helpers: the page renders the same candidates into several tab
// panels, so queries must be scoped to .tab-panel.active to be meaningful.
const activeSendCbs = page => page.$$eval('.tab-panel.active .card-cb', cbs => cbs.map(c => ({ id: c.id, checked: c.checked, score: c.dataset.score, stale: c.dataset.stale })));
const activeRejCbs = page => page.$$eval('.tab-panel.active .reject-cb', cbs => cbs.map(c => ({ id: c.id, checked: c.checked })));

test('review: score buttons toggle send-checkbox for matching score only', async ({ page }) => {
  const env = await boot();
  try {
    await page.goto(env.reviewUrl);
    const before = await activeSendCbs(page);
    console.log('active send-cbs before:', JSON.stringify(before));
    const checkedIds = before.filter(c => c.checked).map(c => c.id);
    // Non-stale actionable cards are auto-checked; the stale one is not.
    const staleEntry = before.find(c => c.stale === '1');
    expect(staleEntry).toBeTruthy();
    expect(checkedIds).not.toContain(staleEntry.id);

    // Click score "10" → all score-10 cards become checked (select-by-score).
    await page.click('.score-btn[data-bucket="10"]');
    let tenCard = (await activeSendCbs(page)).find(c => Math.round(parseFloat(c.score)) === 10);
    console.log('score-10 card after 1st click:', JSON.stringify(tenCard));
    expect(tenCard.checked).toBe(true);

    // Click score "10" again → bucket removed → score-10 cards unchecked (toggle off).
    await page.click('.score-btn[data-bucket="10"]');
    tenCard = (await activeSendCbs(page)).find(c => Math.round(parseFloat(c.score)) === 10);
    console.log('score-10 card after 2nd click:', JSON.stringify(tenCard));
    expect(tenCard.checked).toBe(false);

    // Score buttons never touch reject-cbs.
    const rej = await activeRejCbs(page);
    console.log('reject-cbs checked after score clicks:', rej.filter(c => c.checked).length);
    expect(rej.every(c => !c.checked)).toBe(true);
  } finally { await env.stop(); }
});

test('review: select-all and bulk count are scoped to the active tab', async ({ page }) => {
  const env = await boot();
  try {
    await page.goto(env.reviewUrl);
    await page.click('.tab-btn:has-text("Неотвеченные")');
    const panel = await page.$eval('.tab-panel.active', el => el.id);
    const cardsInPanel = await page.$$eval('.tab-panel.active .card', els => els.length);
    console.log('active panel:', panel, '| cards:', cardsInPanel);

    await page.click('button:has-text("Выбрать все")');
    const selCount = await page.$eval('#selCount', el => el.textContent);
    const sendAllLabel = await page.$eval('#sendAllBtn', el => el.textContent);
    console.log('selCount:', selCount, '| sendAllBtn:', sendAllLabel);
    expect(Number(selCount)).toBe(cardsInPanel);
    expect(sendAllLabel).toContain(String(cardsInPanel));
  } finally { await env.stop(); }
});

test('review: stale card shows a guard and is not auto-selected', async ({ page }) => {
  const env = await boot();
  try {
    await page.goto(env.reviewUrl);
    const banners = await page.$$eval('.tab-panel.active .draft-stale', els => els.length);
    const staleCard = await page.$eval('.tab-panel.active .card:has(.draft-stale)', el => ({
      sendStale: el.querySelector('.btn-send')?.dataset.stale,
      sendChecked: el.querySelector('.card-cb')?.checked,
    }));
    console.log('active stale banners:', banners, '| stale card:', JSON.stringify(staleCard));
    expect(banners).toBeGreaterThan(0);
    expect(staleCard.sendStale).toBe('1');
    expect(staleCard.sendChecked).toBe(false);
  } finally { await env.stop(); }
});
