'use strict';

// Durable schedule store of the standalone HH worker (#187).
//
// One file, one writer, one truth: the jobs (what runs, for which profile and
// vacancy, with which cron expression) and the occurrences (which minutes were
// due, which ran, which were skipped). The old scheduler lived inside the
// retiring agent and is gone with it, so this store has to carry the properties
// that scheduler had:
//
//   durable unique (job, scheduled_at) — a minute is either due once or not at all;
//   lease / no-overlap — two ticks never run the same job at the same time;
//   coalesced missed runs — a worker that was down for hours runs the job once,
//     not once per missed slot.
//
// The file is written atomically (temp file + rename) with mode 0600: it holds
// profile and vacancy identifiers, which must not be world-readable.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataRoot } = require('./data-paths');
const cron = require('./hh-worker-cron');

const STATE_VERSION = 1;
const DEFAULT_LEASE_MS = 15 * 60 * 1000;
const LOCK_STALE_MS = 5 * 60 * 1000;

function stateDir(env = process.env) {
  if (env.HH_WORKER_STATE_DIR) return env.HH_WORKER_STATE_DIR;
  return path.join(dataRoot(env), 'hh-worker');
}

function jobId(profileId, name) {
  return `${profileId}:${name}`;
}

function occurrenceKey(id, scheduledAt) {
  return `${id}|${scheduledAt}`;
}

function emptyState() {
  return {
    version: STATE_VERSION,
    updated_at: null,
    cursor: null,
    jobs: {},
    occurrences: {},
  };
}

class ScheduleStore {
  constructor({ env = process.env, stateFile = null, now = () => new Date(), owner = null, leaseMs = DEFAULT_LEASE_MS } = {}) {
    this.env = env;
    this.stateFile = stateFile || path.join(stateDir(env), 'schedule.json');
    this.now = now;
    this.leaseMs = leaseMs;
    this.owner = owner || `${process.pid}@${crypto.randomBytes(4).toString('hex')}`;
  }

  read() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (!raw || raw.version !== STATE_VERSION) return emptyState();
      raw.jobs = raw.jobs || {};
      raw.occurrences = raw.occurrences || {};
      return raw;
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw error;
    }
  }

  write(state) {
    state.updated_at = new Date(this.now()).toISOString();
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.stateFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.stateFile);
    return state;
  }

  // Cross-process lock: the HTTP service and the minute tick are separate
  // processes and both touch this file.
  withLock(fn, { timeoutMs = 10_000 } = {}) {
    const lockPath = `${this.stateFile}.lock`;
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + timeoutMs;
    let fd = null;
    for (;;) {
      try {
        fd = fs.openSync(lockPath, 'wx', 0o600);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const age = Date.now() - fs.statSync(lockPath).mtimeMs;
          if (age > LOCK_STALE_MS) { fs.unlinkSync(lockPath); continue; }
        } catch { /* the lock vanished between stat and unlink — retry */ }
        if (Date.now() > deadline) throw new Error('Планировщик HH занят (lock timeout)');
        // Synchronous sleep: the lock is held for milliseconds only.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
    try {
      fs.writeSync(fd, `${this.owner}\n`);
      return fn();
    } finally {
      try { fs.closeSync(fd); } catch { /* already closed */ }
      try { fs.unlinkSync(lockPath); } catch { /* already removed */ }
    }
  }

  // ── jobs ────────────────────────────────────────────────────────────────────

  jobView(job, state) {
    const nextRunAt = job.enabled
      ? cron.nextRun(job.schedule, this.now().getTime(), job.timezone || 'Europe/Moscow')
      : null;
    return {
      id: job.id,
      name: job.name,
      profile_id: job.profile_id,
      action: job.action,
      schedule: job.schedule,
      timezone: job.timezone || 'Europe/Moscow',
      arguments: job.arguments || {},
      enabled: !!job.enabled,
      created_at: job.created_at,
      updated_at: job.updated_at,
      last_run_at: job.last_run_at || null,
      last_status: job.last_status || null,
      next_run_at: nextRunAt,
      legacy: job.legacy || null,
    };
  }

  upsert(spec, { state = null } = {}) {
    const s = state || this.read();
    const profileId = String(spec.profileId || spec.profile_id || '');
    const name = String(spec.name || '');
    if (!profileId) throw new Error('profileId обязателен');
    if (!name) throw new Error('name обязателен');
    if (spec.schedule) cron.parseCron(spec.schedule); // fail fast on a bad expression
    const id = jobId(profileId, name);
    const nowIso = new Date(this.now()).toISOString();
    const existing = s.jobs[id] || {};
    s.jobs[id] = {
      id,
      name,
      profile_id: profileId,
      action: spec.action || existing.action || 'hh_proactive_search',
      schedule: spec.schedule || existing.schedule,
      timezone: spec.timezone || existing.timezone || 'Europe/Moscow',
      arguments: spec.arguments || existing.arguments || {},
      enabled: spec.enabled == null ? (existing.enabled !== false) : !!spec.enabled,
      created_at: existing.created_at || nowIso,
      updated_at: nowIso,
      last_run_at: existing.last_run_at || null,
      last_status: existing.last_status || null,
      legacy: existing.legacy || null,
    };
    if (state == null) this.write(s);
    return this.jobView(s.jobs[id], s);
  }

  remove(spec, { state = null } = {}) {
    const s = state || this.read();
    const profileId = String(spec.profileId || spec.profile_id || '');
    const name = String(spec.name || '');
    const id = jobId(profileId, name);
    if (!s.jobs[id]) return { deleted: 0 };
    delete s.jobs[id];
    for (const [key, occurrence] of Object.entries(s.occurrences)) {
      if (occurrence.job_id === id && occurrence.status === 'pending') delete s.occurrences[key];
    }
    if (state == null) this.write(s);
    return { deleted: 1 };
  }

  list(spec = {}, { state = null } = {}) {
    const s = state || this.read();
    const profileId = String(spec.profileId || spec.profile_id || '');
    const action = String(spec.action || '');
    const jobs = Object.values(s.jobs)
      .filter(job => (!profileId || job.profile_id === profileId) && (!action || job.action === action))
      .map(job => this.jobView(job, s))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { jobs, scheduler_role: 'primary' };
  }

  // ── occurrences ─────────────────────────────────────────────────────────────

  // Creates the due occurrences for every enabled job since the stored cursor.
  // Missed minutes of one job collapse into a single pending occurrence: the
  // older ones are recorded as coalesced, so the ledger still shows what was
  // missed without replaying a backlog.
  generate({ nowMs = null } = {}) {
    return this.withLock(() => {
      const s = this.read();
      const now = nowMs == null ? this.now().getTime() : nowMs;
      const cursor = s.cursor ? Date.parse(s.cursor) : null;
      // A store without a cursor is a fresh one: look back two minutes, not
      // further. A worker that was down keeps its cursor in the state file, so
      // the gap it missed is coalesced — but a lost state file must not turn
      // into a backlog of every minute since the beginning of time.
      const from = cursor == null ? now - 120_000 : cursor;
      const created = [];
      const coalesced = [];
      if (from < now) {
        const byJob = new Map();
        for (const job of Object.values(s.jobs)) {
          if (!job.enabled || !job.schedule) continue;
          let minutes = [];
          try {
            minutes = cron.dueMinutes(job.schedule, from, now, job.timezone || 'Europe/Moscow');
          } catch (error) {
            console.error(`[hh-worker] расписание ${job.name} пропущено: ${error.message}`);
            continue;
          }
          if (!minutes.length) continue;
          byJob.set(job.id, minutes);
        }
        for (const [id, minutes] of byJob) {
          const keep = minutes[minutes.length - 1];
          for (const scheduledAt of minutes) {
            const key = occurrenceKey(id, scheduledAt);
            if (s.occurrences[key]) continue;
            const isKeep = scheduledAt === keep;
            s.occurrences[key] = {
              key,
              job_id: id,
              scheduled_at: scheduledAt,
              status: isKeep ? 'pending' : 'coalesced',
              attempts: 0,
              lease_owner: null,
              lease_until: null,
              started_at: null,
              finished_at: null,
              error: null,
              coalesced_into: isKeep ? null : occurrenceKey(id, keep),
              created_at: new Date(now).toISOString(),
            };
            (isKeep ? created : coalesced).push(key);
          }
        }
        s.cursor = new Date(now).toISOString();
      }
      this.write(s);
      return { created, coalesced };
    });
  }

  // Claims the due occurrences. A job with a live lease is not claimed again —
  // that is the no-overlap rule. An occurrence whose lease expired (a killed
  // worker) becomes claimable again.
  claim({ nowMs = null, limit = 20 } = {}) {
    return this.withLock(() => {
      const s = this.read();
      const now = nowMs == null ? this.now().getTime() : nowMs;
      const busyJobs = new Set();
      for (const occurrence of Object.values(s.occurrences)) {
        if (occurrence.status !== 'running') continue;
        if (occurrence.lease_until && Date.parse(occurrence.lease_until) > now) busyJobs.add(occurrence.job_id);
      }
      const claimed = [];
      // A pending occurrence is claimable; so is a running one whose lease
      // expired — that is the worker that was killed mid-run.
      const pending = Object.values(s.occurrences)
        .filter(o => o.status === 'pending'
          || (o.status === 'running' && (!o.lease_until || Date.parse(o.lease_until) <= now)))
        .sort((a, b) => (a.scheduled_at < b.scheduled_at ? -1 : 1));
      for (const occurrence of pending) {
        if (claimed.length >= limit) break;
        if (busyJobs.has(occurrence.job_id)) continue;
        occurrence.status = 'running';
        occurrence.attempts = (occurrence.attempts || 0) + 1;
        occurrence.lease_owner = this.owner;
        occurrence.lease_until = new Date(now + this.leaseMs).toISOString();
        occurrence.started_at = new Date(now).toISOString();
        busyJobs.add(occurrence.job_id);
        claimed.push(occurrence);
      }
      if (claimed.length) this.write(s);
      return claimed;
    });
  }

  complete(key, { ok = true, error = null, result = null } = {}) {
    return this.withLock(() => {
      const s = this.read();
      const occurrence = s.occurrences[key];
      if (!occurrence) return null;
      const nowIso = new Date(this.now()).toISOString();
      occurrence.status = ok ? 'succeeded' : 'failed';
      occurrence.finished_at = nowIso;
      occurrence.lease_owner = null;
      occurrence.lease_until = null;
      occurrence.error = error ? String(error).slice(0, 500) : null;
      if (result != null) occurrence.result = result;
      const job = s.jobs[occurrence.job_id];
      if (job) {
        job.last_run_at = occurrence.scheduled_at;
        job.last_status = occurrence.status;
        job.updated_at = nowIso;
      }
      this.write(s);
      return occurrence;
    });
  }

  release(key, { error = null } = {}) {
    return this.withLock(() => {
      const s = this.read();
      const occurrence = s.occurrences[key];
      if (!occurrence) return null;
      occurrence.status = 'pending';
      occurrence.lease_owner = null;
      occurrence.lease_until = null;
      occurrence.error = error ? String(error).slice(0, 500) : null;
      this.write(s);
      return occurrence;
    });
  }

  stats() {
    const s = this.read();
    const counts = {};
    for (const occurrence of Object.values(s.occurrences)) {
      counts[occurrence.status] = (counts[occurrence.status] || 0) + 1;
    }
    return {
      jobs: Object.keys(s.jobs).length,
      enabled: Object.values(s.jobs).filter(job => job.enabled).length,
      occurrences: counts,
      cursor: s.cursor,
      updated_at: s.updated_at,
    };
  }

  // Import of the legacy schedule set (#187 step 4): every old job keeps its id,
  // its original cron expression and its timezone, and the mapping is recorded
  // next to the store. Jobs arrive disabled — the legacy runs were paused and
  // must not be replayed blindly; activation is an explicit owner decision.
  migrateLegacy(entries, { source = 'legacy' } = {}) {
    return this.withLock(() => {
      const s = this.read();
      const mapping = [];
      const nowIso = new Date(this.now()).toISOString();
      for (const entry of entries) {
        const profileId = String(entry.profile_id || entry.profileId || '');
        const name = String(entry.name || '');
        if (!profileId || !name) throw new Error('Расписание без профиля или имени');
        if (entry.schedule) cron.parseCron(entry.schedule);
        const id = jobId(profileId, name);
        const existing = s.jobs[id];
        s.jobs[id] = {
          id,
          name,
          profile_id: profileId,
          action: entry.action || 'hh_proactive_search',
          schedule: entry.schedule,
          timezone: entry.timezone || 'Europe/Moscow',
          arguments: entry.arguments || {},
          enabled: existing ? existing.enabled : false,
          created_at: existing ? existing.created_at : nowIso,
          updated_at: nowIso,
          last_run_at: existing ? existing.last_run_at : null,
          last_status: existing ? existing.last_status : null,
          legacy: {
            source,
            legacy_job_id: entry.legacy_job_id || null,
            legacy_last_status: entry.last_status || null,
            // A run whose outcome is unknown may still have been in flight when
            // the old host went away: replaying it could apply the same work
            // twice. Those jobs are quarantined until the owner decides.
            decision: entry.decision
              || (String(entry.last_status || '') === 'unknown' ? 'quarantined_pending_owner' : 'migrated_disabled'),
            imported_at: nowIso,
          },
        };
        mapping.push({
          legacy_job_id: entry.legacy_job_id || null,
          job_id: id,
          profile_id: profileId,
          name,
          schedule: entry.schedule,
          timezone: s.jobs[id].timezone,
          enabled: s.jobs[id].enabled,
          legacy_last_status: entry.last_status || null,
          decision: s.jobs[id].legacy.decision,
        });
      }
      this.write(s);
      return mapping;
    });
  }
}

function createScheduleStore(options = {}) {
  return new ScheduleStore(options);
}

module.exports = { ScheduleStore, createScheduleStore, stateDir, jobId, occurrenceKey, emptyState, STATE_VERSION };
