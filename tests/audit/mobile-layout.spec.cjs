'use strict';
// Mobile layout audit (issue #174, continuation of #166): real render at 360 and 390.
// Same hermetic fixture env as review-click.spec.cjs / staging hh-mocked-flow:
// real handleHhPublic + real route table + mock HH + nock LLM. Read-only: only GETs.
// Writes audit/mobile-inventory.json with the measurements behind every assertion.

const { test, expect } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const nock = require('nock');

const { handleHhPublic } = require('../../src/hh-routes');
const { generateReviewPageHtml } = require('../../src/hh-review-page-html');
const { injectHhNav } = require('../../src/hh-nav');
const { createMockHhServer } = require('../helpers/mock-hh-server');

const SECRET = 'mobile-secret';
const USER = 'mobile-recruiter';
const VACANCY = '138004863';
const TOKEN = crypto.createHmac('sha256', SECRET).update(USER).digest('hex').slice(0, 16);
const MIN_TAP = 32;

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

const SCREENS = [
  { key: 'vacancies', path: '/hh/vacancies' },
  { key: 'vacancy-new', path: '/hh/vacancy-new' },
  { key: 'review', path: '/hh/review' },
  { key: 'candidate-new', path: '/hh/candidate-new' },
  { key: 'proactive', path: '/hh/proactive' },
  { key: 'ats-editor', path: '/hh/ats-editor' },
  { key: 'sync-log', path: '/hh/sync-log' },
  { key: 'style', path: '/hh/style' },
];

async function boot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-mobile-audit-'));
  const users = path.join(root, 'users');
  const ctx = { BASE_USERS_DIR: users, PORT: 0, secrets: {}, getSecretsCache: () => ({}), readChatId: () => null, runMcpTool: async () => JSON.stringify({ ok: true, enabled: false }) };
  const saved = Object.fromEntries(['AGENT_SECRET', 'AGENT_DATA_DIR', 'AGENT_TOKENS_DIR', 'USERS_DIR', 'LLM_LADDER_TOKEN', 'HH_API_BASE_URL'].map(k => [k, process.env[k]]));
  process.env.AGENT_SECRET = SECRET;
  process.env.AGENT_DATA_DIR = path.join(root, 'data');
  process.env.AGENT_TOKENS_DIR = path.join(root, 'tokens');
  process.env.USERS_DIR = users;
  process.env.LLM_LADDER_TOKEN = 'mobile-ladder';
  nock.enableNetConnect(/127\.0\.0\.1|localhost/);
  nock('https://llm-ladder.trainedassist.store').persist().post('/v1/chat/completions')
    .reply(200, (_u, body) => ({ choices: [{ message: { content: '{"verdict":"pass","score":8}' }, model: body.model }], model: body.model }));

  const tokenDir = path.join(root, 'tokens', USER);
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(path.join(tokenDir, 'hh'), JSON.stringify({ access_token: 'mobile-hh-token', employer_id: 'emp-1' }));
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
    message_draft: stale ? { text: 'Старый черновик до изменения сценария.', config_version: 'v1' } : { text: 'Черновик письма кандидату.', config_version: 'v1' },
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
      // Прода оборачивает ответ в withHhNav (hh-routes.js:355) — в харнессе повторяем
      // это, иначе страница меряется без навигации и даёт ложные «не отрендерилась».
      const raw = generateReviewPageHtml([mkNeg(NEG_A, 'Анна'), mkNeg(NEG_B, 'Борис'), mkNeg(NEG_C, 'Вера')], WB_VACANCY.name, USER, agentBase, path.join(root, 'data'), { vacancyId: VACANCY, communicationEnabled: true });
      const html = injectHhNav(raw, { pathname: '/hh/review', username: USER, token: TOKEN, vacancyId: VACANCY });
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
    async stop() { await close(page); await close(agent); await hh.stop(); for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v); nock.cleanAll(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

// Measurement inside the page: what actually escapes the viewport, and which
// controls a thumb cannot hit. Scroll containers (overflow-x:auto) are allowed to
// be wider than the viewport — only escapes with no scroller ancestor count.
const MEASURE = minTap => {
  const vw = window.innerWidth;
  const MIN_TAP = minTap;
  const INTERACTIVE = 'a[href], button, input, select, textarea, [onclick], [role="button"], label';
  const lbl = el => (el.getAttribute('aria-label') || el.id || el.className || el.textContent || el.tagName)
    .toString().replace(/\s+/g, ' ').trim().slice(0, 70);
  const hasScroller = el => {
    let p = el.parentElement;
    while (p && p !== document.documentElement) {
      const s = getComputedStyle(p);
      if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && p.scrollWidth > p.clientWidth + 1) return true;
      p = p.parentElement;
    }
    return false;
  };
  const path = el => { const parts = []; let e = el; while (e && e !== document.body && parts.length < 4) { if (e.id) parts.unshift('#' + e.id); else if (e.className && typeof e.className === 'string') parts.unshift(e.className.trim().split(/\s+/)[0]); e = e.parentElement; } return parts.join('>'); };
  const r2 = r => ({ left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });

  const escaping = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right <= vw + 1 && r.left >= -1) continue;
    if (hasScroller(el)) continue;
    escaping.push({ sel: path(el), label: lbl(el), ...r2(r), overflowRight: Math.round(r.right - vw) });
  }
  // keep the outermost offenders: drop entries whose ancestor is also listed
  const escTop = escaping.filter(e => !escaping.some(o => o.sel !== e.sel && e.sel.startsWith(o.sel + '>') && o.overflowRight >= e.overflowRight));
  const small = [], offscreenCtl = [];
  for (const el of document.querySelectorAll(INTERACTIVE)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    if (r.height < MIN_TAP) small.push({ sel: path(el), label: lbl(el), ...r2(r) });
    if ((r.right > vw + 1 || r.left < -1) && !hasScroller(el)) offscreenCtl.push({ sel: path(el), label: lbl(el), ...r2(r) });
  }
  return {
    vw, docScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    pageOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - vw,
    escaping: escTop.slice(0, 25), small: small.slice(0, 25), offscreenCtl: offscreenCtl.slice(0, 25),
    counts: { escaping: escTop.length, small: small.length, offscreenCtl: offscreenCtl.length },
  };
};

const inventory = [];
test.afterAll(() => {
  if (!inventory.length) return;
  const outPath = path.join(__dirname, '..', '..', 'audit', 'mobile-inventory.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), viewport_heights: { 360: 800, 390: 844 }, results: inventory }, null, 2));
  console.log('written', outPath);
});

async function sweep(page, env, width) {
  const rows = [];
  for (const s of SCREENS) {
    await page.setViewportSize({ width, height: width === 360 ? 800 : 844 });
    await page.goto(`${env.base}${s.path}?${env.qs}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(250);
    const m = await page.evaluate(MEASURE, MIN_TAP);
    rows.push({ screen: s.key, path: s.path, ...m });
    console.log(`${width}px ${s.key}: overflow=${m.pageOverflow}px escaping=${m.counts.escaping} offscreenControls=${m.counts.offscreenCtl} small=${m.counts.small}`);
  }
  return rows;
}

const fmt = m => `\n  pageOverflow=${m.pageOverflow}px docScrollWidth=${m.docScrollWidth}` +
  `\n  escaping: ${JSON.stringify(m.escaping.slice(0, 8))}` +
  `\n  offscreenControls: ${JSON.stringify(m.offscreenCtl.slice(0, 8))}` +
  `\n  smallTapTargets(<${MIN_TAP}px): ${JSON.stringify(m.small.slice(0, 8))}`;

test('360/390: ни один экран ЛК не вылезает по горизонтали', async ({ page }) => {
  const env = await boot();
  try {
    for (const width of [360, 390]) {
      const rows = await sweep(page, env, width);
      inventory.push(...rows);
      const bad = rows.filter(r => r.pageOverflow > 1);
      expect(bad.map(b => `${b.screen}@${width}: overflow ${b.pageOverflow}px${fmt(b)}`).join('\n---\n')).toBe('');
    }
  } finally { await env.stop(); }
});

test('review при 360: массовые действия доступны пальцем', async ({ page }) => {
  const env = await boot();
  try {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(`${env.base}/hh/review?${env.qs}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(250);
    const ctl = await page.evaluate(() => {
      const want = ['#regenAllBtn', '#rejectAllBtn', '#sendAllBtn'];
      const out = {};
      for (const sel of want) {
        const el = document.querySelector(sel);
        if (!el) { out[sel] = null; continue; }
        const r = el.getBoundingClientRect();
        out[sel] = { text: (el.textContent || '').replace(/\s+/g, ' ').trim(), w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right), visible: r.width > 0 && r.height > 0 };
      }
      out.viewport = window.innerWidth;
      out.pageOverflow = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth;
      return out;
    });
    console.log('bulk controls @360:', JSON.stringify(ctl));
    expect(ctl.pageOverflow, 'страница /hh/review не должна вылезать по горизонтали на 360').toBeLessThanOrEqual(1);
    for (const sel of ['#regenAllBtn', '#rejectAllBtn', '#sendAllBtn']) {
      const c = ctl[sel];
      expect(c, `${sel} должен рендериться на /hh/review`).toBeTruthy();
      expect(c.visible, `${sel} («${c.text}») должен быть виден на 360`).toBe(true);
      expect(c.h, `${sel} («${c.text}») ниже ${MIN_TAP}px по высоте на мобильном`).toBeGreaterThanOrEqual(MIN_TAP);
      expect(c.left, `${sel} уехал за левый край (left=${c.left})`).toBeGreaterThanOrEqual(-1);
      expect(c.right, `${sel} уехал за правый край экрана (right=${c.right} при ${ctl.viewport})`).toBeLessThanOrEqual(ctl.viewport + 1);
    }
  } finally { await env.stop(); }
});
test('360: пункты меню ЛК достижимы пальцем на всех экранах', async ({ page }) => {
  const env = await boot();
  try {
    await page.setViewportSize({ width: 360, height: 800 });
    const bad = [];
    for (const s of SCREENS) {
      await page.goto(`${env.base}${s.path}?${env.qs}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(150);
      // Только видимые пункты: ссылки внутри закрытого выпадающего меню настроек
      // имеют размер 0 и для пальца не существуют.
      const nav = await page.evaluate(() => [...document.querySelectorAll('#hh-hub-nav a, #hh-hub-nav summary')]
        .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
        .map(el => ({ text: (el.textContent || '').trim().slice(0, 30), h: Math.round(el.getBoundingClientRect().height) })));
      if (!nav.length) { bad.push(`${s.key}: навигация не отрендерилась`); continue; }
      if (process.env.PROBE_NAV) console.log(s.key, JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('#hh-hub-nav summary')].map(el => ({ t: (el.textContent||'').trim(), h: Math.round(el.getBoundingClientRect().height), w: Math.round(el.getBoundingClientRect().width), d: getComputedStyle(el).display, of: getComputedStyle(el.parentElement).display })))));
      for (const item of nav.filter(n => n.h < MIN_TAP)) bad.push(`${s.key}: «${item.text}» ${item.h}px < ${MIN_TAP}px`);
    }
    expect(bad.join('\n')).toBe('');
  } finally { await env.stop(); }
});
