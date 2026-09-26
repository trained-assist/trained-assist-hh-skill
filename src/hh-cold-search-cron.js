'use strict';
// Cold search on core's generic cron (agent#1489 S7.1, agent#1514).
//
// hh_proactive_schedule is a thin wrapper: one core cron job per vacancy running
// the hh_proactive_search action. The skill never reads cron tables — it talks to
// core's provider jobs API (POST /internal/cron/jobs) and core owns claim/lease/
// catch-up/history. Delivery is silent by the skill's schedule declaration:
// cold-search Telegram notifications were retired, results live on the page.

const ACTION = 'hh_proactive_search';
const TIMEZONE = 'Europe/Moscow';
const jobName = vacancyId => `cold-search:${vacancyId}`;

// Stable per-vacancy offset so many vacancies of one profile do not all start
// in the same minute.
function offset(vacancyId, mod) {
  let h = 0;
  for (const c of String(vacancyId)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % mod;
}

// interval_hours → five-field cron. Sub-hour intervals round to a divisor of 60
// minutes (minimum 30, the action's minIntervalMinutes); hourly intervals to a
// divisor of 24; multi-day intervals to a day step. The returned `hours` is the
// effective interval actually scheduled, reported back to the user.
function intervalToCron(intervalHours, vacancyId = '') {
  const h = Number(intervalHours) > 0 ? Number(intervalHours) : 24;
  const m = offset(vacancyId, 30);
  if (h < 1) return { cron: `${m},${m + 30} * * * *`, hours: 0.5 };
  if (h < 24) {
    const step = [1, 2, 3, 4, 6, 8, 12].reduce((best, s) => Math.abs(s - h) < Math.abs(best - h) ? s : best, 1);
    const minute = offset(vacancyId, 60);
    return { cron: step === 1 ? `${minute} * * * *` : `${minute} ${offset(vacancyId + ':h', step)}-23/${step} * * *`, hours: step };
  }
  const days = Math.max(1, Math.round(h / 24));
  const minute = offset(vacancyId, 60);
  const hour = 7 + offset(vacancyId + ':h', 12); // 07:00–18:59 Moscow
  return { cron: days === 1 ? `${minute} ${hour} * * *` : `${minute} ${hour} */${days} * *`, hours: days * 24 };
}

function coreBase(env = process.env) {
  if (env.AGENT_INTERNAL_URL) return env.AGENT_INTERNAL_URL.replace(/\/$/, '');
  if (env.PORT) return `http://127.0.0.1:${env.PORT}`;
  return (env.AGENT_PUBLIC_URL || '').replace(/\/$/, '');
}

async function callCore(body, { env = process.env, fetchImpl = fetch } = {}) {
  const base = coreBase(env);
  if (!base || !env.AGENT_SECRET) throw new Error('Планировщик агента недоступен из этого окружения (нет адреса ядра или секрета)');
  const res = await fetchImpl(`${base}/internal/cron/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.AGENT_SECRET}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  let out = {};
  try { out = await res.json(); } catch { /* non-JSON answer */ }
  if (!res.ok || out.ok === false) throw new Error(out.error || `Планировщик агента ответил ${res.status}`);
  return out;
}

async function enableColdSearch(profileId, vacancyId, intervalHours, opts) {
  const { cron, hours } = intervalToCron(intervalHours, vacancyId);
  const out = await callCore({ op: 'upsert', profileId, action: ACTION, name: jobName(vacancyId),
    schedule: cron, timezone: TIMEZONE, arguments: { vacancy_id: String(vacancyId) }, enabled: true }, opts);
  return { job: out.job, hours, role: out.scheduler_role };
}

async function disableColdSearch(profileId, vacancyId, opts) {
  if (vacancyId) {
    const out = await callCore({ op: 'delete', profileId, action: ACTION, name: jobName(vacancyId) }, opts);
    return { deleted: out.deleted };
  }
  const { jobs } = await listColdSearch(profileId, opts);
  let deleted = 0;
  for (const j of jobs) deleted += (await callCore({ op: 'delete', profileId, action: ACTION, name: j.name }, opts)).deleted;
  return { deleted };
}

async function listColdSearch(profileId, opts) {
  const out = await callCore({ op: 'list', profileId, action: ACTION }, opts);
  const jobs = (out.jobs || []).filter(j => j.name.startsWith('cold-search:'));
  return { jobs, role: out.scheduler_role };
}

module.exports = { ACTION, TIMEZONE, jobName, intervalToCron, coreBase, callCore, enableColdSearch, disableColdSearch, listColdSearch };
