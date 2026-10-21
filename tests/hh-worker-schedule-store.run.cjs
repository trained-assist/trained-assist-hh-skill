'use strict';
// The worker's schedule store (#187 step 4): durable unique occurrences, a
// lease that keeps two ticks apart, and coalesced missed runs. These are the
// properties the retiring scheduler had and that the migration must preserve.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ScheduleStore } = require('../src/hh-worker-schedule-store');

function freshStore(nowIso = '2026-10-22T06:00:00.000Z') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-worker-store-'));
  const stateFile = path.join(dir, 'schedule.json');
  let current = Date.parse(nowIso);
  const store = new ScheduleStore({
    stateFile,
    now: () => new Date(current),
    owner: 'test',
  });
  return { store, stateFile, dir, setNow: (iso) => { current = Date.parse(iso); } };
}

function seed(store, overrides = {}) {
  return store.upsert({
    profileId: 'tes-recruiter',
    name: 'cold-search:137012564',
    action: 'hh_proactive_search',
    schedule: '23,53 * * * *',
    timezone: 'Europe/Moscow',
    arguments: { vacancy_id: '137012564' },
    enabled: true,
    ...overrides,
  });
}

test('a job keeps its cron expression and timezone', () => {
  const { store } = freshStore();
  const job = seed(store);
  assert.equal(job.schedule, '23,53 * * * *');
  assert.equal(job.timezone, 'Europe/Moscow');
  assert.equal(job.profile_id, 'tes-recruiter');
  assert.equal(job.enabled, true);
});

test('the same minute is due once, however often the tick runs', () => {
  const { store, setNow } = freshStore();
  seed(store);
  setNow('2026-10-22T06:24:00.000Z');
  const first = store.generate();
  const second = store.generate();
  assert.equal(first.created.length, 1);
  assert.equal(second.created.length, 0);
  const state = store.read();
  assert.equal(Object.keys(state.occurrences).length, 1);
});

test('missed minutes of one job collapse into a single run', () => {
  const { store, setNow } = freshStore('2026-10-22T00:00:00.000Z');
  seed(store);
  // The first tick stores the cursor; the worker is then away for five hours.
  store.generate();
  setNow('2026-10-22T05:00:00.000Z');
  const generated = store.generate();
  assert.equal(generated.created.length, 1);
  assert.equal(generated.coalesced.length, 9);
  const state = store.read();
  const statuses = Object.values(state.occurrences).map(o => o.status).sort();
  assert.equal(statuses.filter(s => s === 'pending').length, 1);
  assert.equal(statuses.filter(s => s === 'coalesced').length, 9);
});

test('a leased occurrence is not claimed twice', () => {
  const { store, setNow } = freshStore();
  seed(store);
  setNow('2026-10-22T06:24:00.000Z');
  store.generate();
  const first = store.claim();
  assert.equal(first.length, 1);
  assert.equal(first[0].status, 'running');
  assert.ok(first[0].lease_until);
  const second = store.claim();
  assert.equal(second.length, 0);
});

test('an expired lease makes the occurrence claimable again', () => {
  const { store, setNow } = freshStore();
  seed(store);
  setNow('2026-10-22T06:24:00.000Z');
  store.generate();
  store.claim();
  setNow('2026-10-22T06:45:00.000Z');
  const reclaimed = store.claim();
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].attempts, 2);
});

test('a finished run records the outcome on the job', () => {
  const { store, setNow } = freshStore();
  seed(store);
  setNow('2026-10-22T06:24:00.000Z');
  store.generate();
  const [occurrence] = store.claim();
  store.complete(occurrence.key, { ok: true });
  const state = store.read();
  assert.equal(state.occurrences[occurrence.key].status, 'succeeded');
  assert.equal(state.jobs[`tes-recruiter:cold-search:137012564`].last_status, 'succeeded');
});

test('a failed run keeps the error message', () => {
  const { store, setNow } = freshStore();
  seed(store);
  setNow('2026-10-22T06:24:00.000Z');
  store.generate();
  const [occurrence] = store.claim();
  store.complete(occurrence.key, { ok: false, error: 'timeout' });
  assert.equal(store.read().occurrences[occurrence.key].error, 'timeout');
});

test('a disabled job is never due', () => {
  const { store, setNow } = freshStore();
  seed(store, { enabled: false });
  setNow('2026-10-22T06:24:00.000Z');
  const generated = store.generate();
  assert.equal(generated.created.length, 0);
});

test('migrated legacy jobs arrive disabled and keep their identity', () => {
  const { store } = freshStore();
  const mapping = store.migrateLegacy([
    {
      legacy_job_id: 'cron-1',
      profile_id: 'mbk_luda_recruiter',
      name: 'cold-search:137575883',
      schedule: '41 10 * * *',
      timezone: 'Europe/Moscow',
      action: 'hh_proactive_search',
      arguments: { vacancy_id: '137575883' },
      last_status: 'unknown',
    },
    {
      legacy_job_id: 'cron-2',
      profile_id: 'mbk_luda_recruiter',
      name: 'cold-search:137230181',
      schedule: '20 9 * * *',
      timezone: 'Europe/Moscow',
      action: 'hh_proactive_search',
      arguments: { vacancy_id: '137230181' },
      last_status: 'succeeded',
    },
  ], { source: 'test-source' });

  assert.equal(mapping.length, 2);
  assert.equal(mapping[0].enabled, false);
  assert.equal(mapping[0].legacy_last_status, 'unknown');
  assert.equal(mapping[0].decision, 'quarantined_pending_owner');
  assert.equal(mapping[1].decision, 'migrated_disabled');
  const state = store.read();
  const job = state.jobs['mbk_luda_recruiter:cold-search:137575883'];
  assert.equal(job.enabled, false);
  assert.equal(job.schedule, '41 10 * * *');
  assert.equal(job.legacy.legacy_job_id, 'cron-1');
});

test('a broken cron expression is refused at import time', () => {
  const { store } = freshStore();
  assert.throws(() => store.migrateLegacy([{
    legacy_job_id: 'cron-3',
    profile_id: 'x',
    name: 'cold-search:1',
    schedule: 'every hour',
  }]), /5 полей/);
});
