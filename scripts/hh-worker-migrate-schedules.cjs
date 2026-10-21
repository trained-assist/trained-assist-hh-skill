#!/usr/bin/env node
'use strict';
// Import the legacy cold-search schedules into the worker's schedule store (#187 step 4).
//
//   node scripts/hh-worker-migrate-schedules.cjs --legacy-db <core.sqlite> \
//        --state-root <dir> --out <mapping.json> [--sqlite-module <path>] [--source <id>]
//
// Every legacy job keeps its id, its original cron expression and its timezone.
// The jobs arrive disabled: the legacy runs were paused on the retiring host and
// must not be replayed blindly. The eight jobs whose last outcome is unknown
// are quarantined with an explicit decision — their last run may still have been
// in flight when the host went away, so a replay could apply the same work twice.
//
// The mapping (legacy job id → new job id) is written to a private file: it
// names vacancies, so it stays mode 0600 and out of the repository.

const fs = require('fs');
const path = require('path');
const { createScheduleStore } = require('../src/hh-worker-schedule-store');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-/g, '_');
    out[key] = argv[++i];
  }
  return out;
}

function loadSqlite(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.SQLITE_MODULE) candidates.push(process.env.SQLITE_MODULE);
  candidates.push('better-sqlite3');
  const releasesRoot = '/opt/trained-assist-recruiting-web/releases';
  try {
    for (const entry of fs.readdirSync(releasesRoot).sort().reverse()) {
      candidates.push(path.join(releasesRoot, entry, 'node_modules', 'better-sqlite3'));
    }
  } catch { /* no staged releases on this host */ }
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch { /* try the next candidate */ }
  }
  throw new Error('No sqlite driver available — pass --sqlite-module <path to better-sqlite3>');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const legacyDb = args.legacy_db;
  const stateRoot = args.state_root;
  const outFile = args.out;
  if (!legacyDb || !stateRoot) {
    console.error('Usage: hh-worker-migrate-schedules.cjs --legacy-db <sqlite> --state-root <dir> --out <mapping.json>');
    process.exit(2);
  }
  const source = args.source || 'legacy-core-cron';
  const Database = loadSqlite(args.sqlite_module);
  const db = new Database(legacyDb, { readonly: true, fileMustExist: true });
  const rows = db.prepare(`
    SELECT id, profile_id, name, schedule, timezone, action, arguments_json, enabled, last_status, last_error
    FROM cron_jobs
    WHERE action = 'hh_proactive_search'
    ORDER BY profile_id, name
  `).all();
  db.close();

  const entries = rows.map(row => {
    let args_ = {};
    try { args_ = JSON.parse(row.arguments_json || '{}'); } catch { args_ = {}; }
    const unknown = String(row.last_status || '') === 'unknown';
    return {
      legacy_job_id: row.id,
      profile_id: row.profile_id,
      name: row.name,
      action: row.action,
      schedule: row.schedule,
      timezone: row.timezone,
      arguments: args_,
      last_status: row.last_status || null,
      enabled: false,
      decision: unknown
        ? 'quarantined_pending_owner'
        : 'migrated_disabled',
    };
  });

  const store = createScheduleStore({ env: { ...process.env, HH_WORKER_STATE_DIR: path.join(stateRoot, 'state') } });
  const mapping = store.migrateLegacy(entries, { source });

  const summary = {
    source,
    legacy_db: legacyDb,
    imported_at: new Date().toISOString(),
    total: mapping.length,
    quarantined: mapping.filter(row => row.decision === 'quarantined_pending_owner').length,
    unknown_outcomes: mapping.filter(row => row.legacy_last_status === 'unknown').length,
    enabled: mapping.filter(row => row.enabled).length,
    profiles: [...new Set(mapping.map(row => row.profile_id))],
    mapping,
  };
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  }
  console.log(JSON.stringify({ ...summary, mapping: undefined }, null, 2));
}

main();
