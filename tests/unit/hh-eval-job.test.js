// src/hh-eval-job.js — «Запустить оценку» (#90): формула, ранг, стейт-машина job.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const job = require('../../src/hh-eval-job.js');
const cand = require('../../src/hh-candidate-docs.js');

let dataDir, usersDir, saved;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'hh-eval-data-'));
  usersDir = mkdtempSync(join(tmpdir(), 'hh-eval-users-'));
  saved = { AGENT_DATA_DIR: process.env.AGENT_DATA_DIR, USERS_DIR: process.env.USERS_DIR };
  process.env.AGENT_DATA_DIR = dataDir;
  process.env.USERS_DIR = usersDir;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(usersDir, { recursive: true, force: true });
});

const ROWS = [
  { name: 'Node.js', klass: 'must', weight: 2, score: 4, evidence: 'ok' },
  { name: 'PostgreSQL', klass: 'must', weight: 2, score: 3, evidence: 'ok' },
  { name: 'Docker', klass: 'nice', weight: 1, score: 5, evidence: 'ok' },
];

describe('weightedTotals', () => {
  it('computes Σ(s×w)/Σ(5w) → percent, 0-10 and verdict from thresholds', () => {
    // sum = 4*2+3*2+5*1 = 19; max = 5*5 = 25 → 76%
    const t = job.weightedTotals(ROWS);
    expect(t.percent).toBe(76);
    expect(t.score10).toBe(7.6);
    expect(t.verdict).toBe('ПРОПУСТИТЬ'); // ≥65
    expect(t.veto).toEqual([]);
  });

  it('veto: any must-have ≤1 → ОТКЛОНИТЬ regardless of the sum', () => {
    const rows = [...ROWS, { name: '1С', klass: 'must', weight: 3, score: 1, evidence: 'нет' }];
    const t = job.weightedTotals(rows);
    expect(t.veto).toEqual(['1С']);
    expect(t.verdict).toBe('ОТКЛОНИТЬ');
  });

  it('n/a (null) rows do not enter the sums', () => {
    const t = job.weightedTotals([
      { name: 'A', klass: 'must', weight: 2, score: 5, evidence: 'x' },
      { name: 'B', klass: 'must', weight: 2, score: null, evidence: '' },
    ]);
    expect(t.percent).toBe(100); // только A участвует: 10/10
    expect(t.veto).toEqual([]);
  });

  it('no scored rows → null percent and null verdict', () => {
    const t = job.weightedTotals([{ name: 'A', klass: 'must', weight: 2, score: null }]);
    expect(t).toMatchObject({ percent: null, score10: null, verdict: null, veto: [] });
  });

  it('band edges: 60% → УТОЧНИТЬ, 20% nice → ОТКЛОНИТЬ (без veto)', () => {
    expect(job.weightedTotals([{ name: 'A', klass: 'nice', weight: 1, score: 3 }], { passThreshold: 65, reviewThreshold: 40 }).verdict).toBe('УТОЧНИТЬ');
    expect(job.weightedTotals([{ name: 'A', klass: 'nice', weight: 1, score: 1 }], { passThreshold: 65, reviewThreshold: 40 }).verdict).toBe('ОТКЛОНИТЬ');
  });
});

describe('comparisonFor', () => {
  it('places the candidate among the pool and summarises it', () => {
    const c = job.comparisonFor(60, [71, 52, 38, 65, 44, 58, 70, 50]);
    expect(c.place).toBe(4); // 71,70,65 выше
    expect(c.total).toBe(9);
    expect(c.min).toBe(38);
    expect(c.max).toBe(71);
    expect(c.avg).toBeGreaterThanOrEqual(50);
  });

  it('null percent → null', () => {
    expect(job.comparisonFor(null, [1, 2])).toBeNull();
  });
});

describe('comparisonPool', () => {
  it('collects HH ats_results, proactive scores and finished jobs', async () => {
    const root = join(dataDir, 'hh', 'u1');
    mkdirSync(join(root, 'candidates'), { recursive: true });
    writeFileSync(join(root, 'candidates', 'neg-1.json'), JSON.stringify({ ats_result: { score: 7, verdict: 'ПРОПУСТИТЬ' } }));
    mkdirSync(join(root, 'proactive'), { recursive: true });
    writeFileSync(join(root, 'proactive', 'all-candidates.json'), JSON.stringify({
      a: { score: 6, vacancy_ids: ['V1'] },
      b: { score: 12, vacancy_ids: ['OTHER'] },
      c: { score: 3, vacancy_ids: [] },
    }));
    mkdirSync(join(root, 'candidate-eval'), { recursive: true });
    writeFileSync(join(root, 'candidate-eval', 'x.job.json'), JSON.stringify({ state: 'done', vacancy_id: 'V1', percent: 80 }));
    writeFileSync(join(root, 'candidate-eval', 'y.job.json'), JSON.stringify({ state: 'done', vacancy_id: 'V1', percent: 45 }));
    writeFileSync(join(root, 'candidate-eval', 'self.job.json'), JSON.stringify({ state: 'done', vacancy_id: 'V1', percent: 99 }));

    const pool = job.comparisonPool('u1', 'V1', 'self');
    expect(pool).toContain(70);   // ats 7/10
    expect(pool).toContain(50);   // proactive 6/12
    expect(pool).toContain(25);   // wildcard 3/12
    expect(pool).not.toContain(50 * 2); // другой vacancy (12/12=100) отфильтрован
    expect(pool).toContain(80);
    expect(pool).toContain(45);
    expect(pool).not.toContain(99); // self исключён
  });
});

describe('assemble + runEvalJob', () => {
  // Epic #112: per-vacancy configs only — assemble reads ats_config:{vacancy_id}.
  const VACANCY = 'vac-901';
  async function setup() {
    const out = await cand.addDocument({ username: 'u1', candidateName: 'Иван Петров', filename: 'cv.txt', buffer: Buffer.from('Опыт работы\n2023 – 2025', 'utf8') });
    const ctx = join(usersDir, 'u1', 'contexts', 'hh');
    mkdirSync(ctx, { recursive: true });
    writeFileSync(join(ctx, `ats_config:${VACANCY}.json`), JSON.stringify({
      value: {
        vacancy_title: 'Backend', vacancy_context: 'fixture',
        required: [{ name: 'Node.js', weight: 2 }], preferred: [{ name: 'Docker', weight: 1 }],
        pass_threshold: 6.5, review_threshold: 4,
      },
    }));
    return out.candidate_id;
  }

  it('assemble resolves config from ats_config', async () => {
    const id = await setup();
    const a = job.assemble('u1', id, VACANCY);
    expect(a.error).toBeNull();
    expect(a.configSource).toBe('ats_config');
    expect(a.candidateText).toContain('Опыт работы');
  });

  it('assemble falls back to the portrait for criteria', async () => {
    const out = await cand.addDocument({ username: 'u1', candidateName: 'Ольга', filename: 'cv.txt', buffer: Buffer.from('2020 – 2024', 'utf8') });
    const { writePortrait } = require('../../src/hh-portrait.js');
    const p = require('../../src/hh-portrait.js').emptyPortrait();
    p.vacancy.title = 'Маркетолог';
    p.requirements.hard_skills = ['SEO'];
    writePortrait(join(usersDir, 'u1'), 'draft', p);
    const a = job.assemble('u1', out.candidate_id, 'draft');
    expect(a.error).toBeNull();
    expect(a.configSource).toBe('portrait');
    expect(a.config.required.map(r => r.name)).toEqual(['SEO']);
  });

  it('assemble reports honest errors', () => {
    expect(job.assemble('u1', 'nope', null).error).toMatch(/не найден/);
  });

  it('runEvalJob walks queued→running→done with progress and flat result fields', async () => {
    const id = await setup();
    const j = {
      id, candidate_id: id, username: 'u1', vacancy_id: VACANCY,
      state: 'queued', step: 'queued', progress: 0,
      started_at: new Date().toISOString(), finished_at: null, error: null,
    };
    const steps = [];
    const done = await job.runEvalJob(j, {
      scoreFn: async () => {
        steps.push(1);
        return { rows: [{ name: 'Node.js', klass: 'must', weight: 2, score: 4, evidence: 'ok' }, { name: 'Docker', klass: 'nice', weight: 1, score: 3, evidence: 'ok' }], reasoning: 'fixture' };
      },
    });
    expect(steps).toHaveLength(1);
    expect(done.state).toBe('done');
    expect(done.progress).toBe(100);
    // sum = 4*2+3 = 11; max = 5*3 = 15 → 73%
    expect(done.percent).toBe(73);
    expect(done.score10).toBe(7.3);
    expect(done.verdict).toBe('ПРОПУСТИТЬ');
    expect(done.comparison).toBeTruthy();
    expect(done.comparison.total).toBeGreaterThanOrEqual(1);
    expect(done.spent_minutes).toBeGreaterThanOrEqual(0.1);
    expect(done.vacancy_title).toBe('Backend');

    const onDisk = JSON.parse(readFileSync(job.jobPath('u1', id), 'utf8'));
    expect(onDisk.state).toBe('done');
    expect(onDisk.percent).toBe(73);
  });

  it('runEvalJob marks failure with the reason', async () => {
    const id = await setup();
    const j = { id, candidate_id: id, username: 'u1', vacancy_id: VACANCY, state: 'queued', started_at: new Date().toISOString() };
    const done = await job.runEvalJob(j, { scoreFn: async () => { throw new Error('LLM упал'); } });
    expect(done.state).toBe('failed');
    expect(done.error).toContain('LLM упал');
    expect(job.readJob('u1', id).state).toBe('failed');
  });
});
