// src/hh-routes.js — HH HTTP routes mounted by the core host via hhLib('hh-routes')
// (trained-assist-agent#1470). Host services come in through ctx; nothing is required
// from core.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { handleHhPublic, handleHhAuthed } = require('../../src/hh-routes.js');

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

let root, saved, calls;
const ctx = () => ({
  BASE_USERS_DIR: path.join(root, 'users'), PORT: 0, secrets: {},
  getSecretsCache: () => ({}), readChatId: () => null,
  runMcpTool: async (o) => { calls.push(o); return JSON.stringify({ ok: true, enabled: false }); },
});

beforeEach(() => {
  saved = { AGENT_SECRET: process.env.AGENT_SECRET, AGENT_DATA_DIR: process.env.AGENT_DATA_DIR, USERS_DIR: process.env.USERS_DIR };
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-routes-'));
  process.env.AGENT_SECRET = 's3cret';
  process.env.AGENT_DATA_DIR = path.join(root, 'data');
  process.env.USERS_DIR = path.join(root, 'users');
  calls = [];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('hh-routes', () => {
  it('leaves non-HH paths to the host', async () => {
    const u = new URL('http://x/web/sessions');
    expect(await handleHhPublic(req('GET', u.pathname), u, fakeRes(), ctx())).toBe(false);
    expect(await handleHhAuthed(req('GET', u.pathname), u, fakeRes(), ctx())).toBe(false);
  });

  it('answers CORS preflight for HH write routes', async () => {
    const u = new URL('http://x/hh/send'); const res = fakeRes();
    await handleHhPublic(req('OPTIONS', u.pathname), u, res, ctx());
    expect(res.status).toBe(204);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
  });

  it('shows an error page, not candidates, for a review link with a wrong token', async () => {
    const u = new URL('http://x/hh/review?username=alice&token=wrong'); const res = fakeRes();
    await handleHhPublic(req('GET', u.pathname + u.search), u, res, ctx());
    expect(res.body).toMatch(/<h2>/);
    expect(res.body).not.toMatch(/candidate-card|data-negotiation/);
  });

  it('reaches the cold-search schedule through the host runMcpTool', async () => {
    const ctxFile = path.join(root, 'users', 'alice', 'contexts', 'hh');
    fs.mkdirSync(ctxFile, { recursive: true });
    fs.writeFileSync(path.join(ctxFile, 'active_vacancies.json'), JSON.stringify({ value: [{ id: 'A' }] }));
    const u = new URL('http://x/api/hh/proactive/vacancy-state'); const res = fakeRes();
    const { createHmac } = require('crypto');
    const token = createHmac('sha256', 's3cret').update('alice').digest('hex').slice(0, 16);
    await handleHhPublic(req('POST', u.pathname, { username: 'alice', vacancy_id: 'A', action: 'disable', token }), u, res, ctx());
    expect(calls.map(c => [c.tool, c.params.action])).toContainEqual(['hh_proactive_schedule', 'disable']);
  });

  it('serves the Call Tips session only with the per-profile scoped token', async () => {
    const { createHmac } = require('crypto');
    const tok = createHmac('sha256', 's3cret').update('calltips:alice').digest('hex').slice(0, 24);
    fs.mkdirSync(path.join(root, 'users', 'alice'), { recursive: true });
    fs.writeFileSync(path.join(root, 'users', 'alice', 'calltips-latest.json'), JSON.stringify({ candidate: 'Bob' }));
    let u = new URL('http://x/calltips-session?profile=alice&token=bad'); let res = fakeRes();
    await handleHhPublic(req('GET', u.pathname + u.search), u, res, ctx());
    expect(res.status).toBe(403);
    u = new URL(`http://x/calltips-session?profile=alice&token=${tok}`); res = fakeRes();
    await handleHhPublic(req('GET', u.pathname + u.search), u, res, ctx());
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ candidate: 'Bob' });
  });
});
