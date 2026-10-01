// Cold search ranks candidates by the ATS funnel the recruiter edits in /hh/ats-editor
// (стоп-факторы, обязательные, желательные, пороги) — one place for "who we look for".
// Replaces hh-search-prompt.test.js: the separate free-text search prompt was folded
// back into the ATS funnel (owner decision 2026-09-29), only the queries stay editable.
// Regression: a «Программист 1С» ranked #1 for «Инженер-конструктор» because the
// keyword pre-score matched «опыт»/«работы» and stop-factors never affected the order.
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

const CONFIG = {
  vacancy_id: 'A', vacancy_title: 'Инженер-конструктор',
  required: [
    { name: 'опыт работы инженером-конструктором от 5 лет', weight: 3 },
    { name: 'уверенное владение КОМПАС-3D / SolidWorks', weight: 3 },
  ],
  preferred: [{ name: 'портфолио крупных сборок', weight: 1.5 }],
  knockout: ['отсутствие опыта работы инженером-конструктором от 5 лет'],
  filters: { min_experience_years: 5 },
  pass_threshold: 7, review_threshold: 5,
};
const PROGRAMMER = { id: 'r1c', title: 'Программист 1С', total_experience: { months: 300 },
  experience: [{ position: 'Программист 1С', company: 'Франчайзи', description: 'Опыт работы с конфигурациями, разработка отчётов' }] };
const ENGINEER = { id: 'reng', title: 'Инженер-конструктор', total_experience: { months: 120 },
  experience: [{ position: 'Инженер-конструктор', company: 'Станкозавод', description: 'КОМПАС-3D, сборки' }] };
const response = (status, body = {}) => ({ ok: status === 200, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });

let root, saved;
beforeEach(() => {
  saved = Object.fromEntries(['AGENT_DATA_DIR', 'AGENT_TOKENS_DIR', 'USERS_DIR', 'AGENT_SECRET', 'OPENROUTER_API_KEY', 'LLM_LADDER_TOKEN'].map(k => [k, process.env[k]]));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-ats-scoring-'));
  process.env.AGENT_DATA_DIR = path.join(root, 'data');
  process.env.AGENT_TOKENS_DIR = path.join(root, 'tokens');
  process.env.USERS_DIR = path.join(root, 'users');
  process.env.AGENT_SECRET = 's3cret';
  process.env.OPENROUTER_API_KEY = 'or-test';
  process.env.LLM_LADDER_TOKEN = 'ladder-test'; // evaluation/enrichment ride the free ladder
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('ATS score', () => {
  it('a violated stop-factor caps the score at 2, tags follow the funnel thresholds', () => {
    expect(api.atsScoreFields({ score: 8, knockout_failed: ['нет опыта конструктора'] }, CONFIG)).toMatchObject({ score: 2, tag: 'WEAK', ats_scored: true });
    expect(api.atsScoreFields({ score: 7.3, knockout_failed: [] }, CONFIG)).toMatchObject({ score: 7.5, score_pct: 75, tag: 'PASS' });
    expect(api.atsScoreFields({ score: 6 }, { ...CONFIG, review_threshold: 6.5 }).tag).toBe('WEAK');
  });

  it('a JSON answer without a usable score is marked done (degraded), not left "unscored"', () => {
    // 2026-09-30 leak guard: returning {} left the record permanently unscored and
    // the background pass re-bought it from the LLM on every tick.
    const deg = api.atsScoreFields({ plus_tags: ['x'] }, CONFIG);
    expect(deg).toMatchObject({ ats_scored: true, ats_degraded: true });
    expect(deg.ats_hash).toBe(api.atsScoringHash(CONFIG));
    expect(deg.score).toBeUndefined();
    // …but a genuinely empty answer stays unmarked (nothing to persist).
    expect(api.atsScoreFields(null, CONFIG)).toEqual({});
    // A degraded record is NOT re-scored by the background pass under the same funnel.
    expect(api.needsAtsScore({ ...deg }, api.atsScoringHash(CONFIG))).toBe(false);
    // …until the funnel changes.
    expect(api.needsAtsScore({ ...deg }, api.atsScoringHash({ ...CONFIG, knockout: [] }))).toBe(true);
  });

  it('generic words («опыт», «работы») no longer count as a criterion match', () => {
    // The keyword pre-score only picks who gets AI-scored first, but it must not
    // hand a 1С programmer the «опыт работы инженером-конструктором» criterion.
    const res = api.scoreCandidate(PROGRAMMER, api.normalizeAtsConfig(CONFIG));
    expect(res.signals.join(' ')).not.toContain('инженером-конструктором');
  });

  it('orders scored candidates by ATS score and puts not-yet-scored ones last', () => {
    const list = [{ id: 'u', pre_score: 99 }, { id: 'low', ats_scored: true, score: 2 }, { id: 'hi', ats_scored: true, score: 8 }];
    expect(list.sort(api.compareByAtsScore).map(c => c.id)).toEqual(['hi', 'low', 'u']);
  });

  it('editing the funnel changes the scoring fingerprint', () => {
    expect(api.atsScoringHash(CONFIG)).not.toBe(api.atsScoringHash({ ...CONFIG, knockout: [] }));
    expect(api.atsScoringHash(CONFIG)).toBe(api.atsScoringHash({ ...CONFIG }));
  });

  it('carryAssessment moves a stored assessment onto a fresh search object only under the same funnel', () => {
    const hash = api.atsScoringHash(CONFIG);
    const fresh = { id: 'r1', title: 'Инженер', pre_score: 7 };   // what a new search builds: no ats_* at all
    const prev = { score: 8, score_pct: 80, tag: 'PASS', ats_scored: true, ats_hash: hash,
      plus_tags: ['КОМПАС-3D'], summary_why: 'сильный', source: 'search' };

    const carried = api.carryAssessment(fresh, prev, hash);
    expect(carried).toMatchObject({ id: 'r1', pre_score: 7, score: 8, tag: 'PASS', ats_scored: true, plus_tags: ['КОМПАС-3D'] });
    expect(carried).not.toBe(fresh);

    // funnel edited (hash differs) → untouched, a re-score IS due
    expect(api.carryAssessment(fresh, prev, api.atsScoringHash({ ...CONFIG, knockout: [] }))).toBe(fresh);
    // no stored assessment → untouched
    expect(api.carryAssessment(fresh, null, hash)).toBe(fresh);
    expect(api.carryAssessment(fresh, { id: 'r1' }, hash)).toBe(fresh);
  });

  it('storeAssessment prefers vacancy-scoped fields and never fabricates a score', () => {
    const raw = { id: 'r1', ats_scored: true, score: 8, ats_hash: 'abc',
      vacancy_data: { A: { score: 6.5, tag: 'REVIEW' } } };
    expect(api.storeAssessment(raw, 'A')).toMatchObject({ score: 6.5, tag: 'REVIEW', ats_hash: 'abc' });
    expect(api.storeAssessment(raw, 'B')).toMatchObject({ score: 8 });          // no scope → top-level
    expect(api.storeAssessment(undefined, 'A')).toBeNull();
    // candidateForVacancy (the render path) would have fabricated score:0 here —
    // storeAssessment must not, or the carry path would believe a fake assessment.
    const wildcard = { id: 'w', ats_scored: true, score: 8, ats_hash: 'abc' };
    expect(api.storeAssessment(wildcard, 'A').score).toBe(8);
  });
});

function fixture(user = 'rec') {
  const workDir = path.join(root, 'users', user);
  const ctx = path.join(workDir, 'contexts', 'hh');
  fs.mkdirSync(ctx, { recursive: true });
  fs.mkdirSync(path.join(root, 'tokens', user), { recursive: true });
  fs.writeFileSync(path.join(root, 'tokens', user, 'hh'), '{"access_token":"fixture"}');
  const put = (key, value) => fs.writeFileSync(path.join(ctx, key + '.json'), JSON.stringify({ value }));
  put('active_vacancies', [{ id: 'A', title: 'Инженер-конструктор', area: { id: '1', name: 'Златоуст' } }]);
  put('ats_config:A', CONFIG);
  const scoringPrompts = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (String(url).startsWith('https://openrouter.ai') || String(url).startsWith('https://llm-ladder.trainedassist.store')) {
      const content = JSON.parse(init.body).messages[0].content;
      if (content.includes('поисковых запросов')) return response(200, { choices: [{ message: { content: '["Инженер-конструктор"]' } }] });
      scoringPrompts.push(content);
      const isProgrammer = content.includes('Программист 1С');
      const reply = isProgrammer
        ? { score: 6, knockout_failed: ['отсутствие опыта работы инженером-конструктором от 5 лет'], plus_tags: ['стаж'], red_tags: ['другая профессия'] }
        : { score: 8.5, knockout_failed: [], plus_tags: ['КОМПАС-3D'] };
      return response(200, { choices: [{ message: { content: JSON.stringify(reply) } }] });
    }
    return response(200, { items: [PROGRAMMER, ENGINEER] });
  }));
  return { user, workDir, put, scoringPrompts };
}

describe('cold search end to end (HH and LLM stubbed)', () => {
  it('scores against the ATS funnel and ranks the engineer above the 1С programmer', async () => {
    const { user, workDir, scoringPrompts } = fixture();
    const run = await api.runProactiveSearch(user, workDir, { vacancyId: 'A' });
    const snapshot = JSON.parse(fs.readFileSync(run.file, 'utf8'));
    expect(snapshot.candidates.map(c => [c.id, c.score, c.tag])).toEqual([['reng', 8.5, 'PASS'], ['r1c', 2, 'WEAK']]);
    const prompt = scoringPrompts[0];
    expect(prompt).toContain('СТОП-ФАКТОРЫ');
    expect(prompt).toContain('отсутствие опыта работы инженером-конструктором от 5 лет');
    expect(prompt).toContain('уверенное владение КОМПАС-3D / SolidWorks (вес 3)');
    expect(prompt).not.toContain('Эвристический');
    expect(api.buildScoringPromptText(user, 'A')).toContain('АТС-воронке');
  });

  it('re-scores in the background after the funnel is edited in the ATS editor', async () => {
    const { user, workDir, put, scoringPrompts } = fixture();
    await api.runProactiveSearch(user, workDir, { vacancyId: 'A' });
    expect(await api.scoreUnscoredProactiveCandidates(user)).toBe(0);
    put('ats_config:A', { ...CONFIG, knockout: [...CONFIG.knockout, 'нет опыта на производстве'] });
    // Snapshot saved in the wrong order: the background pass must write it back sorted.
    const snapFile = require('../../src/hh-cold-search-snapshots').latestProactiveFile(user, 'A');
    const stale = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
    stale.candidates.reverse();
    fs.writeFileSync(snapFile, JSON.stringify(stale));
    const before = scoringPrompts.length;
    expect(await api.scoreUnscoredProactiveCandidates(user)).toBe(2);
    expect(scoringPrompts.slice(before).every(p => p.includes('нет опыта на производстве'))).toBe(true);
    const snapshot = JSON.parse(fs.readFileSync(require('../../src/hh-cold-search-snapshots').latestProactiveFile(user, 'A'), 'utf8'));
    expect(snapshot.candidates.map(c => c.id)).toEqual(['reng', 'r1c']);
  });

  it('leak guard: a rebuilt snapshot does not re-buy already-scored candidates from the LLM', async () => {
    // 2026-09-30 incident: every 30-min search wrote fresh HH objects without ats_*
    // fields → the background pass saw "unscored" and re-enriched the same ~250
    // candidates per cycle (~12k LLM calls/day). The store, not the snapshot, is
    // the source of truth — carrying must happen with ZERO LLM traffic.
    const { user, workDir, scoringPrompts } = fixture();
    await api.runProactiveSearch(user, workDir, { vacancyId: 'A' });
    const snapFile = require('../../src/hh-cold-search-snapshots').latestProactiveFile(user, 'A');
    const firstRunPrompts = scoringPrompts.length;
    expect(firstRunPrompts).toBeGreaterThan(0);

    // Simulate what a fresh search writes: same candidates, no assessment fields.
    const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
    snap.candidates = snap.candidates.map(c => {
      const { score, score_pct, tag, knockout_failed, ats_scored, ats_hash, ats_degraded,
        plus_tags, yellow_tags, red_tags, summary_why, summary_pitch, ...rest } = c;
      return rest;
    });
    fs.writeFileSync(snapFile, JSON.stringify(snap));

    expect(await api.scoreUnscoredProactiveCandidates(user)).toBe(2);   // both carried…
    expect(scoringPrompts.length).toBe(firstRunPrompts);                // …without a single LLM call

    const healed = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
    expect(healed.candidates.every(c => c.ats_scored)).toBe(true);
    expect(healed.candidates.map(c => [c.id, c.tag])).toEqual([['reng', 'PASS'], ['r1c', 'WEAK']]);
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

  it('saves edited queries only with the profile token; manual queries are used as-is', async () => {
    expect((await call('POST', '/api/hh/proactive/prompt', { username: 'alice', token: 'bad', vacancy_id: 'A', queries: 'x' })).status).toBe(403);
    expect((await call('POST', '/api/hh/proactive/prompt', { username: 'alice', token, vacancy_id: '../x', queries: 'x' })).status).toBe(400);
    const savedRes = await call('POST', '/api/hh/proactive/prompt', { username: 'alice', token, vacancy_id: 'A', queries: 'Конструктор\n\nТехнолог' });
    expect(savedRes.status).toBe(200);
    expect(savedRes.data).toMatchObject({ ok: true, queries: ['Конструктор', 'Технолог'], queries_manual: true });
    expect(savedRes.data.prompt).toBeUndefined();
    expect(api.loadStoredQueries('alice', 'A', 'other-hash')).toEqual(['Конструктор', 'Технолог']);
    expect(api.saveSearchSettings('alice', 'A', { queries: [] }).queries_state).toBe('reset');
  });

  it('the page has one place for criteria (ATS editor link), no free-text prompt, and marks unscored cards', () => {
    const html = generateProactivePageHtml({ vacancy_title: 'X', candidates: [
      { id: 'a', title: 'Инженер', ats_scored: true, score: 8, tag: 'PASS', experience: [] },
      { id: 'b', title: 'Новый', pre_score: 5, experience: [] },
    ] }, 'alice', 'http://x', token, {}, {
      vacancyId: 'A', searchSettings: { queries: ['Конструктор'], queries_manual: false, explanation: 'Как мы подбираем' },
    });
    expect(html).toContain('data-testid="ats-editor-link"');
    expect(html).toContain('/hh/ats-editor?username=alice');
    expect(html).toContain('data-testid="prompt-panel"');
    expect(html).not.toContain('id="promptText"');
    expect(html).not.toContain('Кого ищем');
    expect(html).toContain('оценивается');
    new Function(html.match(/<script>([\s\S]*)<\/script>/)[1]);
  });
});
