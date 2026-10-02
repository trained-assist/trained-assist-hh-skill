/**
 * Honest degradation of background ATS scoring.
 *
 * The production incident: background scoring ran every 5 minutes, every candidate
 * failed, and the log still looked healthy — the run recorded `scored` only, so
 * "checked N, scored 0" read like a normal quiet cycle while no candidate was ever
 * evaluated. Nothing on the recruiter's side said "оценка не получена".
 *
 * What this pins:
 *   1. a failed scoring attempt is recorded ON the candidate (scoring_error),
 *   2. the run log counts failures (failed), not just successes,
 *   3. the next cycles do NOT burn a ladder call on the same broken candidate
 *      (exponential backoff), but do retry after the window,
 *   4. a success clears the error.
 *
 * No real LLM calls: evaluateCandidate is monkey-patched.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const scoring = require('../src/hh-scoring.js');
const DEFAULT_NEGOTIATIONS = require('./helpers/mock-hh-server.js').DEFAULT_NEGOTIATIONS.map(n => ({ ...n, _resume_status: 'full' }));

const TEST_USER = 'hh-degrade-test-1';
const TEST_ROOT = mkdtempSync(join(tmpdir(), 'hh-scoring-degrade-'));
const ORIGINAL_ENV = Object.fromEntries(['AGENT_DATA_DIR', 'AGENT_TOKENS_DIR', 'LLM_LADDER_TOKEN'].map(k => [k, process.env[k]]));
const WORK_DIR = join(TEST_ROOT, 'users', TEST_USER);
const DATA_DIR = join(TEST_ROOT, 'data');
const CAND_DIR = join(DATA_DIR, 'hh', TEST_USER, 'candidates');

const ATS_CONFIG = {
  knockout: [],
  required: ['Node.js'],
  preferred: [],
  pass_threshold: 6.5,
  review_threshold: 4,
  vacancy_title: 'Backend Developer',
  vacancy_context: 'test',
};

function writeAtsConfig() {
  const dir = join(WORK_DIR, 'contexts', 'hh');
  mkdirSync(dir, { recursive: true });
  // Epic #112: the pipeline reads ONLY the per-vacancy config.
  writeFileSync(join(dir, 'ats_config:vac-001.json'), JSON.stringify({ value: ATS_CONFIG, updated_at: new Date().toISOString() }), { mode: 0o600 });
}

function historyPath(negId) { return join(CAND_DIR, `${negId}.json`); }
function readHistory(negId) { return JSON.parse(readFileSync(historyPath(negId), 'utf8')); }
function readLastRun() { return JSON.parse(readFileSync(join(DATA_DIR, 'hh', TEST_USER, 'last-scoring.json'), 'utf8')); }

beforeAll(() => {
  process.env.AGENT_DATA_DIR = DATA_DIR;
  process.env.AGENT_TOKENS_DIR = join(TEST_ROOT, 'tokens');
  process.env.LLM_LADDER_TOKEN = 'test-ladder-token';
  mkdirSync(CAND_DIR, { recursive: true });
  writeAtsConfig();
});

afterAll(() => {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  if (existsSync(CAND_DIR)) for (const f of readdirSync(CAND_DIR)) rmSync(join(CAND_DIR, f), { force: true });
});

let originalEvaluate;
afterEach(() => { scoring.evaluateCandidate = originalEvaluate; });

describe('scoring failure is recorded, backoff is applied, success clears it', () => {
  it('records the error, counts the failure, and stops burning calls until the window passes', async () => {
    originalEvaluate = scoring.evaluateCandidate;
    let calls = 0;
    scoring.evaluateCandidate = async () => { calls++; throw new Error('llm-ladder HTTP 500: all rungs down'); };

    const negs = DEFAULT_NEGOTIATIONS.slice(0, 1);
    const scored = await scoring.scoreUnscoredCandidates(negs, TEST_USER, WORK_DIR, { vacancyId: 'vac-001' });

    expect(scored).toBe(0);
    expect(calls).toBe(1);
    const run = readLastRun();
    expect(run.checked).toBe(1);
    expect(run.scored).toBe(0);
    expect(run.failed).toBe(1);

    const h = readHistory(negs[0].id);
    expect(h.ats_result?.score ?? null).toBeNull();
    expect(h.scoring_error.message).toMatch(/llm-ladder HTTP 500/);
    expect(h.scoring_error.attempts).toBe(1);

    // Next cycles: still inside the 15-minute backoff → no ladder call at all.
    await scoring.scoreUnscoredCandidates(negs, TEST_USER, WORK_DIR, { vacancyId: 'vac-001' });
    await scoring.scoreUnscoredCandidates(negs, TEST_USER, WORK_DIR, { vacancyId: 'vac-001' });
    expect(calls).toBe(1);
    expect(readHistory(negs[0].id).scoring_error.attempts).toBe(1);

    // Window passes (age the error past the backoff) → retried, succeeds, error cleared.
    const aged = readHistory(negs[0].id);
    aged.scoring_error.at = Date.now() - 2 * 60 * 60 * 1000;
    writeFileSync(historyPath(negs[0].id), JSON.stringify(aged, null, 2));

    scoring.evaluateCandidate = async () => { calls++; return { score: 8, verdict: 'ПРОПУСТИТЬ', matched: [], gaps: [], reasoning: 'ok' }; };
    const scoredAfter = await scoring.scoreUnscoredCandidates(negs, TEST_USER, WORK_DIR, { vacancyId: 'vac-001' });

    expect(scoredAfter).toBe(1);
    expect(calls).toBe(2);
    const after = readHistory(negs[0].id);
    expect(after.ats_result.score).toBe(8);
    expect(after.scoring_error).toBeUndefined();
    expect(readLastRun().failed).toBe(0);
  });

  it('treats a result without a score as a failure, not as a silent success', async () => {
    originalEvaluate = scoring.evaluateCandidate;
    scoring.evaluateCandidate = async () => ({ score: null });

    const negs = DEFAULT_NEGOTIATIONS.slice(0, 1);
    const scored = await scoring.scoreUnscoredCandidates(negs, TEST_USER, WORK_DIR, { vacancyId: 'vac-001' });

    expect(scored).toBe(0);
    expect(readLastRun().failed).toBe(1);
    expect(readHistory(negs[0].id).scoring_error.message).toMatch(/no score/);
  });
});