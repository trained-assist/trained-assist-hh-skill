'use strict';

// End-to-end recruiter flow with the HH API and the LLM mocked, against the REAL
// route table, in a real browser, across two origins.
//
// The journey under test is the one the recruiter actually takes:
//   review page → «✦ Сгенерировать» → the agent scores the resume against the vacancy's
//   criteria, plans the funnel step, writes the letter, saves it, the page shows it.
//
// Every other browser spec stubs the endpoints with page.route() and calls an HTML
// generator directly, so the server never runs. Here the real handleHhPublic answers,
// the real scoring/funnel/writer code runs, and only the two outside dependencies are
// replaced:
//
//   api.hh.ru  → tests/helpers/mock-hh-server.js (vacancy, resume, negotiations)
//   LLM ladder → nock (scoring verdict, writer prose, bullshit-guard verdict)
//
// Hermetic: no network, no HH token, no LLM key. The vacancy text is the real WB
// description that exposed #135, so a regression in criteria extraction or in the
// must-have block shows up as a name that stopped reaching the writer.

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

const SECRET = 'e2e-secret';
const USER = 'e2e-recruiter';
const VACANCY = '138004863';
const NEG = '5610867713';
const PAGE_ORIGIN = 'https://recruiter.example';
const TOKEN = crypto.createHmac('sha256', SECRET).update(USER).digest('hex').slice(0, 16);

// The WB vacancy text the recruiter really posted — the one whose must-haves were once
// hand-copied into the instruction field and drifted out of sync.
const WB_VACANCY = {
  id: VACANCY,
  name: 'Менеджер по продвижению на Wildberries',
  area: { name: 'Москва' },
  salary: { from: 120000, to: 140000, currency: 'RUR' },
  counters: { responses: 3 },
  published_at: '2026-09-01T00:00:00+03:00',
  manager: { id: 'mgr-1', full_name: 'Анна Рекрутер' },
  description: 'Продаём детскую одежду на Wildberries, оборот 20–30 млн ₽/мес., ~70 рабочих карточек. ' +
    'Нужен менеджер по продвижению: настройка и оптимизация внутренней рекламы (ставки, ДРР, поисковая выдача), ' +
    'знание метрик карточки (CTR, ДРР, выкуп, оборачиваемость), SEO-оптимизация карточки (семантика, заголовок, rich-контент). ' +
    'Опыт работы с карточками детской одежды на WB от 2 лет. Удалённо, 120–140 тыс ₽.',
};

const RESUME = 'Менеджер по продвижению, 4 года на маркетплейсах. ' +
  'Вёл 60+ карточек детской одежды на Wildberries, настраивал внутреннюю рекламу, держал ДРР 8–12%. ' +
  'Считаю CTR, выкуп, оборачиваемость. Работал с SEO карточки: семантика, заголовки, rich-контент.';

const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = s => new Promise(r => s.close(() => r()));

// The ladder answers several different jobs, and the discriminator has to be exact: a
// single canned answer would let the test pass while the real call routing was broken.
// messages[0] is the system prompt, so each job has a marker no other prompt contains.
// The whole conversation is recorded — the planner is handed the criteria in its USER
// message, so a system-prompt-only capture would miss them.
//   guard    — «Проверь новое сообщение», answers its own JSON shape
//   writer   — «Ты — рекрутер», answers prose
//   planner — «планировщик шага переписки», answers an action id
//   scorer   — «Оцени кандидата для позиции», answers the rubric verdict
function stubLadder({ score, letter, seen = null }) {
  nock('https://llm-ladder.trainedassist.store')
    .persist().post('/v1/chat/completions')
    .reply(200, (_uri, body) => {
      const sys = String(body.messages?.[0]?.content || '');
      const user = String(body.messages?.[1]?.content || '');
      const job = sys.includes('Проверь новое сообщение') ? 'guard'
        : sys.includes('Ты — рекрутер') ? 'writer'
        : sys.includes('планировщик шага переписки') ? 'planner'
        : sys.includes('Оцени кандидата для позиции') ? 'scorer' : 'other';
      // Recorded separately: the writer learns the must-haves from its SYSTEM prompt
      // (buildCriteriaBlock), and separately from the planner's output in its USER
      // message. A single joined blob would let one path mask a break in the other.
      if (seen) seen.push({ job, sys, user });
      if (job === 'guard') {
        return { choices: [{ message: { content: JSON.stringify({ repeated_question: false, repeated_intro: false, template_garbage: false }) } }], model: body.model };
      }
      if (job === 'writer') return { choices: [{ message: { content: letter } }], model: body.model };
      // missing_skills is deliberately empty: if the planner echoed the must-haves back
      // they would reach the writer's user prompt and hide a regression in the criteria
      // block that this test exists to catch.
      if (job === 'planner') return { choices: [{ message: { content: JSON.stringify({ action: 'propose_test', missing_skills: [] }) } }], model: body.model };
      if (job === 'scorer') return { choices: [{ message: { content: JSON.stringify(score) } }], model: body.model };
      return { choices: [{ message: { content: letter } }], model: body.model };
    });
}

async function boot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-flow-e2e-'));
  const users = path.join(root, 'users');
  const ctx = {
    BASE_USERS_DIR: users, PORT: 0, secrets: {},
    getSecretsCache: () => ({}), readChatId: () => null,
    runMcpTool: async () => JSON.stringify({ ok: true, enabled: false }),
  };

  const saved = Object.fromEntries(['AGENT_SECRET', 'AGENT_DATA_DIR', 'AGENT_TOKENS_DIR', 'USERS_DIR', 'LLM_LADDER_TOKEN', 'HH_API_BASE_URL'].map(k => [k, process.env[k]]));
  process.env.AGENT_SECRET = SECRET;
  process.env.AGENT_DATA_DIR = path.join(root, 'data');
  process.env.AGENT_TOKENS_DIR = path.join(root, 'tokens');
  process.env.USERS_DIR = users;
  process.env.LLM_LADDER_TOKEN = 'e2e-ladder-token';

  // The recruiter's global template, as /hh/style saved it.
  const tokenDir = path.join(root, 'tokens', USER);
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(path.join(tokenDir, 'hh-message-instructions-template'),
    'Уточняй ТОЛЬКО обязательные требования (мастхевы), которых нет в резюме и в ответах кандидата, — по одному вопросу в строке.');
  // The HH token the route reads to fetch the resume and the vacancy.
  fs.writeFileSync(path.join(tokenDir, 'hh'), JSON.stringify({ access_token: 'e2e-hh-token', employer_id: 'emp-1' }));

  // The vacancy's ATS config — the four must-haves the writer must be told about.
  const hhDir = path.join(users, USER, 'contexts', 'hh');
  fs.mkdirSync(hhDir, { recursive: true });
  fs.writeFileSync(path.join(hhDir, `ats_config:${VACANCY}.json`), JSON.stringify({
    value: {
      vacancy_id: VACANCY,
      vacancy_title: WB_VACANCY.name,
      vacancy_context: 'Детская одежда на Wildberries, оборот 20–30 млн ₽/мес.',
      required: [
        { name: 'опыт работы с карточками детской одежды на WB от 2 лет', weight: 3 },
        { name: 'настройка и оптимизация внутренней рекламы WB: ставки, ДРР, поисковая выдача', weight: 3 },
        { name: 'знание метрик карточки WB: CTR, ДРР, выкуп, оборачиваемость', weight: 2 },
        { name: 'SEO-оптимизация карточки на WB: семантика, заголовок, rich-контент', weight: 2 },
      ],
      preferred: [{ name: 'работа в MPStats', weight: 1.5 }],
      pass_threshold: 7.5, review_threshold: 5, filters: {},
      interview_config: { invite_call_enabled: false },
    },
    updated_at: new Date().toISOString(),
  }, null, 2));

  // The candidate: a resume and one applicant reply, so the route takes the «reply» path.
  const candDir = path.join(root, 'data', 'hh', USER, 'candidates');
  fs.mkdirSync(candDir, { recursive: true });
  fs.writeFileSync(path.join(candDir, `${NEG}.json`), JSON.stringify({
    messages: [
      { hh_id: '1', role: 'employer', text: 'Здравствуйте! Расскажите про опыт с карточками на WB.', timestamp: '2026-09-28T10:00:00+03:00' },
      { hh_id: '2', role: 'applicant', text: RESUME, timestamp: '2026-10-01T10:00:00+03:00' },
    ],
  }, null, 2));

  // The mock HH API, then point the agent at it.
  const hh = createMockHhServer({
    vacancies: [WB_VACANCY],
    negotiations: [{
      id: NEG,
      resume: { first_name: 'Леван', last_name: 'Бахтадзе' },
      created_at: '2026-09-28', updated_at: '2026-10-01',
      counters: { unread_messages: 0, messages: 2 }, has_updates: false, _state: 'response',
    }],
  });
  await hh.start();
  process.env.HH_API_BASE_URL = hh.baseUrl;

  const agent = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (await handleHhPublic(req, url, res, ctx) === false) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not an hh route' }));
    }
  });
  const agentPort = await listen(agent);
  const agentBase = `http://127.0.0.1:${agentPort}`;

  // The recruiter's nginx: serves the review page, proxies /hh/* to the agent.
  const negotiation = {
    id: NEG, resume: { first_name: 'Леван', last_name: 'Бахтадзе' },
    created_at: '2026-09-28', updated_at: '2026-10-01',
    counters: { unread_messages: 0, messages: 2 }, has_updates: false, _state: 'response',
  };
  const page = http.createServer((req, res) => {
    if (req.url.startsWith('/hh/review')) {
      // The route resolves candidate history through dataRoot() (= AGENT_DATA_DIR), so
      // the page must be handed the same base — passing the temp root instead would have
      // it look in <root>/hh/... while the route writes <root>/data/hh/....
      const html = generateReviewPageHtml([negotiation], WB_VACANCY.name, USER, agentBase, path.join(root, 'data'), { vacancyId: VACANCY });
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
    async stop() {
      await close(page); await close(agent); await hh.stop();
      for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      nock.cleanAll();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const MUST_HAVE_NAMES = [
  'опыт работы с карточками детской одежды на WB от 2 лет',
  'настройка и оптимизация внутренней рекламы WB: ставки, ДРР, поисковая выдача',
  'знание метрик карточки WB: CTR, ДРР, выкуп, оборачиваемость',
  'SEO-оптимизация карточки на WB: семантика, заголовок, rich-контент',
];

const LETTER = 'Леван, спасибо за цифры — 60 карточек и ДРР 8–12% это видно. ' +
  'Уточните, пожалуйста, какой объём продаж в месяц вы держали и сколько карточек выводили из топа в топ.';

test.describe('recruiter flow with HH API and LLM mocked', () => {
  let stack;
  test.beforeEach(async () => { stack = await boot(); });
  test.afterEach(async () => { await stack.stop(); });

  test('«✦ Сгенерировать» writes a letter that asks about the vacancy must-haves', async ({ page }) => {
    stubLadder({
      score: { score: 8, verdict: 'pass', criteria: { 'опыт работы с карточками детской одежды на WB от 2 лет': 3, 'настройка и оптимизация внутренней рекламы WB: ставки, ДРР, поисковая выдача': 3 } },
      letter: LETTER,
    });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(stack.reviewUrl);

    const card = page.locator(`#tab-all .card[data-neg="${NEG}"]`);
    await expect(card.locator('.btn-gen').first()).toBeVisible();
    await card.locator('.btn-gen').first().click();

    // The letter lands in the textarea without a reload, and it asks about a must-have.
    const area = card.locator('.msg-area').first();
    await expect(area).toHaveValue(/Леван, спасибо за цифры/);
    await expect(area).toHaveValue(/объём продаж/);
    expect(errors, 'no uncaught JS').toEqual([]);
  });

  test('the writer is told the vacancy must-haves — the thing that went stale by hand', async ({ page }) => {
    const seen = [];
    stubLadder({
      score: { score: 8, verdict: 'pass', criteria: {} },
      letter: LETTER, seen,
    });
    await page.goto(stack.reviewUrl);
    const card = page.locator(`#tab-all .card[data-neg="${NEG}"]`);
    await card.locator('.btn-gen').first().click();
    await expect(card.locator('.msg-area').first()).toHaveValue(/Леван, спасибо за цифры/);

    // The letter text is stubbed, so asserting on it would prove nothing about the
    // prompt. Assert on the prompts themselves.
    //
    // Writer: every must-have must be in its SYSTEM prompt (buildCriteriaBlock). The
    // planner stub above returns empty missing_skills, so the user message cannot supply
    // them — a break in the criteria block therefore fails this and nothing else can
    // cover for it.
    const writer = seen.find(s => s.job === 'writer');
    expect(writer, 'the writer was called').toBeTruthy();
    for (const name of MUST_HAVE_NAMES) {
      expect(writer.sys, `writer SYSTEM prompt must contain the must-have "${name}"`).toContain(name);
      expect(writer.user, `writer USER prompt must NOT get must-haves from the planner stub`).not.toContain(name);
    }
    // Planner: it is handed the same criteria, so it decides against the real rubric.
    const planner = seen.find(s => s.job === 'planner');
    expect(planner, 'the funnel planner was called').toBeTruthy();
    for (const name of MUST_HAVE_NAMES) {
      expect(planner.user, `planner prompt must contain the must-have "${name}"`).toContain(name);
    }
    // The guard must have been consulted — a draft that skipped it is not a draft.
    expect(seen.some(s => s.job === 'guard'), 'the bullshit guard was consulted').toBe(true);
  });

  test('the letter is persisted, so a reload shows it instead of an empty box', async ({ page }) => {
    stubLadder({
      score: { score: 8, verdict: 'pass', criteria: {} },
      letter: LETTER,
    });
    await page.goto(stack.reviewUrl);
    const card = page.locator(`#tab-all .card[data-neg="${NEG}"]`);
    await card.locator('.btn-gen').first().click();
    await expect(card.locator('.msg-area').first()).toHaveValue(/Леван, спасибо за цифры/);

    // Reload: the draft comes back from disk, proving the write was saved.
    await page.reload();
    await expect(card.locator('.msg-area').first()).toHaveValue(/Леван, спасибо за цифры/);
  });

  test('a guard block keeps the page usable instead of swallowing the failure', async ({ page }) => {
    stubLadder({
      score: { score: 8, verdict: 'pass', criteria: {} },
      letter: LETTER,
    });
    await page.goto(stack.reviewUrl);
    const card = page.locator(`#tab-all .card[data-neg="${NEG}"]`);
    await card.locator('.btn-gen').first().click();
    await expect(card.locator('.msg-area').first()).toHaveValue(/Леван, спасибо за цифры/);
    // The send button is still there and enabled — a blocked send must not strand the UI.
    await expect(card.locator('.btn-send').first()).toBeEnabled();
  });
});
