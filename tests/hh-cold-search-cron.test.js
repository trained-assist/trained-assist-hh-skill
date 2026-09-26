// Cold search on core's generic cron (agent#1489 S7.1). Replaces the removed
// runDueSearches loop tests: timing/no-overlap/disable-during-run are now the
// core engine's (trained-assist-agent tests/unit/cron-service.test.js); here we
// pin the wrapper contract against a fake core jobs API + the migration.
import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const api = require('../src/hh-proactive-search');
const cron = require('../src/hh-cold-search-cron');
const user = 'fixture-cron';
const keys = ['AGENT_DATA_DIR', 'USERS_DIR', 'USER_ID', 'AGENT_SECRET', 'AGENT_INTERNAL_URL'];
let root, work, old, jobs, calls, role;

// Minimal in-memory model of core POST /internal/cron/jobs (cron-jobs-api.js).
function fakeCore() {
  return vi.fn(async (url, init) => {
    expect(url).toBe('http://core.test/internal/cron/jobs');
    expect(init.headers.Authorization).toBe('Bearer s3cret');
    const b = JSON.parse(init.body); calls.push(b);
    const mine = j => j.profileId === b.profileId && j.action === b.action;
    let body;
    if (b.op === 'upsert') {
      if (!b.arguments?.vacancy_id) return { ok: false, status: 400, json: async () => ({ ok: false, error: 'settings' }) };
      let j = jobs.find(x => mine(x) && x.name === b.name);
      if (!j) { j = { id: 'cron-' + (jobs.length + 1), profileId: b.profileId, action: b.action, name: b.name }; jobs.push(j); }
      Object.assign(j, { schedule: b.schedule, timezone: b.timezone, arguments: b.arguments, enabled: b.enabled,
        next_run_at: '2026-09-27T05:23:00.000Z', last_run_at: null, last_status: null });
      body = { ok: true, job: j };
    } else if (b.op === 'list') {
      body = { ok: true, jobs: jobs.filter(j => j.profileId === b.profileId && (!b.action || j.action === b.action)) };
    } else {
      const before = jobs.length; jobs = jobs.filter(j => !(mine(j) && j.name === b.name));
      body = { ok: true, deleted: before - jobs.length };
    }
    return { ok: true, status: 200, json: async () => ({ scheduler_role: role, ...body }) };
  });
}
function context(key, value) { const d = path.join(work, 'contexts/hh'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, key + '.json'), JSON.stringify({ value })); }

beforeEach(() => {
  old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-cron-'));
  Object.assign(process.env, { AGENT_DATA_DIR: path.join(root, 'data'), USERS_DIR: path.join(root, 'users'), USER_ID: user,
    AGENT_SECRET: 's3cret', AGENT_INTERNAL_URL: 'http://core.test' });
  work = path.join(root, 'users', user); fs.mkdirSync(work, { recursive: true });
  jobs = []; calls = []; role = 'primary';
  vi.stubGlobal('fetch', fakeCore());
});
afterEach(() => { vi.unstubAllGlobals(); for (const k of keys) old[k] === undefined ? delete process.env[k] : process.env[k] = old[k]; fs.rmSync(root, { recursive: true, force: true }); });

it('maps interval_hours to a cron no tighter than the action minimum (30 min)', () => {
  expect(cron.intervalToCron(0.1, 'A').hours).toBe(0.5);
  expect(cron.intervalToCron(0.5, 'A').cron).toMatch(/^\d+,\d+ \* \* \* \*$/);
  expect(cron.intervalToCron(6, 'A')).toMatchObject({ hours: 6 });
  expect(cron.intervalToCron(24, 'A').cron).toMatch(/^\d+ \d+ \* \* \*$/);
  expect(cron.intervalToCron(48, 'A').cron).toMatch(/\*\/2 \* \*$/);
  expect(cron.intervalToCron(24, 'A')).toEqual(cron.intervalToCron(24, 'A')); // stable per vacancy
});

it('MCP wrapper: enable/status/disable manage one core job per vacancy, never schedule.json', async () => {
  const tool = require('../src/mcp-skills/tools/92-hh-proactive').tools.hh_proactive_schedule.handler;
  expect(await tool({ action: 'enable' })).toHaveProperty('error'); // no selected vacancy
  expect(await tool({ action: 'enable', vacancy_id: 'A', interval_hours: 24 })).toMatchObject({ ok: true, enabled: true, interval_hours: 24 });
  await tool({ action: 'enable', vacancy_id: 'A', interval_hours: 24 });
  await tool({ action: 'enable', vacancy_id: 'B' });
  expect(jobs.map(j => [j.name, j.arguments.vacancy_id])).toEqual([['cold-search:A', 'A'], ['cold-search:B', 'B']]);
  expect(jobs.every(j => j.action === 'hh_proactive_search' && j.timezone === 'Europe/Moscow')).toBe(true);
  expect(api.loadSchedule(user)).toBeNull(); // legacy runner can never see it
  expect(await tool({ action: 'status' })).toMatchObject({ enabled: true, enabled_vacancy_ids: ['A', 'B'] });
  expect(await tool({ action: 'status', vacancy_id: 'A' })).toMatchObject({ enabled: true, next_run: '2026-09-27T05:23:00.000Z' });
  expect(await tool({ action: 'disable', vacancy_id: 'A' })).toMatchObject({ scope: 'vacancy', enabled: false });
  expect(jobs.map(j => j.name)).toEqual(['cold-search:B']);
  expect(await tool({ action: 'disable' })).toMatchObject({ ok: true, enabled: false, scope: 'profile' });
  expect(jobs).toEqual([]);
  expect(await tool({ action: 'status' })).toMatchObject({ enabled: false, enabled_vacancy_ids: [] });
});

it('reports honestly when this host does not tick, and when core is unreachable', async () => {
  const tool = require('../src/mcp-skills/tools/92-hh-proactive').tools.hh_proactive_schedule.handler;
  role = 'off';
  expect((await tool({ action: 'enable', vacancy_id: 'A' })).message).toMatch(/планировщик не активен/);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
  expect((await tool({ action: 'enable', vacancy_id: 'A' })).error).toMatch(/планировщику агента.*ECONNREFUSED/);
  delete process.env.AGENT_SECRET;
  expect((await tool({ action: 'status' })).error).toMatch(/планировщику/);
});

it('notifications_on/off stay retired and never touch the schedule', async () => {
  const tool = require('../src/mcp-skills/tools/92-hh-proactive').tools.hh_proactive_schedule.handler;
  expect(await tool({ action: 'notifications_on' })).toMatchObject({ retired: true, notifications_enabled: false });
  expect(calls).toEqual([]);
});

it('migration: dry-run plans only enabled tracked vacancies; apply is job-first then legacy off; rollback restores', async () => {
  const m = require('../scripts/migrate-cold-search-to-cron.cjs');
  context('active_vacancies', [{ id: 'A' }, { id: 'B' }]);
  api.saveSchedule(user, { enabled: true, vacancies: { A: { enabled: true, interval_hours: 24 }, B: { enabled: true, interval_hours: 0.5 },
    C: { enabled: true }, D: { enabled: false } } });
  const items = m.plan();
  expect(items.map(i => [i.vacancy_id, i.tracked])).toEqual([['A', true], ['B', true], ['C', false]]);
  expect(calls).toEqual([]); // dry-run is read-only
  const res = await m.apply(items);
  expect(res.map(r => r.skipped ? 'skip' : r.error ? 'err' : r.job_id)).toEqual(['cron-1', 'cron-2', 'skip']);
  const saved = api.loadSchedule(user);
  expect(saved.vacancies.A).toMatchObject({ enabled: false, migrated_to_cron: 'cron-1', interval_hours: 24 });
  expect(saved.vacancies.C.enabled).toBe(true); // untracked: untouched, legacy never ran it either
  expect(m.plan().map(i => i.vacancy_id)).toEqual(['C']); // idempotent re-run
  expect(JSON.parse(fs.readFileSync(m.ledgerPath(user), 'utf8')).migrated).toHaveLength(2);
  await m.rollback();
  expect(jobs).toEqual([]);
  expect(api.loadSchedule(user).vacancies.A).toEqual({ enabled: true, interval_hours: 24 });
});

it('migration keeps legacy state when core refuses the job (never leaves a vacancy unscheduled)', async () => {
  const m = require('../scripts/migrate-cold-search-to-cron.cjs');
  context('active_vacancies', [{ id: 'A' }]);
  api.saveSchedule(user, { enabled: true, vacancies: { A: { enabled: true } } });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ ok: false, error: 'nope' }) })));
  const [r] = await m.apply(m.plan());
  expect(r.error).toBe('nope');
  expect(api.loadSchedule(user).vacancies.A).toEqual({ enabled: true });
});
