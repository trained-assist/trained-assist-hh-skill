import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHmac } from 'node:crypto';

const require = createRequire(import.meta.url);
const { handleHhPublic } = require('../src/hh-routes');
const { dataRoot, usersRoot } = require('../src/data-paths');
afterEach(() => vi.unstubAllGlobals());

function request(method, body, href) {
  const req = Readable.from(method === 'POST' ? [Buffer.from(JSON.stringify(body || {}))] : []);
  req.method = method; req.headers = {};
  const res = { headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, writeHead(s) { this.status = s; }, end(b) { this.body = String(b || ''); } };
  return { req, res, url: new URL(href || 'http://local/hh') };
}

it('authenticates, deduplicates, persists, and reports a real review regeneration queue', async () => {
  const username = 'regen-route-fixture';
  const vacancyId = 'vacregen1';
  const previousSecret = process.env.AGENT_SECRET;
  process.env.AGENT_SECRET = 'fixture-agent-secret';
  const token = createHmac('sha256', process.env.AGENT_SECRET).update(username).digest('hex').slice(0, 16);
  const userDir = path.join(usersRoot(), username, 'contexts', 'hh');
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, 'active_vacancies.json'), JSON.stringify({ value: [{ id: vacancyId, title: 'Fixture vacancy' }] }));
  const cacheFile = path.join(dataRoot(), 'hh', username, 'vacancy-cache.json');
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ negotiations: [{ id: 'neg1' }, { id: 'neg2' }] }));
  const ctx = { BASE_USERS_DIR: usersRoot(), PORT: 8080, getSecretsCache: () => ({}), hhCacheFile: () => cacheFile };
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const call = { url: String(url), body: JSON.parse(init.body) };
    calls.push(call);
    return { ok: true, status: 200, json: async () => ({ message: `draft:${call.body.negotiation_id}`, funnel_action: 'ask_skills' }) };
  }));
  const payload = { username, token, vacancy_id: vacancyId, request_key: 'e6b73389-7547-44c2-89b1-164108472f27', negotiation_ids: ['neg1', 'neg2'] };
  try {
    let call = request('POST', payload, 'http://local/hh/review-regeneration-start');
    await handleHhPublic(call.req, call.url, call.res, ctx);
    expect(call.res.status).toBe(202);
    const started = JSON.parse(call.res.body);
    expect(started).toMatchObject({ total: 2, concurrency: 3, status: 'running' });

    call = request('POST', payload, 'http://local/hh/review-regeneration-start');
    await handleHhPublic(call.req, call.url, call.res, ctx);
    expect(JSON.parse(call.res.body)).toMatchObject({ job_id: started.job_id, existing: true });

    let job;
    for (let i = 0; i < 100; i++) {
      call = request('GET', null, `http://local/hh/review-regeneration-status?username=${username}&token=${token}&job_id=${started.job_id}&after=0`);
      await handleHhPublic(call.req, call.url, call.res, ctx);
      job = JSON.parse(call.res.body);
      if (job.status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(job.status).toBe('completed');
    expect(job.counts.succeeded).toBe(2);
    expect(job.changes.map(x => x.message).sort()).toEqual(['draft:neg1', 'draft:neg2']);
    expect(calls).toHaveLength(2);
    expect(calls.every(x => x.url === 'http://127.0.0.1:8080/hh/generate-message' && x.body.vacancy_id === vacancyId)).toBe(true);
    const stored = path.join(dataRoot(), 'hh', username, 'regeneration-jobs', `${started.job_id}.json`);
    expect(fs.existsSync(stored)).toBe(true);

    call = request('GET', null, `http://local/hh/review-regeneration-status?username=${username}&token=wrong&job_id=${started.job_id}`);
    await handleHhPublic(call.req, call.url, call.res, ctx);
    expect(call.res.status).toBe(403);
  } finally {
    if (previousSecret === undefined) delete process.env.AGENT_SECRET; else process.env.AGENT_SECRET = previousSecret;
    fs.rmSync(path.join(usersRoot(), username), { recursive: true, force: true });
    fs.rmSync(path.join(dataRoot(), 'hh', username), { recursive: true, force: true });
  }
});
