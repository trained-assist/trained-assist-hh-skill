import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const jobs = require('../../src/hh-proactive-search-job');
let dataDir, previousDataDir;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'hh-proactive-search-job-'));
  previousDataDir = process.env.AGENT_DATA_DIR;
  process.env.AGENT_DATA_DIR = dataDir;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.AGENT_DATA_DIR;
  else process.env.AGENT_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

async function waitFor(username, vacancyId, predicate) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const job = jobs.read(username, vacancyId);
    if (predicate(job)) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('job did not reach expected state');
}

describe('durable proactive search jobs', () => {
  it('returns immediately, persists phase progress and completes with a compact result', async () => {
    let continueSearch;
    const gate = new Promise(resolve => { continueSearch = resolve; });
    const started = jobs.start({
      username: 'alice', vacancyId: 'vac-1',
      runSearch: async progress => {
        await progress({ phase: 'ai_scoring', message: 'Оцениваю кандидатов по ATS… (10 из 20)', progress: 60, completed: 10, total: 20 });
        await gate;
        return { total_found: 20, count: 18, ai_pending_count: 2, new_ids: ['must-not-be-persisted'] };
      },
    });

    expect(started.ok).toBe(true);
    expect(started.job.state).toBe('queued');
    const progressing = await waitFor('alice', 'vac-1', j => j?.phase === 'ai_scoring');
    expect(progressing).toMatchObject({ state: 'running', completed: 10, total: 20, progress: 60 });
    expect(jobs.active('alice', 'vac-1')).toMatchObject({ id: progressing.id, state: 'running' });

    continueSearch();
    const done = await waitFor('alice', 'vac-1', j => j?.state === 'partial');
    expect(done).toMatchObject({ progress: 100, result: { total_found: 20, count: 18, ai_pending_count: 2 } });
    expect(JSON.stringify(done)).not.toContain('must-not-be-persisted');
  });

  it('reuses the active vacancy job instead of launching a duplicate', async () => {
    let continueSearch;
    const gate = new Promise(resolve => { continueSearch = resolve; });
    let calls = 0;
    const first = jobs.start({ username: 'alice', vacancyId: 'vac-1', runSearch: async () => { calls++; await gate; return { total_found: 0, count: 0, ai_pending_count: 0 }; } });
    const duplicate = jobs.start({ username: 'alice', vacancyId: 'vac-1', runSearch: async () => { calls++; return {}; } });
    expect(duplicate.existing).toBe(true);
    expect(duplicate.job.id).toBe(first.job.id);
    expect(calls).toBe(0); // worker starts on the next microtask
    continueSearch();
    await waitFor('alice', 'vac-1', j => j?.state === 'done');
    expect(calls).toBe(1);
  });

  it('records background exceptions as a readable failed state', async () => {
    jobs.start({ username: 'alice', vacancyId: 'vac-1', runSearch: async () => { throw new Error('fixture failure'); } });
    const failed = await waitFor('alice', 'vac-1', j => j?.state === 'failed');
    expect(failed).toMatchObject({ phase: 'failed', message: 'fixture failure', error: 'SEARCH_FAILED' });
  });
});
