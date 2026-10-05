'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { dataRoot } = require('./data-paths.js');

function jobFile(username, vacancyId) {
  return path.join(dataRoot(), 'hh', String(username), 'proactive', `search-job-${String(vacancyId)}.json`);
}

function save(job) {
  const file = jobFile(job.username, job.vacancy_id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(job, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
  return job;
}

function read(username, vacancyId) {
  try {
    const job = JSON.parse(fs.readFileSync(jobFile(username, vacancyId), 'utf8'));
    if (job.state === 'queued' || job.state === 'running') {
      const age = Date.now() - Date.parse(job.updated_at || job.started_at || 0);
      if (!Number.isFinite(age) || age > 5 * 60_000) {
        Object.assign(job, { state: 'failed', phase: 'failed', message: 'Процесс поиска прервался. Запустите поиск ещё раз.', error: 'JOB_STALE', finished_at: new Date().toISOString() });
        save(job);
      }
    }
    return job;
  } catch { return null; }
}

function publicJob(job) {
  if (!job) return null;
  const { id, state, phase, message, progress, completed, total, failures, started_at, updated_at, finished_at, error, result } = job;
  return { id, state, phase, message, progress, completed, total, failures, started_at, updated_at, finished_at, error, result };
}

function active(username, vacancyId) {
  const job = read(username, vacancyId);
  return job && ['queued', 'running'].includes(job.state) ? publicJob(job) : null;
}

function start({ username, vacancyId, runSearch }) {
  const existing = read(username, vacancyId);
  if (existing && ['queued', 'running'].includes(existing.state)) return { ok: true, existing: true, job: publicJob(existing) };

  const now = new Date().toISOString();
  const job = {
    id: randomUUID(), username: String(username), vacancy_id: String(vacancyId),
    state: 'queued', phase: 'queued', message: 'Поиск в очереди…', progress: 0,
    completed: 0, total: null, failures: 0, started_at: now, updated_at: now,
    finished_at: null, error: null, result: null,
  };
  save(job);

  const update = fields => {
    Object.assign(job, fields, { updated_at: new Date().toISOString() });
    save(job);
  };
  // A single ATS batch can wait on several slow model requests. Keep the durable
  // heartbeat fresh during that wait so a browser poll never mistakes live work
  // for a crashed worker.
  const heartbeat = setInterval(() => {
    if (job.state === 'queued' || job.state === 'running') update({});
  }, 30_000);
  heartbeat.unref?.();
  Promise.resolve().then(async () => {
    update({ state: 'running', phase: 'preparing', message: 'Подготавливаю поиск…' });
    const result = await runSearch(progress => update(progress));
    const state = result.ai_pending_count > 0 ? 'partial' : 'done';
    clearInterval(heartbeat);
    update({
      state, phase: state, progress: 100,
      message: state === 'done' ? 'Поиск и оценка завершены.' : `Поиск завершён; ${result.ai_pending_count} AI-оценок не получены.`,
      finished_at: new Date().toISOString(), error: null,
      result: { total_found: result.total_found, count: result.count, ai_pending_count: result.ai_pending_count },
    });
  }).catch(error => {
    clearInterval(heartbeat);
    update({ state: 'failed', phase: 'failed', message: String(error?.message || error).slice(0, 300), error: 'SEARCH_FAILED', finished_at: new Date().toISOString() });
  });

  return { ok: true, existing: false, job: publicJob(job) };
}

module.exports = { jobFile, save, read, publicJob, active, start };
