#!/usr/bin/env node
'use strict';
// One-shot migration (agent#1489 S7.1, agent#1514): legacy per-profile
// schedule.json cold-search state → one core cron job per enabled vacancy.
//
//   node scripts/migrate-cold-search-to-cron.cjs            # dry-run: prints the plan
//   node scripts/migrate-cold-search-to-cron.cjs --apply    # creates jobs, writes ledger
//   node scripts/migrate-cold-search-to-cron.cjs --rollback # deletes migrated jobs, re-enables legacy state
//
// Apply order per vacancy: upsert the cron job FIRST, then mark the legacy entry
// enabled:false + migrated_to_cron — so the vacancy is never left without a
// schedule, and the pre-migration core timer stops running it at once (no double
// runs). The ledger (<data>/hh/<user>/proactive/cron-migration.json) records what
// was done so --rollback restores exactly that. Env: AGENT_SECRET + AGENT_INTERNAL_URL
// (or PORT) as for the MCP wrapper; AGENT_DATA_DIR/USERS_DIR as the skill.

const fs = require('fs');
const path = require('path');
const { loadSchedule, saveSchedule } = require('../src/hh-proactive-search');
const { readActiveVacancies } = require('../src/hh-utils');
const { enableColdSearch, disableColdSearch } = require('../src/hh-cold-search-cron');
const { usersRoot, dataRoot: agentDataDir } = require('../src/data-paths');

function ledgerPath(user) { return path.join(agentDataDir(), 'hh', user, 'proactive', 'cron-migration.json'); }

function plan() {
  const base = path.join(agentDataDir(), 'hh');
  const out = [];
  if (!fs.existsSync(base)) return out;
  for (const user of fs.readdirSync(base).sort()) {
    const saved = loadSchedule(user);
    if (!saved || !saved.vacancies) continue;
    const tracked = new Set(readActiveVacancies(path.join(usersRoot(), user)).map(v => String(v.id)));
    for (const [id, st] of Object.entries(saved.vacancies)) {
      if (!st.enabled || st.archived || st.migrated_to_cron) continue;
      out.push({ user, vacancy_id: id, interval_hours: st.interval_hours || 24, tracked: tracked.has(id) });
    }
  }
  return out;
}

async function apply(items, fns = { enableColdSearch }) {
  const results = [];
  for (const it of items) {
    if (!it.tracked) { results.push({ ...it, skipped: 'vacancy not tracked (would not have run)' }); continue; }
    try {
      const { job, hours, role } = await fns.enableColdSearch(it.user, it.vacancy_id, it.interval_hours);
      const saved = loadSchedule(it.user);
      saved.vacancies[it.vacancy_id] = { ...saved.vacancies[it.vacancy_id], enabled: false, migrated_to_cron: job.id };
      saved.enabled = Object.values(saved.vacancies).some(v => v.enabled);
      saveSchedule(it.user, saved);
      const lp = ledgerPath(it.user);
      const ledger = fs.existsSync(lp) ? JSON.parse(fs.readFileSync(lp, 'utf8')) : { migrated: [] };
      ledger.migrated.push({ vacancy_id: it.vacancy_id, job_id: job.id, schedule: job.schedule, hours, at: new Date().toISOString() });
      fs.writeFileSync(lp, JSON.stringify(ledger, null, 2));
      results.push({ ...it, job_id: job.id, schedule: job.schedule, next_run: job.next_run_at, role });
    } catch (e) {
      results.push({ ...it, error: e.message });
    }
  }
  return results;
}

async function rollback(fns = { disableColdSearch }) {
  const base = path.join(agentDataDir(), 'hh');
  const results = [];
  for (const user of fs.existsSync(base) ? fs.readdirSync(base).sort() : []) {
    const lp = ledgerPath(user);
    if (!fs.existsSync(lp)) continue;
    const ledger = JSON.parse(fs.readFileSync(lp, 'utf8'));
    const saved = loadSchedule(user) || { vacancies: {} };
    for (const m of ledger.migrated) {
      await fns.disableColdSearch(user, m.vacancy_id);
      const { migrated_to_cron, ...rest } = saved.vacancies[m.vacancy_id] || {};
      saved.vacancies[m.vacancy_id] = { ...rest, enabled: true };
      results.push({ user, vacancy_id: m.vacancy_id, restored: true });
    }
    saved.enabled = Object.values(saved.vacancies).some(v => v.enabled);
    saveSchedule(user, saved);
    fs.renameSync(lp, lp + '.rolled-back-' + Date.now());
  }
  return results;
}

module.exports = { plan, apply, rollback, ledgerPath };

if (require.main === module) {
  (async () => {
    const mode = process.argv[2] || '--dry-run';
    if (mode === '--rollback') return console.log(JSON.stringify(await rollback(), null, 2));
    const items = plan();
    if (mode !== '--apply') return console.log(JSON.stringify({ dry_run: true, items }, null, 2));
    const results = await apply(items);
    console.log(JSON.stringify(results, null, 2));
    if (results.some(r => r.error)) process.exitCode = 1;
  })().catch(e => { console.error(e); process.exit(1); });
}
