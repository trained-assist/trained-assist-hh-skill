// Recruiting hub v1 (trained-assist-agent#1742): shared nav injection into /hh/* pages,
// GET /hh/vacancies, POST /hh/playbook-run, GET /hh/plan.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { handleHhPublic } = require('../../src/hh-routes.js');
const { NAV_ITEMS, NAV_ID, hhNavHtml, injectHhNav, withHhNav } = require('../../src/hh-nav.js');
const hhHub = require('../../src/hh-hub.js');
const { createHmac } = require('crypto');

function fakeRes() {
  const r = { status: 0, body: '', headers: {} };
  r.writeHead = (s, h) => { r.status = s; Object.assign(r.headers, h || {}); return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = b => { r.body = String(b || ''); };
  return r;
}
function req(method, url, body) {
  const q = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  q.method = method; q.url = url; q.headers = {};
  return q;
}
const tokenFor = u => createHmac('sha256', 's3cret').update(u).digest('hex').slice(0, 16);
const TOKEN = tokenFor('alice');

let root, saved, calls, mcpReply;
const ctx = (extra = {}) => ({
  BASE_USERS_DIR: path.join(root, 'users'), PORT: 0, secrets: {},
  getSecretsCache: () => ({}),
  runMcpTool: async (o) => { calls.push(o); return JSON.stringify(mcpReply(o)); },
  ...extra,
});
async function get(pathAndQuery, c = ctx()) {
  const u = new URL('http://x' + pathAndQuery); const res = fakeRes();
  const handled = await handleHhPublic(req('GET', u.pathname + u.search), u, res, c);
  return { res, handled };
}
async function post(p, body, c = ctx()) {
  const u = new URL('http://x' + p); const res = fakeRes();
  await handleHhPublic(req('POST', u.pathname, body), u, res, c);
  return res;
}
function writeUserFile(rel, value) {
  const f = path.join(root, 'users', 'alice', rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(value));
}
function connectHh() {
  const dir = path.join(root, 'tokens', 'alice');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hh'), JSON.stringify({ access_token: 'x' }));
}
const draftReady = (extra = {}) => writeUserFile('contexts/hh/vacancy_draft.json', {
  status: 'draft_ready', vacancy_id: 'vac-1', draft: { name: 'Frontend-разработчик' }, landing_url: null, hh_vacancy_id: null, ...extra,
});

beforeEach(() => {
  saved = { AGENT_SECRET: process.env.AGENT_SECRET, AGENT_DATA_DIR: process.env.AGENT_DATA_DIR, USERS_DIR: process.env.USERS_DIR,
    AGENT_TOKENS_DIR: process.env.AGENT_TOKENS_DIR, HH_COLD_SEARCH_PUBLIC_URL: process.env.HH_COLD_SEARCH_PUBLIC_URL };
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-hub-'));
  process.env.AGENT_SECRET = 's3cret';
  process.env.AGENT_DATA_DIR = path.join(root, 'data');
  process.env.USERS_DIR = path.join(root, 'users');
  process.env.AGENT_TOKENS_DIR = path.join(root, 'tokens');
  process.env.HH_COLD_SEARCH_PUBLIC_URL = 'https://hub.example';
  calls = [];
  mcpReply = () => ({ ok: true, enabled: false });
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('hh-nav', () => {
  it('inserts the nav right after <body> and leaves every other byte unchanged', () => {
    const page = '<!doctype html><html><head><style>body{x}</style></head><body class="a">\n<h1>T</h1><script>1</script></body></html>';
    const opts = { pathname: '/hh/proactive', username: 'alice', token: TOKEN, vacancyId: 'V1' };
    const out = injectHhNav(page, opts);
    expect(out.replace(hhNavHtml(opts), '')).toBe(page);
    expect(out.indexOf(`<nav id="${NAV_ID}"`)).toBe(page.indexOf('<body class="a">') + '<body class="a">'.length);
    expect(injectHhNav(out, opts)).toBe(out); // idempotent
    expect(injectHhNav('{"a":1}', opts)).toBe('{"a":1}');
  });

  it('builds relative links carrying username/token/vacancy_id, marking the current page active', () => {
    const html = hhNavHtml({ pathname: '/agent/hh/review', username: 'alice', token: TOKEN, vacancyId: 'V1' });
    for (const { path: p } of NAV_ITEMS) {
      expect(html).toContain(`href="${p.slice(4)}?username=alice&amp;token=${TOKEN}&amp;vacancy_id=V1"`);
    }
    expect(html).toMatch(/href="review\?[^"]*" class="active"/);
    expect(html.match(/class="active"/g)).toHaveLength(1);
    expect(NAV_ITEMS.map(i => i.label)).toEqual(['Вакансии', 'Портрет', 'Кандидаты', '+ Кандидат', 'Холодный поиск', 'ATS воронка', 'Стиль', 'Синхронизация']);
  });

  it('does not touch JSON responses or non-GET requests', () => {
    const res = fakeRes();
    withHhNav({ method: 'GET' }, new URL(`http://x/hh/plan?username=alice&token=${TOKEN}`), res, {});
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"body":"<body>"}');
    expect(res.body).toBe('{"body":"<body>"}');
    const res2 = fakeRes();
    const origEnd = res2.end;
    withHhNav({ method: 'POST' }, new URL('http://x/hh/send?username=alice'), res2, {});
    expect(res2.end).toBe(origEnd);
  });

  it('shows the nav on every /hh/* page, and every nav link hits an existing route', async () => {
    writeUserFile('contexts/hh/active_vacancies.json', { value: [{ id: 'V1', title: 'Backend' }] });
    for (const { path: p } of NAV_ITEMS) {
      const { res, handled } = await get(`${p}?username=alice&token=${TOKEN}`);
      expect(handled, p).not.toBe(false);
      expect(res.headers['Content-Type'], p).toMatch(/text\/html/);
      expect(res.body.match(new RegExp(`<nav id="${NAV_ID}"`, 'g')), p).toHaveLength(1);
    }
    const { res } = await get(`/hh/candidate?username=alice&token=${TOKEN}&neg_id=1`);
    expect(res.body).toContain(`<nav id="${NAV_ID}"`);
  });

  it('keeps /hh/proactive intact: same page, nav added once after <body>, URL/query unchanged', async () => {
    writeUserFile('contexts/hh/active_vacancies.json', { value: [{ id: 'V1', title: 'Backend' }] });
    const { res } = await get(`/hh/proactive?username=alice&token=${TOKEN}&vacancy_id=V1`);
    const nav = hhNavHtml({ pathname: '/hh/proactive', username: 'alice', token: TOKEN, vacancyId: 'V1' });
    expect(res.body).toContain(nav);
    const without = res.body.replace(nav, '');
    expect(without).not.toContain(NAV_ID);
    expect(res.body.indexOf(nav)).toBe(res.body.search(/<body\b[^>]*>/) + res.body.match(/<body\b[^>]*>/)[0].length);
  });

  it('leaves invalid-link error pages without the nav', async () => {
    const { res } = await get('/hh/proactive?username=alice&token=wrong');
    expect(res.body).not.toContain(NAV_ID);
  });
});

describe('GET /hh/vacancies', () => {
  it('lists tracked HH vacancies and the current draft with statuses and actions', async () => {
    writeUserFile('contexts/hh/active_vacancies.json', { value: [{ id: 'V1', title: 'Backend' }] });
    const cacheDir = path.join(root, 'data', 'hh', 'alice');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'negotiations-cache:V1.json'), JSON.stringify({ negotiations: [{ id: 1 }, { id: 2 }], synced_at: Date.now() }));
    draftReady();
    const { res } = await get(`/hh/vacancies?username=alice&token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('Backend');
    expect(res.body).toContain('отслеживается HH');
    expect(res.body).toContain('Откликов: <b>2</b>');
    expect(res.body).toContain(`href="review?username=alice&amp;token=${TOKEN}&amp;vacancy_id=V1"`);
    expect(res.body).toContain(`href="proactive?username=alice&amp;token=${TOKEN}&amp;vacancy_id=V1"`);
    expect(res.body).toContain('Frontend-разработчик');
    expect(res.body).toContain('черновик готов');
    expect(res.body).toMatch(/<button class="btn primary" type="button" data-launch="vac-1"/);
  });

  it('disables ▶ Собрать with a /new_job_post hint while the draft is still collecting', async () => {
    writeUserFile('contexts/hh/vacancy_draft.json', { status: 'collecting', vacancy_id: 'vac-2', draft: null });
    const { res } = await get(`/hh/vacancies?username=alice&token=${TOKEN}`);
    expect(res.body).toContain('черновик собирается');
    expect(res.body).not.toContain('data-launch=');
    expect(res.body).toMatch(/type="button" disabled[^>]*>▶ Собрать/);
    expect(res.body).toContain('/new_job_post');
  });

  it('rejects a wrong token', async () => {
    const { res } = await get('/hh/vacancies?username=alice&token=bad');
    expect(res.body).toContain('Ссылка недействительна');
    expect(res.body).not.toContain('vacancy-card');
  });
});

describe('POST /hh/playbook-run', () => {
  beforeEach(() => {
    mcpReply = (o) => o.tool === 'playbook_run'
      ? { task: { id: 'task-1', status: 'active' }, playbook: { id: 'recruiting-vacancy-launch', version: 1 } }
      : {};
  });

  it('launches the playbook as an active plan, returns task_id + status_url and pushes the launch notice', async () => {
    connectHh(); draftReady();
    const notifyProfile = vi.fn().mockResolvedValue({ sent: true });
    const res = await post('/hh/playbook-run', { username: 'alice', token: TOKEN, vacancy_id: 'vac-1' },
      ctx({ notifyProfile }));
    expect(res.status).toBe(200);
    const out = JSON.parse(res.body);
    expect(out).toEqual({ task_id: 'task-1', status: 'active', status_url: `/hh/plan?username=alice&token=${TOKEN}&task_id=task-1` });
    const run = calls.find(c => c.tool === 'playbook_run');
    expect(run.username).toBe('alice');
    expect(run.params).toEqual({
      playbook_id: 'recruiting-vacancy-launch',
      goal: 'Запустить подбор по вакансии «Frontend-разработчик»',
      activate: true, approve_hooks: true,
      vars: { vacancy_id: 'vac-1', vacancy_title: 'Frontend-разработчик', landing_url: '' },
    });
    await new Promise(r => setImmediate(r));
    expect(notifyProfile).toHaveBeenCalledTimes(1);
    expect(notifyProfile.mock.calls[0][0]).toBe('alice');
    expect(notifyProfile.mock.calls[0][1]).toContain('Запустить подбор по вакансии «Frontend-разработчик»');
    expect(notifyProfile.mock.calls[0][1]).toContain(`https://hub.example/hh/plan?username=alice&token=${TOKEN}&task_id=task-1`);
  });

  it('still succeeds (no push) and only warns when the host has no notifyProfile', async () => {
    connectHh(); draftReady();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await post('/hh/playbook-run', { username: 'alice', token: TOKEN, vacancy_id: 'vac-1' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).task_id).toBe('task-1');
    await new Promise(r => setImmediate(r));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no notifyProfile'));
  });

  it('rejects a bad HMAC, a draft that is not ready and a disconnected HH — without running anything', async () => {
    connectHh(); draftReady();
    expect((await post('/hh/playbook-run', { username: 'alice', token: 'bad', vacancy_id: 'vac-1' })).status).toBe(403);
    expect((await post('/hh/playbook-run', { username: 'alice', token: TOKEN, vacancy_id: 'other' })).status).toBe(409);
    expect((await post('/hh/playbook-run', { username: 'alice', token: TOKEN, vacancy_id: 'vac-1', playbook_id: 'development' })).status).toBe(400);
    fs.rmSync(path.join(root, 'tokens', 'alice', 'hh'));
    expect((await post('/hh/playbook-run', { username: 'alice', token: TOKEN, vacancy_id: 'vac-1' })).status).toBe(409);
    expect(calls.filter(c => c.tool === 'playbook_run')).toHaveLength(0);
  });

  it('surfaces a playbook_run error as a JSON error', async () => {
    connectHh(); draftReady();
    mcpReply = () => ({ error: 'плейбук не найден', code: 'PLAYBOOK_NOT_FOUND' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post('/hh/playbook-run', { username: 'alice', token: TOKEN, vacancy_id: 'vac-1' });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error).toContain('не найден');
  });
});

describe('GET /hh/plan', () => {
  const plan = {
    task: { id: 'task-1', goal: 'Запустить подбор по вакансии «Frontend»', status: 'active', playbook_id: 'recruiting-vacancy-launch', playbook_version: 1, created_at: Date.now() },
    items: [
      { position: 1, title: 'Опубликовать лендинг', status: 'running', stage: 'landing', execution_kind: 'agent' },
      { position: 0, title: 'Проверить вводные', status: 'done', stage: 'check', execution_kind: 'programmatic' },
      { position: 2, title: 'Синхронизировать отклики', status: 'pending', stage: 'funnel', execution_kind: 'agent' },
    ],
  };

  it('renders goal, playbook+version and ordered steps via task_get, and polls', async () => {
    mcpReply = (o) => (o.tool === 'task_get' && o.params.task_id === 'task-1' ? plan : { error: 'nope' });
    const { res } = await get(`/hh/plan?username=alice&token=${TOKEN}&task_id=task-1`);
    expect(calls.map(c => [c.tool, c.username])).toContainEqual(['task_get', 'alice']);
    expect(res.body).toContain('Запустить подбор по вакансии «Frontend»');
    expect(res.body).toContain('recruiting-vacancy-launch v1');
    expect(res.body).toContain('Сейчас: <b>Опубликовать лендинг</b>');
    const list = res.body.slice(res.body.indexOf('<ol'));
    const order = ['Проверить вводные', 'Опубликовать лендинг', 'Синхронизировать отклики'].map(t => list.indexOf(t));
    expect(order.every(i => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(res.body).toContain('format=json');
    expect(res.body).toContain(`<nav id="${NAV_ID}"`);
  });

  it('serves the JSON poll and stops polling once the plan is final', async () => {
    mcpReply = () => ({ ...plan, task: { ...plan.task, status: 'done' } });
    const { res: j } = await get(`/hh/plan?username=alice&token=${TOKEN}&task_id=task-1&format=json`);
    expect(JSON.parse(j.body).task.status).toBe('done');
    const { res } = await get(`/hh/plan?username=alice&token=${TOKEN}&task_id=task-1`);
    expect(res.body).toContain('Процесс завершён');
    expect(res.body).not.toContain('<script>');
  });

  it('rejects a wrong token and reports an unknown task', async () => {
    mcpReply = () => ({ error: 'task not found (or not owned by this profile)' });
    const { res: bad } = await get('/hh/plan?username=alice&token=bad&task_id=task-1&format=json');
    expect(bad.status).toBe(403);
    expect(calls).toHaveLength(0);
    const { res } = await get(`/hh/plan?username=alice&token=${TOKEN}&task_id=task-x`);
    expect(res.body).toContain('Процесс не найден');
  });
});

describe('notifyLaunch', () => {
  const args = {
    username: 'alice',
    goal: 'Запустить подбор по вакансии «Frontend-разработчик»',
    statusUrl: 'https://hub.example/hh/plan?username=alice&token=t&task_id=task-1',
  };

  it('delegates to the host notifyProfile once, with username and the goal + status link', async () => {
    const notifyProfile = vi.fn().mockResolvedValue({ sent: true });
    expect(await hhHub.notifyLaunch({ notifyProfile, ...args })).toEqual({ sent: true });
    expect(notifyProfile).toHaveBeenCalledTimes(1);
    expect(notifyProfile.mock.calls[0][0]).toBe('alice');
    expect(notifyProfile.mock.calls[0][1]).toContain(args.goal);
    expect(notifyProfile.mock.calls[0][1]).toContain(args.statusUrl);
  });

  it('returns {sent:false, reason:"no_notify_profile"} when the host hook is missing or not a function', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const notifyProfile of [undefined, null, 'not-a-function']) {
      expect(await hhHub.notifyLaunch({ notifyProfile, ...args }))
        .toEqual({ sent: false, reason: 'no_notify_profile' });
    }
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no notifyProfile'));
  });

  it('propagates a {sent:false} answer together with its reason', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const notifyProfile = vi.fn().mockResolvedValue({ sent: false, reason: 'no_chat_id' });
    expect(await hhHub.notifyLaunch({ notifyProfile, ...args }))
      .toEqual({ sent: false, reason: 'no_chat_id' });
  });

  it('never throws — a host failure degrades to {sent:false, reason:"error"}', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(hhHub.notifyLaunch({
      notifyProfile: async () => { throw new Error('boom'); }, ...args,
    })).resolves.toEqual({ sent: false, reason: 'error' });
  });
});
