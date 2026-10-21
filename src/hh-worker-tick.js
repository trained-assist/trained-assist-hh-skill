'use strict';

// One scheduler tick of the standalone HH worker (#187).
//
// The tick is the minute timer of the worker: it materializes the due
// occurrences, claims them under a lease and runs the cold search of the
// skill for each of them. It is a separate process from the HTTP worker so a
// long search can never block a recruiter's page request, and so the timer can
// be run by hand (`node src/hh-worker-tick.js`) without touching the service.

const path = require('path');
const { createScheduleStore } = require('./hh-worker-schedule-store');
const { usersRoot } = require('./data-paths');

async function runSearch(job, occurrence, { env = process.env } = {}) {
  const { runProactiveSearch, scoreUnscoredProactiveCandidates } = require('./hh-proactive-search');
  const { refreshHhToken } = require('./hh-utils');
  const profile = job.profile_id;
  const workDir = path.join(usersRoot(), profile);
  const vacancyId = (job.arguments && job.arguments.vacancy_id) || null;
  const started = Date.now();
  const report = await runProactiveSearch(profile, workDir, {
    vacancyId,
    refreshAccessToken: (username) => refreshHhToken(username),
  });
  // The legacy background writer re-scored the accumulated feed every five
  // minutes. It ran on the retiring host and stopped with it, so the tick keeps
  // that backlog moving for the vacancy it just searched.
  let scored = null;
  try {
    scored = await scoreUnscoredProactiveCandidates(profile, { vacancyId });
  } catch (error) {
    scored = { error: error.message };
  }
  return {
    duration_ms: Date.now() - started,
    found: report && report.found != null ? report.found : (report && report.total != null ? report.total : null),
    new_count: report && report.new_count != null ? report.new_count : (report && report.newCount != null ? report.newCount : null),
    scored,
  };
}

async function runTick({ env = process.env, store = null, now = () => new Date() } = {}) {
  const scheduleStore = store || createScheduleStore({ env, now });
  const generated = scheduleStore.generate();
  const claimed = scheduleStore.claim();
  const results = [];
  for (const occurrence of claimed) {
    const job = scheduleStore.read().jobs[occurrence.job_id];
    if (!job) {
      scheduleStore.complete(occurrence.key, { ok: false, error: 'job removed' });
      results.push({ key: occurrence.key, ok: false, error: 'job removed' });
      continue;
    }
    try {
      const result = await runSearch(job, occurrence, { env });
      scheduleStore.complete(occurrence.key, { ok: true, result });
      results.push({ key: occurrence.key, job_id: occurrence.job_id, scheduled_at: occurrence.scheduled_at, ok: true, result });
    } catch (error) {
      scheduleStore.complete(occurrence.key, { ok: false, error: error.message });
      results.push({ key: occurrence.key, job_id: occurrence.job_id, scheduled_at: occurrence.scheduled_at, ok: false, error: error.message });
    }
  }
  return { generated, claimed: claimed.length, results, stats: scheduleStore.stats() };
}

module.exports = { runTick, runSearch };

if (require.main === module) {
  runTick()
    .then(summary => {
      console.log(JSON.stringify(summary));
      process.exitCode = summary.results.some(r => !r.ok) ? 1 : 0;
    })
    .catch(error => {
      console.error('[hh-worker] tick failed:', error.message);
      process.exitCode = 2;
    });
}
