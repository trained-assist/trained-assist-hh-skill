// Recruiter-editable cold-search prompt (web page «Промпт поиска»): a web-only user
// sees how the search is set up, edits the prompt/queries and relaunches. Guards that
// the saved prompt actually reaches both LLM steps and that edited queries are used.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const api = require('../../src/hh-proactive-search');
const { handleHhPublic } = require('../../src/hh-routes.js');
const { generateProactivePageHtml } = require('../../src/hh-proactive-page.js');

const PROMPT = 'Нужен опыт в станкостроении; кандидаты из автосервисов не подходят.';
const response = (status, body = {}) => ({ ok: status === 200, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });

let root, saved;
beforeEach(() => {
  saved = Object.fromEntries(['AGENT_DATA_DIR', 'AGENT_TOKENS_DIR', 'USERS_DIR', 'AGENT_SECRET', 'OPENROUTER_API_KEY'].map(k => [k, process.env[k]]));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-prompt-'));
  process.env.AGENT_DATA_DIR = path.join(root, 'data');
  process.env.AGENT_TOKENS_DIR = path.join(root, 'tokens');
  process.env.USERS_DIR = path.join(root, 'users');
  process.env.AGENT_SECRET = 's3cret';
  process.env.OPENROUTER_API_KEY = 'or-test';
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('search settings store', () => {
  it('saves the prompt per vacancy and pins only queries the recruiter actually changed', () => {
    api.saveStoredQueries('u', 'A', ['Конструктор'], 'h1');
    expect(api.saveSearchSettings('u', 'A', { prompt: `  ${PROMPT} `, queries: ['Конструктор'] }).queries_state).toBe('unchanged');
    expect(api.loadSearchPrompt('u', 'A').prompt).toBe(PROMPT);
    expect(api.loadSearchPrompt('u', 'B').prompt).toBe('');
    expect(api.readStoredQueriesRecord('u', 'A').manual).toBeUndefined();

    expect(api.saveSearchSettings('u', 'A', { prompt: PROMPT, queries: ['Инженер-конструктор', ' ', 'КОМПАС-3D'] }).queries_state).toBe('manual');
    // Manual queries survive any config hash and the relevance sanity check.
    expect(api.loadStoredQueries('u', 'A', 'other-hash')).toEqual(['Инженер-конструктор', 'КОМПАС-3D']);

    expect(api.saveSearchSettings('u', 'A', { prompt: PROMPT, queries: [] }).queries_state).toBe('reset');
    expect(api.readStoredQueriesRecord('u', 'A')).toBeNull();
    expect(() => api.saveSearchPrompt('u', 'A', 'x'.repeat(4001))).toThrow(/4000/);
  });

  it('changing the prompt invalidates auto-generated queries', () => {
    const cfg = { vacancy_title: 'Инженер-конструктор' };
    expect(api.atsConfigHash(cfg)).not.toBe(api.atsConfigHash({ ...cfg, recruiter_prompt: PROMPT }));
  });
});

describe('the prompt reaches the search', () => {
  function fixture({ manualQueries } = {}) {
    const user = 'rec';
    const workDir = path.join(root, 'users', user);
    const ctx = path.join(workDir, 'contexts', 'hh');
    fs.mkdirSync(ctx, { recursive: true });
    fs.mkdirSync(path.join(root, 'tokens', user), { recursive: true });
    fs.writeFileSync(path.join(root, 'tokens', user, 'hh'), '{"access_token":"fixture"}');
    const put = (key, value) => fs.writeFileSync(path.join(ctx, key + '.json'), JSON.stringify({ value }));
    put('active_vacancies', [{ id: 'A', title: 'Инженер-конструктор', area: { id: '1', name: 'Златоуст' } }]);
    put('ats_config:A', { vacancy_id: 'A', vacancy_title: 'Инженер-конструктор', required: [{ name: 'Инженер конструктор', weight: 5 }] });
    api.saveSearchSettings(user, 'A', { prompt: PROMPT, ...(manualQueries ? { queries: manualQueries } : {}) });
    const llmPrompts = [], hhQueries = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).startsWith('https://openrouter.ai')) {
        const content = JSON.parse(init.body).messages[0].content;
        llmPrompts.push(content);
        const reply = content.includes('поисковых запросов') ? '["Инженер-конструктор станкостроение"]'
          : '{"plus_tags":["опыт"],"yellow_tags":[],"red_tags":[],"summary_why":"ok","summary_pitch":"ok"}';
        return response(200, { choices: [{ message: { content: reply } }] });
      }
      hhQueries.push(new URL(url).searchParams.get('text'));
      return response(200, { items: [{ id: 'r1', title: 'Инженер-конструктор', total_experience: { months: 60 } }] });
    }));
    return { user, workDir, llmPrompts, hhQueries };
  }

  it('feeds the recruiter prompt into query generation and AI scoring', async () => {
    const { user, workDir, llmPrompts, hhQueries } = fixture();
    await api.runProactiveSearch(user, workDir, { vacancyId: 'A' });
    const [queryGen, ...scoring] = llmPrompts;
    expect(queryGen).toContain('поисковых запросов');
    expect(queryGen).toContain(PROMPT);
    expect(scoring.length).toBeGreaterThan(0);
    expect(scoring.every(p => p.includes(PROMPT))).toBe(true);
    expect(hhQueries).toEqual(['Инженер-конструктор станкостроение']);
    expect(api.buildScoringPromptText(user, 'A')).toContain(PROMPT);
    expect(api.buildScoringPromptText(user, 'A')).toContain('Златоуст');
  });

  it('uses queries the recruiter typed in as-is, without asking the LLM for new ones', async () => {
    const { user, workDir, llmPrompts, hhQueries } = fixture({ manualQueries: ['Конструктор КОМПАС-3D', 'Технолог'] });
    await api.runProactiveSearch(user, workDir, { vacancyId: 'A' });
    expect(hhQueries).toEqual(['Конструктор КОМПАС-3D', 'Технолог']);
    expect(llmPrompts.some(p => p.includes('поисковых запросов'))).toBe(false);
  });
});

describe('web API and page', () => {
  const fakeRes = () => {
    const r = { status: 0, body: '', headers: {} };
    r.writeHead = (s, h) => { r.status = s; Object.assign(r.headers, h || {}); return r; };
    r.setHeader = (k, v) => { r.headers[k] = v; };
    r.end = b => { r.body = String(b || ''); };
    return r;
  };
  const call = async (method, pathAndQuery, body) => {
    const q = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    q.method = method; q.url = pathAndQuery; q.headers = {};
    const u = new URL('http://x' + pathAndQuery); const res = fakeRes();
    await handleHhPublic(q, u, res, { BASE_USERS_DIR: path.join(root, 'users'), PORT: 0, secrets: {}, getSecretsCache: () => ({}), readChatId: () => null });
    return { status: res.status, body: res.body, data: (() => { try { return JSON.parse(res.body); } catch { return null; } })() };
  };
  const token = require('crypto').createHmac('sha256', 's3cret').update('alice').digest('hex').slice(0, 16);

  it('saves and returns the prompt only with the profile token', async () => {
    expect((await call('POST', '/api/hh/proactive/prompt', { username: 'alice', token: 'bad', vacancy_id: 'A', prompt: PROMPT })).status).toBe(403);
    expect((await call('POST', '/api/hh/proactive/prompt', { username: 'alice', token, vacancy_id: '../x', prompt: PROMPT })).status).toBe(400);
    const saved = await call('POST', '/api/hh/proactive/prompt', { username: 'alice', token, vacancy_id: 'A', prompt: PROMPT, queries: 'Конструктор\n\nТехнолог' });
    expect(saved.status).toBe(200);
    expect(saved.data).toMatchObject({ ok: true, prompt: PROMPT, queries: ['Конструктор', 'Технолог'], queries_manual: true });
    const read = await call('GET', `/api/hh/proactive/prompt?username=alice&token=${token}&vacancy_id=A`);
    expect(read.data.prompt).toBe(PROMPT);
  });

  it('the cold-search page shows the editable prompt panel for the selected vacancy', () => {
    const html = generateProactivePageHtml({ vacancy_title: 'X', candidates: [] }, 'alice', 'http://x', token, {}, {
      vacancyId: 'A', searchSettings: { prompt: '<b>' + PROMPT, queries: ['Конструктор'], queries_manual: false, explanation: 'Как мы подбираем' },
    });
    expect(html).toContain('data-testid="prompt-panel"');
    expect(html).toContain('&lt;b&gt;' + PROMPT);
    expect(html).toContain('Сохранить и запустить поиск');
    expect(html).toContain('/api/hh/proactive/prompt');
    new Function(html.match(/<script>([\s\S]*)<\/script>/)[1]);
    expect(generateProactivePageHtml({ candidates: [] }, 'alice', 'http://x', token, {}, {})).not.toContain('data-testid="prompt-panel"');
  });
});
