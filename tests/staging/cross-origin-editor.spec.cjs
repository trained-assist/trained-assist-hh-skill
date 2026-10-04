'use strict';

// Cross-origin e2e against the REAL route table, in a real browser.
//
// Why this file exists. Every other browser spec calls an HTML generator directly
// (atsEditorHtml(), generateReviewPageHtml()) and stubs the endpoints with page.route().
// That means the whole server layer — the route table, the headers, the OPTIONS
// preflight — was only ever executed by production. It cost two bugs that reached the
// recruiter identically, as «Ошибка сети»:
//
//   GET  /hh/message-instructions-template  — no Access-Control-Allow-Origin (#135)
//   POST /hh/response-state                — no Access-Control-Allow-Origin
//
// Both are fetched by a page from CALLBACK_BASE, a different origin than the page
// itself, so the browser discards even a correct 200 when the header is absent. This
// reproduces the prod shape on loopback: two servers on two ports, the real
// handleHhPublic behind the agent port, a real Chromium reading the real response.
//
// Hermetic: no network, no HH token, no LLM. The vacancy is written straight into the
// per-vacancy ATS config the route reads.

const { test, expect } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { handleHhPublic } = require('../../src/hh-routes');
const { atsEditorHtml } = require('../../src/hh-ats-editor-html');

const SECRET = 'e2e-secret';
const USER = 'e2e-recruiter';
const VACANCY = '138004863';
const PAGE_ORIGIN = 'https://recruiter.example';
const TOKEN = crypto.createHmac('sha256', SECRET).update(USER).digest('hex').slice(0, 16);

// The must-haves of the real WB vacancy that exposed the bug, verbatim, so a regression
// in the dynamic injection shows up as a name that stopped arriving.
const MUST_HAVES = [
  'опыт работы с карточками детской одежды на WB от 2 лет',
  'настройка и оптимизация внутренней рекламы WB: ставки, ДРР, поисковая выдача',
  'знание метрик карточки WB: CTR, ДРР, выкуп, оборачиваемость',
  'SEO-оптимизация карточки на WB: семантика, заголовок, rich-контент',
];

const listen = (server) => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const close = (server) => new Promise(r => server.close(() => r()));

/**
 * The prod shape, on loopback:
 *   agent — the real handleHhPublic, standing in for AGENT_PUBLIC_URL (CALLBACK_BASE)
 *   page  — the recruiter's nginx: serves the editor page and proxies /hh/* to the
 *           agent, so the page origin and CALLBACK_BASE differ as they do in prod.
 */
async function bootStack() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-cors-e2e-'));
  const users = path.join(root, 'users');
  const ctx = {
    BASE_USERS_DIR: users, PORT: 0, secrets: {},
    getSecretsCache: () => ({}), readChatId: () => null,
    runMcpTool: async () => JSON.stringify({ ok: true, enabled: false }),
  };

  const saved = Object.fromEntries(['AGENT_SECRET', 'AGENT_DATA_DIR', 'AGENT_TOKENS_DIR', 'USERS_DIR'].map(k => [k, process.env[k]]));
  process.env.AGENT_SECRET = SECRET;
  process.env.AGENT_DATA_DIR = path.join(root, 'data');
  process.env.AGENT_TOKENS_DIR = path.join(root, 'tokens');
  process.env.USERS_DIR = users;

  const config = {
    vacancy_id: VACANCY,
    vacancy_title: 'Менеджер по продвижению на Wildberries',
    vacancy_context: 'Детская одежда на Wildberries.',
    // The state the recruiter was actually looking at: a stale, hand-written must-have
    // list pasted into the instruction field.
    message_instructions: 'ПРОЦЕСС ОТБОРА ЭТОЙ ВАКАНСИИ\nВОПРОСЫ ПО МАСТХЕВАМ ЭТОЙ ВАКАНСИИ\n1. На каком маркетплейсе и сколько лет работаешь.',
    required: MUST_HAVES.map((name, i) => ({ name, weight: [3, 3, 2, 2][i] })),
    preferred: [{ name: 'работа в MPStats', weight: 1.5 }],
    pass_threshold: 7.5, review_threshold: 5, filters: {},
    interview_config: { invite_call_enabled: false },
  };
  const hhDir = path.join(users, USER, 'contexts', 'hh');
  fs.mkdirSync(hhDir, { recursive: true });
  fs.writeFileSync(path.join(hhDir, `ats_config:${VACANCY}.json`),
    JSON.stringify({ value: config, updated_at: new Date().toISOString() }, null, 2));

  // The recruiter's global template, as /hh/style would have saved it. Without this the
  // endpoint falls back to DEFAULT_MESSAGE_INSTRUCTIONS and the test would assert the
  // wrong string — prod always has this file for a recruiter who touched the template.
  const RECRUITER_TEMPLATE =
    'Уточняй ТОЛЬКО обязательные требования (мастхевы), которых нет в резюме и в ответах кандидата, — по одному вопросу в строке.\n' +
    'Не переспрашивай то, что уже есть в резюме: имя, город, зарплату, график, контакты, периоды работы.\n' +
    'Когда все обязательные требования закрыты — вопросов нет вообще: предложи следующий шаг процесса и спроси, готов ли кандидат его выполнить.';
  const tokenDir = path.join(root, 'tokens', USER);
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(path.join(tokenDir, 'hh-message-instructions-template'), RECRUITER_TEMPLATE);

  const agent = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (await handleHhPublic(req, url, res, ctx) === false) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not an hh route' }));
    }
  });
  const agentPort = await listen(agent);
  const agentBase = `http://127.0.0.1:${agentPort}`;

  const page = http.createServer((req, res) => {
    if (req.url.startsWith('/hh/ats-editor')) {
      const html = atsEditorHtml(config, ['Скрининг', 'Созвон', 'Оффер'], {
        callbackBase: agentBase, username: USER, pageToken: TOKEN,
        vacancies: [{ id: VACANCY, title: config.vacancy_title }],
        activeVacancyId: VACANCY,
      });
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
    agentBase,
    editorUrl: `http://127.0.0.1:${pagePort}/hh/ats-editor?username=${USER}&token=${TOKEN}&vacancy_id=${VACANCY}`,
    get(route) {
      return fetch(`${agentBase}${route}?username=${USER}&token=${TOKEN}`, { headers: { Origin: PAGE_ORIGIN } });
    },
    post(route, body) {
      return fetch(`${agentBase}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: PAGE_ORIGIN },
        body: JSON.stringify(body),
      });
    },
    options(route, method) {
      return fetch(`${agentBase}${route}`, {
        method: 'OPTIONS',
        headers: { Origin: PAGE_ORIGIN, 'Access-Control-Request-Method': method },
      });
    },
    async stop() {
      await close(page); await close(agent);
      for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test.describe('the page can call the agent across origins', () => {
  let stack;
  test.beforeEach(async () => { stack = await bootStack(); });
  test.afterEach(async () => { await stack.stop(); });

  test('«Вернуть общий шаблон» fills the field instead of failing with Failed to fetch', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(stack.editorUrl);

    // The global template is fetched from CALLBACK_BASE — a different origin than the page.
    await page.click('#resetInstructionBtn');
    await expect(page.locator('#toast')).toContainText('Нажми «Save Funnel»');
    await expect(page.locator('#fMessageInstructions')).toHaveValue(/Уточняй ТОЛЬКО обязательные требования/);
    expect(errors, 'no uncaught JS').toEqual([]);
  });

  test('the must-haves shown as injected are read live from ★ Обязательные навыки', async ({ page }) => {
    await page.goto(stack.editorUrl);
    const box = page.locator('#autoCriteria');
    for (const name of MUST_HAVES) await expect(box).toContainText(name);
    // Preferred skills are not must-haves and must not appear in the must-have list.
    await expect(box).not.toContainText('MPStats');

    // Editing a skill updates the shown list, so the hand-written copy cannot go stale
    // unnoticed — that was the original complaint.
    await page.locator('#requiredList input[type=text]').first().fill('Новый навык WB');
    await expect(box).toContainText('Новый навык WB');
    await expect(box).not.toContainText(MUST_HAVES[0]);
  });
});

test.describe('the agent answers the browser cross-origin', () => {
  let stack;
  test.beforeEach(async () => { stack = await bootStack(); });
  test.afterEach(async () => { await stack.stop(); });

  // A missing header is invisible to a status-only assertion: the status is 200 either
  // way and only the browser refuses it. Assert the header itself.
  test('GET /hh/message-instructions-template (#135)', async () => {
    const res = await stack.get('/hh/message-instructions-template');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect((await res.json()).ok).toBe(true);
  });

  test('POST /hh/response-state — what the review page stars with', async () => {
    const res = await stack.post('/hh/response-state', {
      username: USER, token: TOKEN, vacancy_id: VACANCY, negotiation_id: '1', status: 'star',
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  test('both answer the preflight', async () => {
    for (const [route, method] of [['/hh/message-instructions-template', 'GET'], ['/hh/response-state', 'POST']]) {
      const res = await stack.options(route, method);
      expect(res.status, route).toBe(204);
      expect(res.headers.get('access-control-allow-origin'), route).toBe('*');
    }
  });
});