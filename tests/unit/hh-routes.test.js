// src/hh-routes.js — HH HTTP routes mounted by the core host via hhLib('hh-routes')
// (trained-assist-agent#1470). Host services come in through ctx; nothing is required
// from core.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { Readable } from 'node:stream';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nock from 'nock';

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

  it('answers CORS preflight for /hh/ats-extract (issue #126, live 401 in the editor)', async () => {
    // Without this the browser preflight fails before reaching the route: the extraction
    // was moved INTO the editor precisely because the public edge blocks the path, and
    // the editor still talks to the agent cross-origin (AGENT_PUBLIC_URL vs the page
    // origin). A 204 here is what lets that fetch happen at all.
    const u = new URL('http://x/hh/ats-extract');
    const res = fakeRes();
    await handleHhPublic(req('OPTIONS', u.pathname), u, res, ctx());
    expect(res.status).toBe(204);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(res.headers['Access-Control-Allow-Methods']).toContain('POST');
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

// Герметизация от локального llm-ladder токена: ladderToken() первым смотрит env,
// потом $AGENT_TOKENS_DIR — при прямом запуске (вне изоляции) там может лежать
// реальный токен машины. Пустой временный ренут-дир делает «токена нет» детерминированным.
function withNoLadderToken(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'no-ladder-'));
  const saved = { d: process.env.AGENT_TOKENS_DIR, r: process.env.AGENT_TOKENS_ROOT };
  process.env.AGENT_TOKENS_DIR = tmp;
  process.env.AGENT_TOKENS_ROOT = tmp;
  const restore = () => {
    if (saved.d === undefined) delete process.env.AGENT_TOKENS_DIR; else process.env.AGENT_TOKENS_DIR = saved.d;
    if (saved.r === undefined) delete process.env.AGENT_TOKENS_ROOT; else process.env.AGENT_TOKENS_ROOT = saved.r;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  return Promise.resolve().then(fn).finally(restore);
}

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
    expect(JSON.parse(res.body).error).toMatch(/Архив/);
  });
});

describe('candidate-new routes (#87)', () => {
  const tok = () => {
    const { createHmac } = require('crypto');
    return createHmac('sha256', 's3cret').update('alice').digest('hex').slice(0, 16);
  };

  it('GET /hh/candidate-new requires the profile token', async () => {
    const u = new URL('http://x/hh/candidate-new?username=alice&token=wrong'); const res = fakeRes();
    await handleHhPublic(req('GET', u.pathname + u.search), u, res, ctx());
    expect(res.body).toMatch(/<h2>/);
    expect(res.body).not.toContain('btn-files');
  });

  it('GET /hh/candidate-new serves the upload window', async () => {
    const u = new URL(`http://x/hh/candidate-new?username=alice&token=${tok()}`); const res = fakeRes();
    await handleHhPublic(req('GET', u.pathname + u.search), u, res, ctx());
    expect(res.status).toBe(200);
    expect(res.body).toContain('Новый кандидат');
    expect(res.body).toContain('Имя кандидата');
    expect(res.body).toContain('btn-files');
  });

  it('POST /hh/candidate-doc stores a file, classifies it, returns candidate_id', async () => {
    const u = new URL('http://x/hh/candidate-doc'); const res = fakeRes();
    const text = 'Опыт работы\n2023 – 2025 ООО «Пример», маркетолог\nНавыки: Excel';
    await handleHhPublic(req('POST', u.pathname, {
      username: 'alice', token: tok(), candidate_name: 'Иванов Пётр',
      filename: 'cv.txt', data_base64: Buffer.from(text, 'utf8').toString('base64'),
    }), u, res, ctx());
    expect(res.status).toBe(200);
    const out = JSON.parse(res.body);
    expect(out.ok).toBe(true);
    expect(out.candidate_id).toMatch(/^ivanov-petr-/);
    expect(out.doc.type).toBe('resume');
    expect(out.doc.detected_by).toBe('rules');
  });

  it('POST /hh/candidate-doc accepts a Drive link with a manual type', async () => {
    const u = new URL('http://x/hh/candidate-doc'); const res = fakeRes();
    await handleHhPublic(req('POST', u.pathname, {
      username: 'alice', token: tok(), candidate_id: 'ivanov-pyotr-x',
      filename: 'https://drive.google.com/file/d/abc/view',
      source_url: 'https://drive.google.com/file/d/abc/view',
      type: 'interview',
    }), u, res, ctx());
    expect(res.status).toBe(200);
    const out = JSON.parse(res.body);
    expect(out.doc.type).toBe('interview');
    expect(out.doc.detected_by).toBe('manual');
  });

  it('POST /hh/candidate-doc rejects unknown types and missing files', async () => {
    let u = new URL('http://x/hh/candidate-doc'); let res = fakeRes();
    await handleHhPublic(req('POST', u.pathname, { username: 'alice', token: tok(), candidate_id: 'c', filename: 'x', type: 'unicorn' }), u, res, ctx());
    expect(res.status).toBe(400);
    res = fakeRes();
    await handleHhPublic(req('POST', u.pathname, { username: 'alice', token: tok(), candidate_id: 'c' }), u, res, ctx());
    expect(res.status).toBe(400);
  });

  it('POST /hh/candidate-docs set_type overrides the detected type', async () => {
    const up = new URL('http://x/hh/candidate-doc'); let res = fakeRes();
    await handleHhPublic(req('POST', up.pathname, {
      username: 'alice', token: tok(), candidate_name: 'Анна Сергеева',
      filename: 'letter.txt', data_base64: Buffer.from('Добрый день! Пишу по поводу вакансии.', 'utf8').toString('base64'),
    }), up, res, ctx());
    const { candidate_id, doc } = JSON.parse(res.body);

    const u = new URL('http://x/hh/candidate-docs'); res = fakeRes();
    await handleHhPublic(req('POST', u.pathname, {
      username: 'alice', token: tok(), candidate_id, action: 'set_type', doc_id: doc.id, type: 'cover_letter',
    }), u, res, ctx());
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).doc.detected_by).toBe('manual');
  });

  it('POST /hh/candidate-docs extract_profile fails cleanly without an LLM ladder token', async () => {
    const up = new URL('http://x/hh/candidate-doc'); let res = fakeRes();
    await handleHhPublic(req('POST', up.pathname, {
      username: 'alice', token: tok(), candidate_name: 'Ольга',
      filename: 'cv.txt', data_base64: Buffer.from('Опыт работы\n2020 – 2024', 'utf8').toString('base64'),
    }), up, res, ctx());
    const { candidate_id } = JSON.parse(res.body);

    const saved = process.env.LLM_LADDER_TOKEN;
    delete process.env.LLM_LADDER_TOKEN;
    const u = new URL('http://x/hh/candidate-docs'); res = fakeRes();
    try {
      await withNoLadderToken(() => handleHhPublic(req('POST', u.pathname, { username: 'alice', token: tok(), candidate_id, action: 'extract_profile' }), u, res, ctx()));
    } finally {
      if (saved !== undefined) process.env.LLM_LADDER_TOKEN = saved;
    }
    expect(res.status).toBe(422);
    expect(JSON.parse(res.body).error).toMatch(/ladder/i);
  });

  it('GET /hh/candidate-new renders the manifest for a candidate', async () => {
    const up = new URL('http://x/hh/candidate-doc'); let res = fakeRes();
    await handleHhPublic(req('POST', up.pathname, {
      username: 'alice', token: tok(), candidate_name: 'Сергей',
      filename: 'cv.txt', data_base64: Buffer.from('Опыт работы\n2022 – 2025', 'utf8').toString('base64'),
    }), up, res, ctx());
    const { candidate_id } = JSON.parse(res.body);

    const u = new URL(`http://x/hh/candidate-new?username=alice&token=${tok()}&candidate_id=${candidate_id}`); res = fakeRes();
    await handleHhPublic(req('GET', u.pathname + u.search), u, res, ctx());
    expect(res.status).toBe(200);
    expect(res.body).toContain('cv.txt');
    expect(res.body).toContain('btn-profile');
    // имя теперь показывается всегда: пресет + кнопка переименования
    expect(res.body).toContain('btn-rename');
    expect(res.body).toContain('Сохранить имя');
  });
});

describe('candidate report & photo routes (#91)', () => {
  const tok = () => {
    const { createHmac } = require('crypto');
    return createHmac('sha256', 's3cret').update('alice').digest('hex').slice(0, 16);
  };
  async function makeCandidate() {
    const u = new URL('http://x/hh/candidate-doc'); const res = fakeRes();
    await handleHhPublic(req('POST', u.pathname, {
      username: 'alice', token: tok(), candidate_name: 'Иванова Мария',
      filename: 'cv.txt', data_base64: Buffer.from('Опыт работы\n2021 – 2024', 'utf8').toString('base64'),
    }), u, res, ctx());
    return JSON.parse(res.body).candidate_id;
  }

  it('GET /hh/candidate-report requires token and renders HTML by default', async () => {
    const candidateId = await makeCandidate();
    let u = new URL(`http://x/hh/candidate-report?username=alice&token=bad&candidate_id=${candidateId}`); let res = fakeRes();
    await handleHhPublic(req('GET', u.pathname + u.search), u, res, ctx());
    expect(res.status).toBe(403);

    u = new URL(`http://x/hh/candidate-report?username=alice&token=${tok()}&candidate_id=${candidateId}&which=profile`); res = fakeRes();
    await handleHhPublic(req('GET', u.pathname + u.search), u, res, ctx());
    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/html');
    expect(res.body).toContain('Скачать MD');
    expect(res.body).toContain('Скачать PDF');
    expect(res.body).toContain('Соответствие вакансии');
  });

  it('GET /hh/candidate-report?format=md downloads markdown', async () => {
    const candidateId = await makeCandidate();
    const u = new URL(`http://x/hh/candidate-report?username=alice&token=${tok()}&candidate_id=${candidateId}&which=eval&format=md`); const res = fakeRes();
    await handleHhPublic(req('GET', u.pathname + u.search), u, res, ctx());
    expect(res.headers['Content-Type']).toContain('text/markdown');
    expect(res.headers['Content-Disposition']).toContain('.md');
    expect(res.body).toContain('# Оценка кандидата — Иванова Мария');
    expect(res.body).toContain('## Ограничения');
  });

  it('GET /hh/candidate-report.pdf returns 422 with a hint when the engine is off', async () => {
    const candidateId = await makeCandidate();
    const saved = process.env.HH_PDF_ENGINE;
    process.env.HH_PDF_ENGINE = 'off';
    const u = new URL(`http://x/hh/candidate-report.pdf?username=alice&token=${tok()}&candidate_id=${candidateId}&which=eval`); const res = fakeRes();
    try {
      await handleHhPublic(req('GET', u.pathname + u.search), u, res, ctx());
    } finally {
      if (saved === undefined) delete process.env.HH_PDF_ENGINE; else process.env.HH_PDF_ENGINE = saved;
    }
    expect(res.status).toBe(422);
    expect(JSON.parse(res.body).error).toMatch(/отключён|Chrome/i);
  });

  // ── Канон v2 (#120): роуты поверх канонической оценки ─────────────────────────
  it('GET /hh/candidate-report-v2 renders the internal eval with evaluation_id', async () => {
    const candidateId = await makeCandidate();
    const u = new URL(`http://x/hh/candidate-report-v2?username=alice&token=${tok()}&candidate_id=${candidateId}&which=eval`);
    const res = fakeRes();
    await handleHhPublic(req('GET', u.pathname + u.search), u, res, ctx());
    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/html');
    expect(res.body).toContain('Внутренняя оценка кандидата');
    expect(res.body).toContain('evaluation_id');
    expect(res.body).toContain('hh_portrait_v2');
    expect(res.body).toContain('Скачать MD');
    expect(res.body).toContain('Скачать PDF');
  });

  it('GET /hh/candidate-report-v2?which=profile renders the branded client profile', async () => {
    const candidateId = await makeCandidate();
    const u = new URL(`http://x/hh/candidate-report-v2?username=alice&token=${tok()}&candidate_id=${candidateId}&which=profile`);
    const res = fakeRes();
    await handleHhPublic(req('GET', u.pathname + u.search), u, res, ctx());
    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/html');
    // Брендированный HTML: палитра агентства применяется.
    expect(res.body).toContain('--acc:');
    expect(res.body).toContain('Оценка кандидата');
    expect(res.body).toContain('Заключение рекрутера');
    expect(res.body).toContain('Приложения');
    expect(res.body).toContain('Иванова Мария');
    // Внутренние поля не протекают в клиентский документ.
    expect(res.body).not.toContain('expert_check');
    expect(res.body).not.toContain('risk_log');
    expect(res.body).not.toContain('evaluation_id');
  });

  it('GET /hh/candidate-report-v2?format=md downloads markdown for both documents', async () => {
    const candidateId = await makeCandidate();
    for (const which of ['eval', 'profile']) {
      const u = new URL(`http://x/hh/candidate-report-v2?username=alice&token=${tok()}&candidate_id=${candidateId}&which=${which}&format=md`);
      const res = fakeRes();
      await handleHhPublic(req('GET', u.pathname + u.search), u, res, ctx());
      expect(res.headers['Content-Type']).toContain('text/markdown');
      expect(res.headers['Content-Disposition']).toContain('.md');
      if (which === 'eval') {
        expect(res.body).toContain('# Внутренняя оценка кандидата');
        expect(res.body).toContain('evaluation_id');
      } else {
        expect(res.body).toContain('# Иванова Мария');
        expect(res.body).not.toContain('evaluation_id');
      }
    }
  });

  it('GET /hh/candidate-report-v2.pdf returns 422 with a hint when the engine is off', async () => {
    const candidateId = await makeCandidate();
    const saved = process.env.HH_PDF_ENGINE;
    process.env.HH_PDF_ENGINE = 'off';
    const u = new URL(`http://x/hh/candidate-report-v2.pdf?username=alice&token=${tok()}&candidate_id=${candidateId}&which=profile`); const res = fakeRes();
    try {
      await handleHhPublic(req('GET', u.pathname + u.search), u, res, ctx());
    } finally {
      if (saved === undefined) delete process.env.HH_PDF_ENGINE; else process.env.HH_PDF_ENGINE = saved;
    }
    expect(res.status).toBe(422);
    expect(JSON.parse(res.body).error).toMatch(/отключён|Chrome/i);
  });

  it('GET /hh/candidate-report-v2 rejects a bad token and an unknown candidate', async () => {
    const candidateId = await makeCandidate();
    let u = new URL(`http://x/hh/candidate-report-v2?username=alice&token=bad&candidate_id=${candidateId}`);
    let res = fakeRes();
    await handleHhPublic(req('GET', u.pathname + u.search), u, res, ctx());
    expect(res.status).toBe(403);

    u = new URL(`http://x/hh/candidate-report-v2?username=alice&token=${tok()}&candidate_id=nope`);
    res = fakeRes();
    await handleHhPublic(req('GET', u.pathname + u.search), u, res, ctx());
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error).toMatch(/не найден/i);
  });

  it('candidate-new page links to both v1 and v2 documents', async () => {
    const candidateId = await makeCandidate();
    const u = new URL(`http://x/hh/candidate-new?username=alice&token=${tok()}&candidate_id=${candidateId}`);
    const res = fakeRes();
    await handleHhPublic(req('GET', u.pathname + u.search), u, res, ctx());
    expect(res.status).toBe(200);
    // v1-кнопки остались на месте.
    expect(res.body).toContain('candidate-report?');
    expect(res.body).toContain('candidate-report.pdf?');
    // v2-кнопки добавлены.
    expect(res.body).toContain('candidate-report-v2?');
    expect(res.body).toContain('candidate-report-v2.pdf?');
    expect(res.body).toContain('канон v2');
  });

  it('photo upload and fetch round-trip', async () => {
    const candidateId = await makeCandidate();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    let u = new URL('http://x/hh/candidate-photo'); let res = fakeRes();
    await handleHhPublic(req('POST', u.pathname, {
      username: 'alice', token: tok(), candidate_id: candidateId,
      data_base64: jpeg.toString('base64'), mime: 'image/jpeg',
    }), u, res, ctx());
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);

    u = new URL(`http://x/hh/candidate-photo?username=alice&token=${tok()}&candidate_id=${candidateId}`); res = fakeRes();
    await handleHhPublic(req('GET', u.pathname + u.search), u, res, ctx());
    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/jpeg');
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('rejects oversized photos', async () => {
    const candidateId = await makeCandidate();
    const big = Buffer.alloc(6 * 1024 * 1024, 1);
    const u = new URL('http://x/hh/candidate-photo'); const res = fakeRes();
    await handleHhPublic(req('POST', u.pathname, {
      username: 'alice', token: tok(), candidate_id: candidateId,
      data_base64: big.toString('base64'), mime: 'image/jpeg',
    }), u, res, ctx());
    expect(res.status).toBe(413);
  });
});

describe('eval-run routes (#90)', () => {
  const tok = () => {
    const { createHmac } = require('crypto');
    return createHmac('sha256', 's3cret').update('alice').digest('hex').slice(0, 16);
  };

  it('POST /hh/eval-run requires the profile token', async () => {
    const u = new URL('http://x/hh/eval-run'); const res = fakeRes();
    await handleHhPublic(req('POST', u.pathname, { username: 'alice', token: 'bad', candidate_id: 'c-1' }), u, res, ctx());
    expect(res.status).toBe(403);
  });

  it('POST /hh/eval-run fails cleanly without an LLM ladder token', async () => {
    const saved = process.env.LLM_LADDER_TOKEN;
    delete process.env.LLM_LADDER_TOKEN;
    const u = new URL('http://x/hh/eval-run'); const res = fakeRes();
    try {
      await withNoLadderToken(() => handleHhPublic(req('POST', u.pathname, { username: 'alice', token: tok(), candidate_id: 'c-1' }), u, res, ctx()));
    } finally {
      if (saved !== undefined) process.env.LLM_LADDER_TOKEN = saved;
    }
    expect(res.status).toBe(422);
    expect(JSON.parse(res.body).error).toMatch(/ladder/i);
  });

  it('POST /hh/eval-run reports a missing candidate honestly', async () => {
    process.env.LLM_LADDER_TOKEN = 'test-token';
    const u = new URL('http://x/hh/eval-run'); const res = fakeRes();
    try {
      await handleHhPublic(req('POST', u.pathname, { username: 'alice', token: tok(), candidate_id: 'nope-1' }), u, res, ctx());
    } finally {
      delete process.env.LLM_LADDER_TOKEN;
    }
    expect(res.status).toBe(422);
    expect(JSON.parse(res.body).error).toMatch(/не найден/);
  });

  it('GET /hh/eval-run → 404 when never started, 200 with a job file', async () => {
    let u = new URL(`http://x/hh/eval-run?username=alice&token=${tok()}&candidate_id=missing-1`); let res = fakeRes();
    await handleHhPublic(req('GET', u.pathname + u.search), u, res, ctx());
    expect(res.status).toBe(404);

    const dir = path.join(root, 'data', 'hh', 'alice', 'candidate-eval');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cand-1.job.json'), JSON.stringify({ state: 'done', percent: 60 }));
    u = new URL(`http://x/hh/eval-run?username=alice&token=${tok()}&candidate_id=cand-1`); res = fakeRes();
    await handleHhPublic(req('GET', u.pathname + u.search), u, res, ctx());
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).job.state).toBe('done');
  });
});

describe('ручной текст и расшифровка медиа (#87 фиксы)', () => {
  const tok = () => {
    const { createHmac } = require('crypto');
    return createHmac('sha256', 's3cret').update('alice').digest('hex').slice(0, 16);
  };

  it('POST /hh/candidate-doc принимает text (вставка вручную) с типом', async () => {
    const u = new URL('http://x/hh/candidate-doc'); const res = fakeRes();
    await handleHhPublic(req('POST', u.pathname, {
      username: 'alice', token: tok(), candidate_name: 'Татьяна Потапова',
      text: 'Опыт работы\n2024 – 2026 Skyfort Capital', type: 'resume',
      filename: 'вставлено-вручную.txt',
    }), u, res, ctx());
    expect(res.status).toBe(200);
    const out = JSON.parse(res.body);
    expect(out.ok).toBe(true);
    expect(out.doc.type).toBe('resume');
    expect(out.doc.chars).toBeGreaterThan(0);
  });

  it('POST /hh/interview-transcribe: делегирует в тул и добавляет транскрипт в документы', async () => {
    // сначала документ-аудио
    const up = new URL('http://x/hh/candidate-doc'); let res = fakeRes();
    await handleHhPublic(req('POST', up.pathname, {
      username: 'alice', token: tok(), candidate_name: 'Татьяна',
      filename: 'audio.m4a', data_base64: Buffer.from([0, 1, 2]).toString('base64'), type: 'interview',
    }), up, res, ctx());
    const { candidate_id, doc } = JSON.parse(res.body);
    expect(doc.media_kind).toBe('media');

    // файл-«транскрипт», который вернёт мок-тул
    const tDir = path.join(root, 'data', 'hh', 'alice', 'interviews', candidate_id);
    fs.mkdirSync(tDir, { recursive: true });
    const tPath = path.join(tDir, `${candidate_id}-transcript.txt`);
    fs.writeFileSync(tPath, 'Интервью: Владимир — Татьяна\n\n[0:00] Владимир: Здравствуйте?');

    const calls = [];
    const failing = { ...ctx() };
    const success = {
      ...ctx(),
      runMcpTool: async (o) => {
        calls.push(o);
        return JSON.stringify({ ok: true, slug: candidate_id, transcript_path: tPath, speakers_detected: true, turns: 1 });
      },
    };

    const u = new URL('http://x/hh/interview-transcribe'); res = fakeRes();
    await handleHhPublic(req('POST', u.pathname, { username: 'alice', token: 'bad', candidate_id: candidate_id, doc_id: doc.id }), u, res, failing);
    expect(res.status).toBe(403);

    res = fakeRes();
    await handleHhPublic(req('POST', u.pathname, { username: 'alice', token: tok(), candidate_id: candidate_id, doc_id: doc.id }), u, res, success);
    expect(res.status).toBe(200);
    expect(calls[0].tool).toBe('hh_interview_transcribe');
    expect(calls[0].params).toMatchObject({ candidate_id, doc_id: doc.id, slug: candidate_id });

    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'data', 'hh', 'alice', 'candidate-docs', candidate_id, 'manifest.json'), 'utf8'));
    const added = manifest.docs.find(d => d.filename === `${candidate_id}-transcript.txt`);
    expect(added).toBeTruthy();
    expect(added.type).toBe('interview');
    expect(added.detected_by).toBe('manual');
  });

  it('POST /hh/interview-transcribe: ошибка тула → 422', async () => {
    const failing = {
      ...ctx(),
      runMcpTool: async () => JSON.stringify({ error: 'Deepgram: HTTP 401' }),
    };
    const u = new URL('http://x/hh/interview-transcribe'); const res = fakeRes();
    await handleHhPublic(req('POST', u.pathname, { username: 'alice', token: tok(), candidate_id: 'c-1', doc_id: 'd-1' }), u, res, failing);
    expect(res.status).toBe(422);
    expect(JSON.parse(res.body).error).toContain('Deepgram');
  });
});

describe('candidate-doc-raw — тяжёлая загрузка в GCS (#105)', () => {
  const tok = () => {
    const { createHmac } = require('crypto');
    return createHmac('sha256', 's3cret').update('alice').digest('hex').slice(0, 16);
  };
  let core, coreUrl, savedEnv;

  function rawReq(url, buf, contentType) {
    const r = Readable.from([Buffer.isBuffer(buf) ? buf : Buffer.from(buf)]);
    r.method = 'POST'; r.url = url; r.headers = { 'content-type': contentType || 'application/octet-stream' };
    return r;
  }

  beforeEach(async () => {
    // фейк ядра: принимает upload, отдаёт download (in-process loopback)
    const store = new Map();
    core = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        if (u.pathname === '/internal/blob/upload') {
          const key = `profiles/${u.searchParams.get('username')}/candidate-docs/${u.searchParams.get('candidate_id')}/${u.searchParams.get('doc_id')}${u.searchParams.get('ext')}`;
          store.set(key, body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, key, sha256: 'c'.repeat(64), size: body.length, generation: '7' }));
          return;
        }
        res.writeHead(404).end('{}');
      });
    });
    await new Promise(r => core.listen(0, '127.0.0.1', r));
    coreUrl = `http://127.0.0.1:${core.address().port}`;
    savedEnv = process.env.AGENT_INTERNAL_URL;
    process.env.AGENT_INTERNAL_URL = coreUrl;
  });

  afterEach(async () => {
    await new Promise(r => core.close(r));
    if (savedEnv === undefined) delete process.env.AGENT_INTERNAL_URL;
    else process.env.AGENT_INTERNAL_URL = savedEnv;
  });

  it('upload → документ с storage=gcs, байтов локально нет', async () => {
    const payload = Buffer.from('тяжёлый m4a content '.repeat(10));
    const u = new URL(`http://x/hh/candidate-doc-raw?${new URLSearchParams({ username: 'alice', token: tok(), candidate_name: 'Татьяна Потапова', filename: 'audio1519171140.m4a' })}`);
    const res = fakeRes();
    await handleHhPublic(rawReq(u.pathname + u.search, payload, 'audio/mp4'), u, res, ctx());
    expect(res.status).toBe(200);
    const out = JSON.parse(res.body);
    expect(out.ok).toBe(true);
    expect(out.doc.storage.backend).toBe('gcs');
    expect(out.doc.storage.key).toContain('candidate-docs/');
    expect(out.doc.media_kind).toBe('media');
    expect(out.doc.type).toBe('interview'); // правила: аудио/видео → интервью

    const root = path.join(root0(), 'data', 'hh', 'alice', 'candidate-docs', out.candidate_id);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    expect(manifest.docs[0].storage.backend).toBe('gcs');
    expect(fs.readdirSync(root).some(f => f.endsWith('.m4a'))).toBe(false);
  });

  it('auth и пустое тело отклоняются', async () => {
    let u = new URL('http://x/hh/candidate-doc-raw?username=alice&token=bad&filename=x.m4a');
    let res = fakeRes();
    await handleHhPublic(rawReq(u.pathname + u.search, Buffer.from('x')), u, res, ctx());
    expect(res.status).toBe(403);

    u = new URL(`http://x/hh/candidate-doc-raw?${new URLSearchParams({ username: 'alice', token: tok(), filename: 'x.m4a' })}`);
    res = fakeRes();
    await handleHhPublic(rawReq(u.pathname + u.search, Buffer.alloc(0)), u, res, ctx());
    expect(res.status).toBe(400);
  });

  function root0() { return root; }
});

describe('candidate-doc-delete (#107)', () => {
  const tok = () => {
    const { createHmac } = require('crypto');
    return createHmac('sha256', 's3cret').update('alice').digest('hex').slice(0, 16);
  };

  it('удаляет локальный документ; bad token → 403; неизвестный → 404', async () => {
    const up = new URL('http://x/hh/candidate-doc'); let res = fakeRes();
    await handleHhPublic(req('POST', up.pathname, {
      username: 'alice', token: tok(), candidate_name: 'Анна',
      filename: 'x.txt', data_base64: Buffer.from('текст').toString('base64'),
    }), up, res, ctx());
    const { candidate_id, doc } = JSON.parse(res.body);

    let u = new URL('http://x/hh/candidate-doc-delete'); res = fakeRes();
    await handleHhPublic(req('POST', u.pathname, { username: 'alice', token: 'bad', candidate_id, doc_id: doc.id }), u, res, ctx());
    expect(res.status).toBe(403);

    res = fakeRes();
    await handleHhPublic(req('POST', u.pathname, { username: 'alice', token: tok(), candidate_id, doc_id: doc.id }), u, res, ctx());
    expect(res.status).toBe(200);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'data', 'hh', 'alice', 'candidate-docs', candidate_id, 'manifest.json'), 'utf8'));
    expect(manifest.docs).toHaveLength(0);

    res = fakeRes();
    await handleHhPublic(req('POST', u.pathname, { username: 'alice', token: tok(), candidate_id, doc_id: 'nope1' }), u, res, ctx());
    expect(res.status).toBe(404);
  });

  it('страница несёт кнопку удаления', async () => {
    const up = new URL('http://x/hh/candidate-doc'); let res = fakeRes();
    await handleHhPublic(req('POST', up.pathname, {
      username: 'alice', token: tok(), candidate_name: 'Борис',
      filename: 'b.txt', data_base64: Buffer.from('б').toString('base64'),
    }), up, res, ctx());
    const { candidate_id } = JSON.parse(res.body);
    const u = new URL(`http://x/hh/candidate-new?username=alice&token=${tok()}&candidate_id=${candidate_id}`);
    res = fakeRes();
    await handleHhPublic(req('GET', u.pathname + u.search), u, res, ctx());
    expect(res.body).toContain('data-delete');
    expect(res.body).toContain('Удалить документ');
  });
});

describe('candidate-rename (UX #107)', () => {
  const tok = () => {
    const { createHmac } = require('crypto');
    return createHmac('sha256', 's3cret').update('alice').digest('hex').slice(0, 16);
  };

  it('200 happy / 403 bad token / 400 пустое имя / 404 нет кандидата', async () => {
    const up = new URL('http://x/hh/candidate-doc'); let res = fakeRes();
    await handleHhPublic(req('POST', up.pathname, {
      username: 'alice', token: tok(), filename: 'n.txt', data_base64: Buffer.from('т').toString('base64'),
    }), up, res, ctx());
    const { candidate_id } = JSON.parse(res.body);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'data', 'hh', 'alice', 'candidate-docs', candidate_id, 'manifest.json'), 'utf8')).name).toBe('Кандидат');

    const u = new URL('http://x/hh/candidate-rename');
    res = fakeRes();
    await handleHhPublic(req('POST', u.pathname, { username: 'alice', token: 'bad', candidate_id, name: 'X' }), u, res, ctx());
    expect(res.status).toBe(403);

    res = fakeRes();
    await handleHhPublic(req('POST', u.pathname, { username: 'alice', token: tok(), candidate_id, name: 'Новое имя' }), u, res, ctx());
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).name).toBe('Новое имя');

    res = fakeRes();
    await handleHhPublic(req('POST', u.pathname, { username: 'alice', token: tok(), candidate_id, name: '  ' }), u, res, ctx());
    expect(res.status).toBe(400);

    res = fakeRes();
    await handleHhPublic(req('POST', u.pathname, { username: 'alice', token: tok(), candidate_id: 'nope-1', name: 'Y' }), u, res, ctx());
    expect(res.status).toBe(404);
  });
});

describe('ats-config per-vacancy instructions (epic #112)', () => {
  const tokFor = (u) => require('crypto').createHmac('sha256', 's3cret').update(u).digest('hex').slice(0, 16);

  it('autofills the empty instruction from the template on first save and labels it global', async () => {
    // Isolate the credential root so the template read is deterministic.
    const savedTokens = process.env.AGENT_TOKENS_DIR;
    process.env.AGENT_TOKENS_DIR = path.join(root, 'tokens');
    try {
      const u = new URL('http://x/hh/ats-config');
      const res = fakeRes();
      await handleHhPublic(req('POST', u.pathname, {
        username: 'alice', token: tokFor('alice'), vacancy_id: 'V1',
        config: { vacancy_title: 'X', vacancy_context: 'ctx', required: [{ name: 'C++', weight: 2 }] },
        stages: ['Скрининг', 'Интервью'],
      }), u, res, ctx());
      expect(res.status).toBe(200);
      const file = path.join(root, 'users', 'alice', 'contexts', 'hh', 'ats_config:V1.json');
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')).value;
      expect(saved.message_instructions).toContain('готов ли кандидат выполнить тестовое задание');
      expect(saved.message_instructions_source).toBe('global');
      expect(saved.message_instructions_synced_at).toBeTruthy();
    } finally {
      if (savedTokens === undefined) delete process.env.AGENT_TOKENS_DIR; else process.env.AGENT_TOKENS_DIR = savedTokens;
    }
  });

  it('a recruiter-edited instruction is never overwritten (source → recruiter)', async () => {
    const savedTokens = process.env.AGENT_TOKENS_DIR;
    process.env.AGENT_TOKENS_DIR = path.join(root, 'tokens');
    try {
      const u = new URL('http://x/hh/ats-config');
      const res = fakeRes();
      await handleHhPublic(req('POST', u.pathname, {
        username: 'alice', token: tokFor('alice'), vacancy_id: 'V1',
        config: { vacancy_title: 'X', vacancy_context: 'ctx', message_instructions: 'Моя собственная инструкция этой вакансии' },
      }), u, res, ctx());
      const file = path.join(root, 'users', 'alice', 'contexts', 'hh', 'ats_config:V1.json');
      expect(res.status).toBe(200);
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')).value;
      expect(saved.message_instructions).toBe('Моя собственная инструкция этой вакансии');
      expect(saved.message_instructions_source).toBe('recruiter');
    } finally {
      if (savedTokens === undefined) delete process.env.AGENT_TOKENS_DIR; else process.env.AGENT_TOKENS_DIR = savedTokens;
    }
  });

  it('nothing is shared across vacancies: V2 keeps its own (missing → default), not V1 text', async () => {
    const savedTokens = process.env.AGENT_TOKENS_DIR;
    process.env.AGENT_TOKENS_DIR = path.join(root, 'tokens');
    try {
      const u = new URL('http://x/hh/ats-config');
      const res = fakeRes();
      await handleHhPublic(req('POST', u.pathname, {
        username: 'alice', token: tokFor('alice'), vacancy_id: 'V1',
        config: { vacancy_title: 'X', vacancy_context: 'ctx', message_instructions: 'Только для V1' },
      }), u, res, ctx());
      await handleHhPublic(req('POST', u.pathname, {
        username: 'alice', token: tokFor('alice'), vacancy_id: 'V2',
        config: { vacancy_title: 'Y', vacancy_context: 'ctx2' },
      }), u, fakeRes(), ctx());
      const v1 = JSON.parse(fs.readFileSync(path.join(root, 'users', 'alice', 'contexts', 'hh', 'ats_config:V1.json'), 'utf8')).value;
      const v2 = JSON.parse(fs.readFileSync(path.join(root, 'users', 'alice', 'contexts', 'hh', 'ats_config:V2.json'), 'utf8')).value;
      expect(v1.message_instructions).toBe('Только для V1');
      expect(v2.message_instructions).not.toContain('Только для V1');
      expect(v2.message_instructions).toContain('тестовое задание');
    } finally {
      if (savedTokens === undefined) delete process.env.AGENT_TOKENS_DIR; else process.env.AGENT_TOKENS_DIR = savedTokens;
    }
  });

  it('GET /hh/message-instructions-template serves the default template to the editor', async () => {
    const savedTokens = process.env.AGENT_TOKENS_DIR;
    process.env.AGENT_TOKENS_DIR = path.join(root, 'tokens');
    try {
      const u = new URL('http://x/hh/message-instructions-template?username=alice&token=' + tokFor('alice'));
      const res = fakeRes();
      await handleHhPublic(req('GET', u.pathname + u.search), u, res, ctx());
      expect(res.status).toBe(200);
      const d = JSON.parse(res.body);
      expect(d.ok).toBe(true);
      expect(d.text).toContain('тестовое задание');
    } finally {
      if (savedTokens === undefined) delete process.env.AGENT_TOKENS_DIR; else process.env.AGENT_TOKENS_DIR = savedTokens;
    }
  });

  // The editor page is served from the recruiter's publish domain while CALLBACK_BASE is
  // AGENT_PUBLIC_URL, so «Вернуть общий шаблон» is a cross-origin GET. This endpoint
  // answered 200 with the right body and no Access-Control-Allow-Origin — the browser
  // dropped it and the button reported "Ошибка сети: Failed to fetch" (issue #135).
  it('GET /hh/message-instructions-template is readable cross-origin by the editor page', async () => {
    const savedTokens = process.env.AGENT_TOKENS_DIR;
    process.env.AGENT_TOKENS_DIR = path.join(root, 'tokens');
    try {
      const u = new URL('http://x/hh/message-instructions-template?username=alice&token=' + tokFor('alice'));
      const res = fakeRes();
      await handleHhPublic(req('GET', u.pathname + u.search), u, res, ctx());
      expect(res.status).toBe(200);
      expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
    } finally {
      if (savedTokens === undefined) delete process.env.AGENT_TOKENS_DIR; else process.env.AGENT_TOKENS_DIR = savedTokens;
    }
  });

  it('answers the CORS preflight for the template endpoint', async () => {
    const u = new URL('http://x/hh/message-instructions-template');
    const res = fakeRes();
    await handleHhPublic(req('OPTIONS', u.pathname), u, res, ctx());
    expect(res.status).toBe(204);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
  });
});

// Issue #126 — the live failure the owner reported: on vacancy 137012564 (no ATS config
// file) the recruiter pressed "✦ Сгенерировать", the model wrote a good letter, and then
// the route died on `historySignature(..., null)` AFTER the write — so the letter was
// lost and the page swallowed the 500 into "nothing changed".
describe('POST /hh/generate-message on a vacancy without ATS criteria (issue #126)', () => {
  const tok = () => require('crypto').createHmac('sha256', 's3cret').update('alice').digest('hex').slice(0, 16);

  function stubLadder(answer) {
    nock('https://llm-ladder.trainedassist.store')
      .persist().post('/v1/chat/completions')
      .reply(200, (_uri, body) => {
        // The guard judge must answer its own JSON shape; the writer needs prose.
        if (String(body.messages?.[0]?.content || '').includes('Проверь новое сообщение')) {
          return { choices: [{ message: { content: JSON.stringify({ repeated_question: false, repeated_intro: false, template_garbage: false }) } }], model: body.model };
        }
        return { choices: [{ message: { content: answer } }], model: body.model };
      });
  }

  it('saves the letter and flags the missing criteria instead of failing', async () => {
    const savedTokens = process.env.AGENT_TOKENS_DIR;
    const savedLadder = process.env.LLM_LADDER_TOKEN;
    process.env.AGENT_TOKENS_DIR = path.join(root, 'tokens');
    process.env.LLM_LADDER_TOKEN = 'test-ladder-token';
    const candDir = path.join(root, 'data', 'hh', 'alice', 'candidates');
    fs.mkdirSync(candDir, { recursive: true });
    fs.writeFileSync(path.join(candDir, 'neg1.json'), JSON.stringify({
      messages: [
        { role: 'employer', text: 'Здравствуйте!', hh_id: '1' },
        { role: 'applicant', text: '500 клиентов, 6 млн', hh_id: '2' },
      ],
    }));
    stubLadder('Леван, спасибо за цифры — картина ясна. Давайте созвонимся на этой неделе.');
    try {
      const u = new URL('http://x/hh/generate-message');
      const res = fakeRes();
      await handleHhPublic(req('POST', u.pathname, {
        username: 'alice', token: tok(), negotiation_id: 'neg1', candidate_name: 'Бахтадзе Леван', vacancy_id: 'V1',
      }), u, res, ctx());

      expect(res.status).toBe(200);
      const d = JSON.parse(res.body);
      expect(d.ok).toBe(true);
      expect(d.message).toContain('спасибо за цифры');
      // The page needs this flag to warn instead of leaving stale letters unexplained.
      expect(d.no_ats_config).toBe(true);
      // …and the letter must actually be on disk — that was the real loss.
      const saved = JSON.parse(fs.readFileSync(path.join(candDir, 'neg1.json'), 'utf8'));
      expect(saved.ats_result.draft_message).toContain('спасибо за цифры');
      expect(saved.ats_result.draft_history_sig).toMatch(/^funnel-v\d/);
    } finally {
      nock.cleanAll();
      if (savedTokens === undefined) delete process.env.AGENT_TOKENS_DIR; else process.env.AGENT_TOKENS_DIR = savedTokens;
      if (savedLadder === undefined) delete process.env.LLM_LADDER_TOKEN; else process.env.LLM_LADDER_TOKEN = savedLadder;
    }
  });

  it('a vacancy WITH criteria does not get the warning flag', async () => {
    const savedTokens = process.env.AGENT_TOKENS_DIR;
    const savedLadder = process.env.LLM_LADDER_TOKEN;
    process.env.AGENT_TOKENS_DIR = path.join(root, 'tokens');
    process.env.LLM_LADDER_TOKEN = 'test-ladder-token';
    const ctxDir = path.join(root, 'users', 'alice', 'contexts', 'hh');
    fs.mkdirSync(ctxDir, { recursive: true });
    fs.writeFileSync(path.join(ctxDir, 'ats_config:V1.json'), JSON.stringify({
      value: { vacancy_title: 'Финансовый советник', vacancy_context: 'private banking', required: [{ name: 'AUM от 1 млн USD на клиента', weight: 2 }] },
      updated_at: new Date().toISOString(),
    }));
    const candDir = path.join(root, 'data', 'hh', 'alice', 'candidates');
    fs.mkdirSync(candDir, { recursive: true });
    fs.writeFileSync(path.join(candDir, 'neg2.json'), JSON.stringify({ messages: [{ role: 'employer', text: 'Здравствуйте!', hh_id: '3' }] }));
    stubLadder('Леван, вернёмся к разговору на следующей неделе.');
    try {
      const u = new URL('http://x/hh/generate-message');
      const res = fakeRes();
      await handleHhPublic(req('POST', u.pathname, {
        username: 'alice', token: tok(), negotiation_id: 'neg2', candidate_name: 'Бахтадзе Леван', vacancy_id: 'V1',
      }), u, res, ctx());
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).no_ats_config).toBeUndefined();
    } finally {
      nock.cleanAll();
      if (savedTokens === undefined) delete process.env.AGENT_TOKENS_DIR; else process.env.AGENT_TOKENS_DIR = savedTokens;
      if (savedLadder === undefined) delete process.env.LLM_LADDER_TOKEN; else process.env.LLM_LADDER_TOKEN = savedLadder;
    }
  });
});
