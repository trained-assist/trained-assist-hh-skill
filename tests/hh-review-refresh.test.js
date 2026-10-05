import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
const { createHhNegotiations } = require('../src/hh-negotiations');
const { handleHhPublic } = require('../src/hh-routes');

afterEach(() => vi.unstubAllGlobals());

it('serves the expired vacancy cache without fetching HH in the request', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-review-stale-cache-'));
  const api = createHhNegotiations({ refreshHhToken: async () => null, getSecretsCache: () => ({}) });
  const file = api.hhCacheFile(root, 'alice', 'vac');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ vacancy_id: 'vac', resume_version: 1, synced_at: Date.now() - 600_000, negotiations: [{ id: 'cached-neg' }] }));
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  try {
    const result = await api.getHhNegotiationsWithCache(root, 'alice', 'vac', 'token', { allowStale: true });
    expect(result).toMatchObject({ stale: true, negotiations: [{ id: 'cached-neg' }] });
    expect(fetch).not.toHaveBeenCalled();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('bounds review thread sync and prioritizes unread, recent conversations', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-review-sync-budget-'));
  const requested = [];
  vi.stubGlobal('fetch', vi.fn(async url => {
    requested.push(String(url).match(/negotiations\/([^/]+)\/messages/)?.[1]);
    return { ok: true, status: 200, json: async () => ({ items: [{ id: `msg-${requested.at(-1)}`, text: 'Новое сообщение', created_at: '2026-10-05T10:00:00Z', author: { participant_type: 'applicant' } }], pages: 1 }) };
  }));
  const api = createHhNegotiations({ refreshHhToken: async () => null, getSecretsCache: () => ({}) });
  const at = Date.parse('2026-10-05T00:00:00Z');
  const negotiations = [
    { id: 'old-unread', updated_at: new Date(at - 10_000).toISOString(), counters: { messages: 1, unread_messages: 1 } },
    { id: 'new-unread', updated_at: new Date(at).toISOString(), counters: { messages: 1, unread_messages: 1 } },
    { id: 'new-read', updated_at: new Date(at + 1_000).toISOString(), counters: { messages: 1, unread_messages: 0 } },
    { id: 'old-read', updated_at: new Date(at - 20_000).toISOString(), counters: { messages: 1, unread_messages: 0 } },
  ];
  try {
    const result = await api.syncHhMessagesToHistory(root, 'alice', negotiations, 'token', { incremental: true, maxCandidates: 2, maxConcurrent: 4 });
    expect(result.synced).toBe(2);
    expect(requested).toEqual(['new-unread', 'old-unread']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('renders a stale cached inbox immediately and exposes refresh status while HH refresh runs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-review-async-refresh-'));
  const saved = Object.fromEntries(['AGENT_DATA_DIR', 'AGENT_TOKENS_ROOT', 'AGENT_TOKENS_DIR', 'USERS_DIR', 'AGENT_SECRET'].map(key => [key, process.env[key]]));
  let finishRefresh;
  const refreshGate = new Promise(resolve => { finishRefresh = resolve; });
  try {
    process.env.AGENT_DATA_DIR = path.join(root, 'data');
    process.env.AGENT_TOKENS_ROOT = path.join(root, 'tokens');
    process.env.AGENT_TOKENS_DIR = path.join(root, 'tokens');
    process.env.USERS_DIR = path.join(root, 'users');
    process.env.AGENT_SECRET = '';
    fs.mkdirSync(path.join(root, 'tokens', 'alice'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tokens', 'alice', 'hh'), JSON.stringify({ access_token: 'fixture' }));
    fs.mkdirSync(path.join(root, 'users', 'alice', 'contexts', 'hh'), { recursive: true });
    fs.writeFileSync(path.join(root, 'users', 'alice', 'contexts', 'hh', 'active_vacancies.json'), JSON.stringify({ value: [{ id: 'vac', title: 'Дизайнер' }] }));
    const ctx = {
      BASE_USERS_DIR: path.join(root, 'users'), getSecretsCache: () => ({}),
      getHhNegotiationsWithCache: vi.fn(async (_dataDir, _username, _vacancyId, _token, options = {}) => options.allowStale
        ? { negotiations: [{ id: 'cached-neg', resume: { first_name: 'Анна', last_name: 'Кэш' }, counters: { messages: 0 } }], synced_at: Date.now() - 600_000, stale: true }
        : (await refreshGate, { negotiations: [{ id: 'fresh-neg', resume: { first_name: 'Новая' }, counters: { messages: 0 } }], synced_at: Date.now(), stale: false })),
      syncHhMessagesToHistory: vi.fn(async () => ({ synced: 0, newMessages: 0 })),
      getHhDiscardedWithCache: vi.fn(async () => []),
      hhCacheFile: () => path.join(root, 'data', 'missing-cache.json'),
    };
    const response = () => ({ headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, writeHead(s) { this.status = s; }, end(b) { this.body = String(b || ''); } });
    const page = response();
    const pageRequest = handleHhPublic({ method: 'GET', headers: {} }, new URL('http://localhost/hh/review?username=alice&vacancy_id=vac'), page, ctx);
    await Promise.race([pageRequest, new Promise((_, reject) => setTimeout(() => reject(new Error('review request blocked on background refresh')), 300))]);
    expect(page.status).toBe(200);
    expect(page.body).toContain('Кэш Анна');
    expect(page.body).toContain('Обновляем список и переписки в фоне');
    const status = response();
    await handleHhPublic({ method: 'GET', headers: {} }, new URL('http://localhost/hh/review-refresh-status?username=alice&vacancy_id=vac'), status, ctx);
    expect(JSON.parse(status.body).status).toBe('running');
    finishRefresh();
    for (let i = 0; i < 30; i++) {
      const current = response();
      await handleHhPublic({ method: 'GET', headers: {} }, new URL('http://localhost/hh/review-refresh-status?username=alice&vacancy_id=vac'), current, ctx);
      if (JSON.parse(current.body).status === 'succeeded') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const done = response();
    await handleHhPublic({ method: 'GET', headers: {} }, new URL('http://localhost/hh/review-refresh-status?username=alice&vacancy_id=vac'), done, ctx);
    expect(JSON.parse(done.body).status).toBe('succeeded');
  } finally {
    finishRefresh?.();
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
