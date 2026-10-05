'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

function createRegenerationQueue({ root, processCandidate, concurrency = 3, now = () => Date.now() }) {
  const jobs = new Map();
  let active = 0;
  let pumping = false;

  function dirFor(username) { return path.join(root, 'hh', username, 'regeneration-jobs'); }
  function fileFor(username, id) { return path.join(dirFor(username), `${id}.json`); }

  function save(job) {
    job.revision = (job.revision || 0) + 1;
    job.updated_at = now();
    const file = fileFor(job.username, job.id);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(job), { mode: 0o600 });
    fs.renameSync(temp, file);
  }

  function read(username, id) {
    if (!SAFE_ID.test(username || '') || !/^[0-9a-f-]{36}$/i.test(id || '')) return null;
    try {
      const job = JSON.parse(fs.readFileSync(fileFor(username, id), 'utf8'));
      if (job.username !== username || job.id !== id) return null;
      return job;
    } catch { return null; }
  }

  function recover(job) {
    if (!job || !['queued', 'running'].includes(job.status)) return job;
    for (const item of job.items) {
      if (item.status === 'running') { item.status = 'queued'; item.error = null; item.updated_seq = job.revision + 1; }
    }
    job.status = 'queued';
    job.finished_at = null;
    jobs.set(job.id, job);
    save(job);
    pump();
    return job;
  }

  function findDuplicate(username, vacancyId, requestKey) {
    for (const job of jobs.values()) {
      if (job.username === username && job.vacancy_id === vacancyId && job.request_key === requestKey) return job;
      if (job.username === username && job.vacancy_id === vacancyId && ['queued', 'running'].includes(job.status)) return job;
    }
    try {
      for (const name of fs.readdirSync(dirFor(username))) {
        if (!name.endsWith('.json')) continue;
        const job = read(username, name.slice(0, -5));
        if (!job || job.vacancy_id !== vacancyId) continue;
        if (!['queued', 'running'].includes(job.status) && now() - Number(job.updated_at || job.created_at || 0) > 14 * 86400_000) {
          try { fs.unlinkSync(fileFor(username, job.id)); } catch { /* already pruned */ }
          jobs.delete(job.id);
          continue;
        }
        if (job.request_key === requestKey || ['queued', 'running'].includes(job.status)) return job;
      }
    } catch { /* no jobs yet */ }
    return null;
  }

  function enqueue({ username, vacancyId, negotiationIds, requestKey }) {
    const duplicate = findDuplicate(username, vacancyId, requestKey);
    if (duplicate) {
      if (duplicate.request_key !== requestKey && ['queued', 'running'].includes(duplicate.status)) return { job: duplicate, existing: true, conflict: true };
      const activeJob = jobs.get(duplicate.id) || recover(duplicate);
      return { job: activeJob, existing: true, conflict: false };
    }
    const job = {
      id: randomUUID(), request_key: requestKey, username, vacancy_id: vacancyId,
      status: 'queued', created_at: now(), updated_at: now(), revision: 0,
      concurrency, total: negotiationIds.length, items: negotiationIds.map(id => ({
        negotiation_id: id, status: 'queued', attempts: 0, updated_seq: 1,
      })),
    };
    jobs.set(job.id, job);
    save(job);
    pump();
    return { job, existing: false, conflict: false };
  }

  function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (active < concurrency) {
        const job = [...jobs.values()].find(j => ['queued', 'running'].includes(j.status) && j.items.some(i => i.status === 'queued'));
        if (!job) break;
        const item = job.items.find(i => i.status === 'queued');
        item.status = 'running'; item.started_at = now(); item.attempts += 1; item.error = null;
        item.updated_seq = job.revision + 1;
        job.status = 'running'; job.started_at ||= now();
        save(job); active += 1;
        Promise.resolve().then(() => processCandidate(job, item)).then(result => {
          item.status = 'succeeded'; item.finished_at = now(); item.duration_ms = item.finished_at - item.started_at;
          item.message = String(result?.message || ''); item.funnel_action = result?.funnel_action || null;
          item.error = null;
        }).catch(error => {
          item.status = 'failed'; item.finished_at = now(); item.duration_ms = item.finished_at - item.started_at;
          item.error = String(error?.message || error).slice(0, 500); delete item.message;
        }).finally(() => {
          item.updated_seq = job.revision + 1;
          const pending = job.items.some(i => i.status === 'queued' || i.status === 'running');
          if (!pending) {
            job.status = job.items.some(i => i.status === 'failed') ? 'completed_with_errors' : 'completed';
            job.finished_at = now();
          }
          save(job); active -= 1; pump();
        });
      }
      for (const job of jobs.values()) {
        if (['queued', 'running'].includes(job.status) && !job.items.some(i => ['queued', 'running'].includes(i.status))) {
          job.status = job.items.some(i => i.status === 'failed') ? 'completed_with_errors' : 'completed';
          job.finished_at = now(); save(job);
        }
      }
    } finally { pumping = false; }
  }

  function get(username, id, after = 0) {
    let job = jobs.get(id) || read(username, id);
    if (!job || job.username !== username) return null;
    if (!jobs.has(id) && ['queued', 'running'].includes(job.status)) job = recover(job);
    const cursor = Math.max(0, Number(after) || 0);
    const changes = job.items.filter(item => item.updated_seq > cursor).map(item => ({
      negotiation_id: item.negotiation_id, status: item.status, error: item.error || null,
      message: item.status === 'succeeded' ? item.message : undefined,
      funnel_action: item.funnel_action || null,
    }));
    const counts = { queued: 0, running: 0, succeeded: 0, failed: 0 };
    for (const item of job.items) counts[item.status] = (counts[item.status] || 0) + 1;
    const durations = job.items.filter(item => item.duration_ms > 0).map(item => item.duration_ms);
    return { id: job.id, vacancy_id: job.vacancy_id, status: job.status, revision: job.revision,
      total: job.total, concurrency: job.concurrency, counts, changes,
      average_duration_ms: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      created_at: job.created_at, finished_at: job.finished_at || null };
  }

  function retryFailed(username, id) {
    const job = jobs.get(id) || read(username, id);
    if (!job || job.username !== username || job.status !== 'completed_with_errors') return null;
    for (const item of job.items) if (item.status === 'failed') {
      item.status = 'queued'; item.error = null; item.updated_seq = job.revision + 1;
    }
    job.status = 'queued'; job.finished_at = null;
    jobs.set(job.id, job); save(job); pump();
    return job;
  }

  function recoverAll() {
    let usernames = [];
    try { usernames = fs.readdirSync(path.join(root, 'hh'), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return; }
    for (const username of usernames) {
      if (!SAFE_ID.test(username)) continue;
      try {
        for (const name of fs.readdirSync(dirFor(username))) {
          if (!name.endsWith('.json')) continue;
          const job = read(username, name.slice(0, -5));
          if (!job) continue;
          if (!['queued', 'running'].includes(job.status) && now() - Number(job.updated_at || job.created_at || 0) > 14 * 86400_000) {
            try { fs.unlinkSync(fileFor(username, job.id)); } catch { /* already pruned */ }
            continue;
          }
          if (['queued', 'running'].includes(job.status)) recover(job);
        }
      } catch { /* no jobs */ }
    }
  }

  return { enqueue, get, retryFailed, recoverAll };
}

module.exports = { createRegenerationQueue };
