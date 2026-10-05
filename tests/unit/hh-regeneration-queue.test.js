import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createRegenerationQueue } = require('../../src/hh-regeneration-queue');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

it('keeps a durable bounded queue, deduplicates start requests, and retries only failed candidates', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-regen-queue-'));
  let active = 0, maximum = 0, failedOnce = false;
  const queue = createRegenerationQueue({ root, concurrency: 2, processCandidate: async (_job, item) => {
    active += 1; maximum = Math.max(maximum, active);
    await pause(8);
    active -= 1;
    if (item.negotiation_id === 'n3' && !failedOnce) { failedOnce = true; throw new Error('temporary provider failure'); }
    return { message: `draft:${item.negotiation_id}`, funnel_action: 'ask_skills' };
  } });
  try {
    const ids = Array.from({ length: 9 }, (_, i) => `n${i}`);
    const created = queue.enqueue({ username: 'alice', vacancyId: 'vac1', negotiationIds: ids, requestKey: 'request-1' });
    const duplicate = queue.enqueue({ username: 'alice', vacancyId: 'vac1', negotiationIds: ids, requestKey: 'request-1' });
    expect(duplicate.job.id).toBe(created.job.id);
    expect(duplicate.existing).toBe(true);
    expect(queue.enqueue({ username: 'alice', vacancyId: 'vac1', negotiationIds: ['other'], requestKey: 'request-2' }).conflict).toBe(true);
    let status;
    for (let i = 0; i < 100; i++) {
      status = queue.get('alice', created.job.id);
      if (status.status === 'completed_with_errors') break;
      await pause(10);
    }
    expect(status.status).toBe('completed_with_errors');
    expect(status.counts).toEqual({ queued: 0, running: 0, succeeded: 8, failed: 1 });
    expect(maximum).toBeLessThanOrEqual(2);
    const change = queue.get('alice', created.job.id, 0).changes.find(x => x.negotiation_id === 'n0');
    expect(change.message).toBe('draft:n0');
    expect(queue.retryFailed('alice', created.job.id)).not.toBeNull();
    for (let i = 0; i < 100; i++) {
      status = queue.get('alice', created.job.id);
      if (status.status === 'completed') break;
      await pause(10);
    }
    expect(status.status).toBe('completed');
    expect(status.counts).toEqual({ queued: 0, running: 0, succeeded: 9, failed: 0 });
    expect(fs.statSync(path.join(root, 'hh', 'alice', 'regeneration-jobs', `${created.job.id}.json`)).mode & 0o777).toBe(0o600);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('recovers queued and interrupted candidates after a process restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-regen-recover-'));
  const never = () => new Promise(() => {});
  const first = createRegenerationQueue({ root, concurrency: 1, processCandidate: never });
  try {
    const { job } = first.enqueue({ username: 'alice', vacancyId: 'vac1', negotiationIds: ['n1', 'n2'], requestKey: 'restart-1' });
    for (let i = 0; i < 40 && first.get('alice', job.id).counts.running === 0; i++) await pause(5);
    const restarted = createRegenerationQueue({ root, concurrency: 1, processCandidate: async (_j, item) => ({ message: `resumed:${item.negotiation_id}` }) });
    restarted.recoverAll();
    let status;
    for (let i = 0; i < 100; i++) {
      status = restarted.get('alice', job.id);
      if (status.status === 'completed') break;
      await pause(10);
    }
    expect(status.status).toBe('completed');
    expect(status.counts.succeeded).toBe(2);
    expect(status.changes.filter(x => x.status === 'succeeded').map(x => x.message)).toEqual(['resumed:n1', 'resumed:n2']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
