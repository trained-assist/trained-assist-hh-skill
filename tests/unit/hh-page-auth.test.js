// Browser-facing HH pages must never carry the master AGENT_SECRET, and every write
// they trigger must be bound to one recruiter by that recruiter's HMAC.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { handleHhPublic, handleHhAuthed } = require('../../src/hh-routes.js');
const { atsEditorHtml } = require('../../src/hh-ats-editor-html.js');

const SECRET = 'master-s3cret-value';
const hmac = u => crypto.createHmac('sha256', SECRET).update(u).digest('hex').slice(0, 16);

function fakeRes() {
  const r = { status: 0, body: '', headers: {} };
  r.writeHead = (s, h) => { r.status = s; Object.assign(r.headers, h || {}); return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = b => { r.body = String(b || ''); };
  return r;
}
function req(method, url, body, headers = {}) {
  const q = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  q.method = method; q.url = url; q.headers = headers;
  return q;
}

let root, saved;
const ctx = () => ({
  BASE_USERS_DIR: path.join(root, 'users'), PORT: 0, secrets: {},
  getSecretsCache: () => ({}), readChatId: () => null, runMcpTool: async () => '{}',
});
async function call(method, p, body, headers) {
  const u = new URL('http://x' + p); const res = fakeRes();
  const handled = await handleHhPublic(req(method, u.pathname + u.search, body, headers), u, res, ctx());
  return { handled, res };
}

beforeEach(() => {
  saved = { AGENT_SECRET: process.env.AGENT_SECRET, AGENT_DATA_DIR: process.env.AGENT_DATA_DIR, USERS_DIR: process.env.USERS_DIR, AGENT_PUBLIC_URL: process.env.AGENT_PUBLIC_URL };
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-page-auth-'));
  process.env.AGENT_SECRET = SECRET;
  process.env.AGENT_DATA_DIR = path.join(root, 'data');
  process.env.USERS_DIR = path.join(root, 'users');
  process.env.AGENT_PUBLIC_URL = 'https://example.test';
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('HH browser pages — no master secret, per-recruiter auth', () => {
  it('ATS editor page does not embed AGENT_SECRET, only the recruiter HMAC', async () => {
    const { handled, res } = await call('GET', `/hh/ats-editor?username=alice&token=${hmac('alice')}`);
    expect(handled).not.toBe(false);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).toContain(`const HH_PAGE_TOKEN = '${hmac('alice')}';`);
    expect(atsEditorHtml(null, null, { username: 'bob', pageToken: 'tok' })).not.toContain('HH_SECRET');
  });

  it.each(['/hh/send', '/hh/reject', '/hh/send-and-reject', '/hh/generate-message', '/hh/ats-config', '/hh/reset-ats-results'])(
    '%s rejects a request without the recruiter token', async (p) => {
      const body = { username: 'alice', negotiation_id: '1', negotiation_ids: ['1'], message: 'hi', config: { vacancy_title: 'x' } };
      expect((await call('POST', p, body)).res.status).toBe(403);
      expect((await call('POST', p, { ...body, token: hmac('bob') })).res.status).toBe(403);
    });

  it('editor save works with the recruiter token and keeps fields the form does not know', async () => {
    const dir = path.join(root, 'users', 'alice', 'contexts', 'hh');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ats_config:42.json'), JSON.stringify({ value: {
      vacancy_title: 'old', filters: { area: '1', min_experience_years: 3 }, search_queries: ['q1'], vacancy_id: '42',
    } }));
    const { res } = await call('POST', '/hh/ats-config', {
      username: 'alice', token: hmac('alice'), vacancy_id: '42',
      config: { vacancy_title: 'new', required: [], filters: { min_experience_years: 5, remote_ok: false, salary_max_rub: null } },
    });
    expect(res.status).toBe(200);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'ats_config:42.json'), 'utf8')).value;
    expect(saved.vacancy_title).toBe('new');
    expect(saved.filters).toEqual({ area: '1', min_experience_years: 5, remote_ok: false, salary_max_rub: null });
    expect(saved.search_queries).toEqual(['q1']);
    expect(saved.vacancy_id).toBe('42');
  });

  it('server-to-server Bearer secret still authorizes editor writes', async () => {
    const { res } = await call('POST', '/hh/reset-ats-results', { username: 'alice' }, { authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
  });

  it('editor writes are no longer handled behind the master gate', async () => {
    const u = new URL('http://x/hh/ats-config');
    expect(await handleHhAuthed(req('POST', u.pathname, {}), u, fakeRes(), ctx())).toBe(false);
  });
});
