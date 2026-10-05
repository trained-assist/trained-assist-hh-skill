'use strict';
// Audit #166 — screen element inventory.
// Boots the same hermetic fixture env as tests/staging/hh-mocked-flow.spec.cjs
// (real handleHhPublic + real route table + mock HH + nock LLM), GETs every
// nav screen, and parses the interactive elements each screen actually renders.
// Read-only: no POSTs, no sends, no rejections.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const nock = require('nock');

const { handleHhPublic } = require('../../src/hh-routes');
const { generateReviewPageHtml } = require('../../src/hh-review-page-html');
const { createMockHhServer } = require('../helpers/mock-hh-server');

const SECRET = 'audit-secret';
const USER = 'audit-recruiter';
const VACANCY = '138004863';
const NEG = '5610867713';
const TOKEN = crypto.createHmac('sha256', SECRET).update(USER).digest('hex').slice(0, 16);

const WB_VACANCY = {
  id: VACANCY,
  name: 'Менеджер по продвижению на Wildberries',
  area: { name: 'Москва' },
  salary: { from: 120000, to: 140000, currency: 'RUR' },
  counters: { responses: 3 },
  published_at: '2026-09-01T00:00:00+03:00',
  manager: { id: 'mgr-1', full_name: 'Анна Рекрутер' },
  description: 'Продаём детскую одежду на Wildberries. Нужен менеджер по продвижению.',
};
const NEG_OBJ = {
  id: NEG, resume: { first_name: 'Леван', last_name: 'Бахтадзе' },
  created_at: '2026-09-28', updated_at: '2026-10-01',
  counters: { unread_messages: 0, messages: 2 }, has_updates: false, _state: 'response',
};

const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = s => new Promise(r => s.close(() => r()));

function stubLadder() {
  // nock disables net-connect by default; our own test server on 127.0.0.1 must stay reachable.
  nock.enableNetConnect(/127\.0\.0\.1|localhost/);
  nock('https://llm-ladder.trainedassist.store')
    .persist().post('/v1/chat/completions')
    .reply(200, (_u, body) => ({
      choices: [{ message: { content: '{"verdict":"pass","score":8}' }, model: body.model }],
      model: body.model,
    }));
}

async function boot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-audit-'));
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
  process.env.LLM_LADDER_TOKEN = 'audit-ladder';
  stubLadder();

  const tokenDir = path.join(root, 'tokens', USER);
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(path.join(tokenDir, 'hh'), JSON.stringify({ access_token: 'audit-hh-token', employer_id: 'emp-1' }));
  fs.writeFileSync(path.join(tokenDir, 'hh-message-instructions-template'), 'Уточняй мастхевы.');

  const hhDir = path.join(users, USER, 'contexts', 'hh');
  fs.mkdirSync(hhDir, { recursive: true });
  fs.writeFileSync(path.join(hhDir, `ats_config:${VACANCY}.json`), JSON.stringify({
    value: {
      vacancy_id: VACANCY, vacancy_title: WB_VACANCY.name, vacancy_context: 'WB童装.',
      required: [{ name: 'опыт WB от 2 лет', weight: 3 }], preferred: [],
      pass_threshold: 7.5, review_threshold: 5, filters: {},
      interview_config: { invite_call_enabled: false },
    }, updated_at: new Date().toISOString(),
  }, null, 2));

  const candDir = path.join(root, 'data', 'hh', USER, 'candidates');
  fs.mkdirSync(candDir, { recursive: true });
  fs.writeFileSync(path.join(candDir, `${NEG}.json`), JSON.stringify({
    messages: [
      { hh_id: '1', role: 'employer', text: 'Здравствуйте!', timestamp: '2026-09-28T10:00:00+03:00' },
      { hh_id: '2', role: 'applicant', text: 'Опыт с карточками на WB 4 года.', timestamp: '2026-10-01T10:00:00+03:00' },
    ],
  }, null, 2));

  const hh = createMockHhServer({ vacancies: [WB_VACANCY], negotiations: [NEG_OBJ] });
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

  const page = http.createServer((req, res) => {
    if (req.url.startsWith('/hh/review')) {
      const html = generateReviewPageHtml([NEG_OBJ], WB_VACANCY.name, USER, agentBase, path.join(root, 'data'), { vacancyId: VACANCY });
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
    base: `http://127.0.0.1:${pagePort}`,
    qs: `username=${USER}&token=${TOKEN}&vacancy_id=${VACANCY}`,
    async stop() {
      await close(page); await close(agent); await hh.stop();
      for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      nock.cleanAll();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

// Minimal, dependency-free interactive-element parser over the served HTML.
// Captures the elements a recruiter can act on, plus their visible label and
// the nearest scope container, so the audit can compare promise vs behaviour.
function parseInteractive(html) {
  const out = [];
  const push = (el) => out.push(el);
  const stripTags = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

  // buttons and role=button
  const btnRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  let m;
  while ((m = btnRe.exec(html))) {
    const attrs = m[1], inner = m[2];
    push({ type: 'button', label: stripTags(inner) || '(icon)', attrs: attrMap(attrs) });
  }
  // inputs
  const inpRe = /<(input|textarea|select)\b([^>]*)>/gi;
  while ((m = inpRe.exec(html))) {
    const tag = m[1].toLowerCase(), attrs = m[2];
    const a = attrMap(attrs);
    push({ type: tag === 'select' ? 'select' : (a.type || tag), label: a.placeholder || a['aria-label'] || a.name || a.id || '(unlabeled)', attrs: a });
  }
  // anchors acting as controls
  const aRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  while ((m = aRe.exec(html))) {
    const a = attrMap(m[1]);
    const inner = m[2];
    if (a.onclick || a['data-testid'] || (a.class && /btn|button|action|tab|chip|card|toggle/i.test(a.class)) || a.role === 'button') {
      push({ type: 'link-control', label: stripTags(inner) || '(icon)', attrs: a });
    }
  }
  // elements with inline handlers (delegated JS controls)
  const onclickRe = /<([a-z0-9]+)\b([^>]*\son(?:click|change|input|submit)\s*=[^>]*)>/gi;
  while ((m = onclickRe.exec(html))) {
    const tag = m[1].toLowerCase();
    if (['button', 'a', 'input', 'select', 'textarea'].includes(tag)) continue;
    const a = attrMap(m[2]);
    push({ type: `el<${tag}>`, label: a['data-testid'] || a.id || a.class || '(unlabeled)', attrs: a });
  }
  // details/summary disclosures
  const detRe = /<details\b([^>]*)>([\s\S]*?)<\/details>/gi;
  while ((m = detRe.exec(html))) {
    const a = attrMap(m[1]);
    const sum = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(m[2]);
    push({ type: 'disclosure', label: stripTags(sum ? sum[1] : '') || '(summary)', attrs: a });
  }
  return out;
}
function attrMap(s) {
  const o = {};
  const re = /([a-zA-Z-]+)\s*=\s*"([^"]*)"/g;
  let m; while ((m = re.exec(s))) o[m[1].toLowerCase()] = m[2];
  const re2 = /([a-zA-Z-]+)\s*=\s*'([^']*)'/g;
  while ((m = re2.exec(s))) o[m[1].toLowerCase()] = m[2];
  // bare attributes (disabled, checked, required…)
  const re3 = /\s(disabled|required|checked|readonly|selected|multiple|hidden|open)(?=[\s>])/g;
  while ((m = re3.exec(s))) o[m[1]] = true;
  return o;
}

const SCREENS = [
  { key: 'vacancies', path: '/hh/vacancies', note: 'Обзор/список вакансий' },
  { key: 'vacancy-new', path: '/hh/vacancy-new', note: 'Создание вакансии / ATS-портрет' },
  { key: 'review', path: '/hh/review', note: 'Список кандидатов и карточка ревью' },
  { key: 'candidate-new', path: '/hh/candidate-new', note: 'Добавление кандидата' },
  { key: 'proactive', path: '/hh/proactive', note: 'Холодный поиск' },
  { key: 'ats-editor', path: '/hh/ats-editor', note: 'Редактор воронки найма' },
  { key: 'sync-log', path: '/hh/sync-log', note: 'Синхронизация и журнал' },
  { key: 'style', path: '/hh/style', note: 'Общие настройки / стиль' },
];

async function main() {
  const env = await boot();
  const results = [];
  for (const s of SCREENS) {
    const url = `${env.base}${s.path}?${env.qs}`;
    let status = 0, html = '', err = null;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      status = r.status;
      html = await r.text();
    } catch (e) { err = String(e); }
    const elements = html ? parseInteractive(html) : [];
    results.push({ ...s, url, status, err, bytes: html.length, elements });
    console.error(`${s.key}: HTTP ${status}, ${html.length}B, ${elements.length} interactive`);
  }
  const outPath = path.join(__dirname, '..', '..', 'audit', 'inventory.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), screens: results }, null, 2));
  console.log(JSON.stringify({ written: outPath, screens: results.map(r => ({ key: r.key, status: r.status, bytes: r.bytes, n: r.elements.length })) }, null, 2));
  await env.stop();
}

main().catch(e => { console.error(e); process.exit(1); });
