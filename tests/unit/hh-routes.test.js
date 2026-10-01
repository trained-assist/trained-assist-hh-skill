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

describe('hh portrait routes (#85)', () => {
  const tok = () => {
    const { createHmac } = require('crypto');
    return createHmac('sha256', 's3cret').update('alice').digest('hex').slice(0, 16);
  };
  const putCtx = (key, value) => {
    const dir = path.join(root, 'users', 'alice', 'contexts', 'hh');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({ value }));
  };

  it('GET /hh/vacancy-new rejects a bad token', async () => {
    const u = new URL('http://x/hh/vacancy-new?username=alice&token=wrong'); const res = fakeRes();
    await handleHhPublic(req('GET', u.pathname + u.search), u, res, ctx());
    expect(res.body).toMatch(/<h2>/);
    expect(res.body).not.toContain('Собрать портрет');
  });

  it('GET /hh/vacancy-new serves the input page for the active vacancy', async () => {
    putCtx('active_vacancies', [{ id: 'V1', title: 'Маркетолог' }]);
    const u = new URL(`http://x/hh/vacancy-new?username=alice&token=${tok()}`); const res = fakeRes();
    await handleHhPublic(req('GET', u.pathname + u.search), u, res, ctx());
    expect(res.status).toBe(200);
    expect(res.body).toContain('Собрать портрет');
    expect(res.body).toContain('вакансия V1');
  });

  it('GET /hh/vacancy-new renders a stored portrait with gauge and ATS button', async () => {
    const { emptyPortrait, computeCompleteness } = require('../../src/hh-portrait.js');
    putCtx('active_vacancies', [{ id: 'V1', title: 'Маркетолог' }]);
    putCtx('portrait:V1', emptyPortrait());
    const u = new URL(`http://x/hh/vacancy-new?username=alice&token=${tok()}`); const res = fakeRes();
    await handleHhPublic(req('GET', u.pathname + u.search), u, res, ctx());
    expect(res.status).toBe(200);
    expect(res.body).toContain('id="gauge-card"');
    expect(res.body).toContain('id="btn-ats"');
    expect(res.body).toContain('>0%<');
  });

  it('POST /hh/portrait requires the profile token', async () => {
    const u = new URL('http://x/hh/portrait'); const res = fakeRes();
    await handleHhPublic(req('POST', u.pathname, { username: 'alice', action: 'extract', token: 'no' }), u, res, ctx());
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('POST /hh/portrait extract forwards sources to hh_portrait_extract', async () => {
    const u = new URL('http://x/hh/portrait'); const res = fakeRes();
    await handleHhPublic(req('POST', u.pathname, {
      username: 'alice', token: tok(), action: 'extract', vacancy_id: 'V1',
      sources: [{ type: 'vacancy', text: 'Ищем маркетолога' }, { type: 'file', text: '   ' }],
    }), u, res, ctx());
    expect(res.status).toBe(200);
    const call = calls.find(c => c.tool === 'hh_portrait_extract');
    expect(call).toBeTruthy();
    expect(call.params.vacancy_id).toBe('V1');
    expect(call.params.sources).toEqual([{ type: 'vacancy', text: 'Ищем маркетолога' }]);
    expect(call.params.force).toBe(false);
    expect(call.username).toBe('alice');
  });

  it('POST /hh/portrait maps update and to_ats to their tools', async () => {
    let u = new URL('http://x/hh/portrait'); let res = fakeRes();
    await handleHhPublic(req('POST', u.pathname, {
      username: 'alice', token: tok(), action: 'update', vacancy_id: 'V1',
      patch: { requirements: { hard_skills: ['SEO'] } },
    }), u, res, ctx());
    expect(calls.find(c => c.tool === 'hh_portrait_update')?.params.patch.requirements.hard_skills).toEqual(['SEO']);

    res = fakeRes();
    await handleHhPublic(req('POST', u.pathname, { username: 'alice', token: tok(), action: 'to_ats', vacancy_id: 'V1' }), u, res, ctx());
    const ats = calls.find(c => c.tool === 'hh_portrait_to_ats');
    expect(ats?.params).toMatchObject({ save: true, mode: 'draft' });
  });

  it('POST /hh/portrait rejects unknown actions and empty sources', async () => {
    let u = new URL('http://x/hh/portrait'); let res = fakeRes();
    await handleHhPublic(req('POST', u.pathname, { username: 'alice', token: tok(), action: 'nuke' }), u, res, ctx());
    expect(res.status).toBe(400);
    res = fakeRes();
    await handleHhPublic(req('POST', u.pathname, { username: 'alice', token: tok(), action: 'extract', sources: [] }), u, res, ctx());
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('POST /hh/portrait surfaces a tool error as 422', async () => {
    const failing = ctx();
    failing.runMcpTool = async () => JSON.stringify({ error: 'Нет входных материалов' });
    const u = new URL('http://x/hh/portrait'); const res = fakeRes();
    await handleHhPublic(req('POST', u.pathname, {
      username: 'alice', token: tok(), action: 'extract', sources: [{ type: 'vacancy', text: 'x' }],
    }), u, res, failing);
    expect(res.status).toBe(422);
    expect(JSON.parse(res.body).error).toContain('Нет входных материалов');
  });

  it('POST /hh/portrait-file extracts text from a txt file', async () => {
    const u = new URL('http://x/hh/portrait-file'); const res = fakeRes();
    await handleHhPublic(req('POST', u.pathname, {
      username: 'alice', token: tok(), filename: 'brief.txt',
      data_base64: Buffer.from('Опыт от 2 лет, 1С').toString('base64'),
    }), u, res, ctx());
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, text: 'Опыт от 2 лет, 1С' });
  });

  it('POST /hh/portrait-file reports unsupported formats', async () => {
    const u = new URL('http://x/hh/portrait-file'); const res = fakeRes();
    await handleHhPublic(req('POST', u.pathname, {
      username: 'alice', token: tok(), filename: 'cv.rar',
      data_base64: Buffer.from('binary').toString('base64'),
    }), u, res, ctx());
    expect(res.status).toBe(422);
    expect(JSON.parse(res.body).error).toMatch(/не поддерживается/);
  });
});
