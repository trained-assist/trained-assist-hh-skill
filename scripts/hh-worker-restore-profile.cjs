#!/usr/bin/env node
'use strict';
// Restore one HH profile into the standalone worker's own directories (#187 step 3).
//
//   node scripts/hh-worker-restore-profile.cjs --profile <name> --archive <final.tar> \
//        --state-root <dir> [--source-token <file>] [--dry-run]
//
// What is restored, and from where:
//   ATS settings, active vacancies, stage/message config
//       → <state-root>/users/<profile>/contexts/hh/
//   query cache, seen ids, candidate store, snapshots, schedule ledger
//       → <state-root>/data/hh/<profile>/proactive/
//   the HH credential
//       → <state-root>/agent-tokens/<profile>/hh
//
// The credential is bound explicitly: the binding file records which profile
// owns which credential and where the source lives, so a later re-login is
// picked up instead of silently running on a stale copy. The credential value
// itself never appears in the report.
//
// An encrypted credential whose master key is not available is NOT restored:
// the worker would then answer 401 and look broken. The report says so
// explicitly instead.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { readCredentialFile, writeCredentialFile } = require('../src/credential-store');

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-/g, '_');
    if (key === 'dry_run') { out.dryRun = true; continue; }
    out[key] = argv[++i];
  }
  return out;
}

function listArchive(archive) {
  const out = execFileSync('tar', ['-tf', archive], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').map(line => line.trim()).filter(Boolean);
}

function extract(archive, members, target) {
  if (!members.length) return [];
  execFileSync('tar', ['-xf', archive, '-C', target, ...members], { stdio: ['ignore', 'ignore', 'pipe'] });
  return members;
}

function copyTree(from, to) {
  const copied = [];
  if (!fs.existsSync(from)) return copied;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copied.push(...copyTree(src, dst));
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dst);
      fs.chmodSync(dst, 0o600);
      copied.push(path.relative(to, dst));
    }
  }
  return copied;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const profile = args.profile;
  const archive = args.archive;
  const stateRoot = args.state_root;
  if (!profile || !archive || !stateRoot) {
    console.error('Usage: hh-worker-restore-profile.cjs --profile <name> --archive <tar> --state-root <dir> [--source-token <file>]');
    process.exit(2);
  }
  const usersDir = args.users_dir || path.join(stateRoot, 'users');
  const dataDir = args.data_dir || path.join(stateRoot, 'data');
  const tokensDir = args.tokens_dir || path.join(stateRoot, 'agent-tokens');
  const bindingsFile = args.bindings_file || path.join(stateRoot, 'state', 'bindings.json');

  const report = { profile, restored: { contexts: [], proactive: [] }, credential: null, verification: [], warnings: [] };

  // ── legacy content ─────────────────────────────────────────────────────────
  const members = listArchive(archive);
  const contextsPrefix = `users/${profile}/contexts/hh/`;
  const proactivePrefix = `agent-data/hh/${profile}/proactive/`;
  const contextMembers = members.filter(m => m.startsWith(contextsPrefix) && !m.endsWith('/'));
  const proactiveMembers = members.filter(m => m.startsWith(proactivePrefix) && !m.endsWith('/'));

  if (!args.dry_run) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-restore-'));
    try {
      extract(archive, contextMembers, tmp);
      extract(archive, proactiveMembers, tmp);
      report.restored.contexts = copyTree(path.join(tmp, 'users', profile, 'contexts', 'hh'), path.join(usersDir, profile, 'contexts', 'hh'));
      report.restored.proactive = copyTree(path.join(tmp, 'agent-data', 'hh', profile, 'proactive'), path.join(dataDir, 'hh', profile, 'proactive'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } else {
    report.restored.contexts = contextMembers.map(m => m.slice(contextsPrefix.length));
    report.restored.proactive = proactiveMembers.map(m => m.slice(proactivePrefix.length));
  }

  // ── credential ─────────────────────────────────────────────────────────────
  const target = path.join(tokensDir, profile, 'hh');
  const sourceToken = args.source_token || null;
  const archiveToken = members.includes(`agent-tokens/${profile}/hh`) ? `agent-tokens/${profile}/hh` : null;
  let credentialSource = sourceToken;
  if (!credentialSource && archiveToken) {
    // The archive copy may be an encrypted envelope: decrypt it only with the key.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-restore-cred-'));
    try {
      extract(archive, [archiveToken], tmp);
      const raw = path.join(tmp, archiveToken);
      try {
        readCredentialFile(raw);
        credentialSource = raw;
        report.credential = { source: 'archive', restored: false };
      } catch (error) {
        report.credential = { source: 'archive', restored: false, reason: 'encrypted_without_key' };
        report.warnings.push('credential in the archive is encrypted and CRED_ENCRYPTION_KEY is not available — it was not restored');
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  if (credentialSource) {
    try {
      const value = readCredentialFile(credentialSource);
      if (!args.dry_run) {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        writeCredentialFile(target, value);
      }
      report.credential = {
        source: sourceToken ? 'live' : 'archive',
        restored: true,
        target,
        format: 'json' in value ? 'json' : 'plaintext',
      };
    } catch (error) {
      report.credential = { source: sourceToken ? 'live' : 'archive', restored: false, reason: error.message };
      report.warnings.push(`credential could not be read: ${error.message}`);
    }
  } else {
    report.credential = { source: null, restored: false, reason: 'not_found' };
    report.warnings.push('no HH credential found for this profile');
  }

  // ── explicit binding ───────────────────────────────────────────────────────
  const bindingSource = sourceToken || (report.credential && report.credential.restored ? archiveToken : null);
  if (bindingSource && !args.dry_run) {
    let bindings = { version: 1, profiles: [] };
    try {
      bindings = JSON.parse(fs.readFileSync(bindingsFile, 'utf8'));
    } catch { /* first binding */ }
    bindings.profiles = (bindings.profiles || []).filter(entry => entry.profile !== profile);
    bindings.profiles.push({ profile, credential: 'hh', source: bindingSource });
    fs.mkdirSync(path.dirname(bindingsFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(bindingsFile, `${JSON.stringify(bindings, null, 2)}\n`, { mode: 0o600 });
    report.binding = { file: bindingsFile, profile, credential: 'hh' };
  }

  // ── read/write verification ───────────────────────────────────────────────
  if (!args.dry_run) {
    const checks = [];
    const probeDir = path.join(usersDir, profile);
    try {
      fs.mkdirSync(probeDir, { recursive: true });
      const probe = path.join(probeDir, '.write-probe');
      fs.writeFileSync(probe, 'probe', { mode: 0o600 });
      fs.unlinkSync(probe);
      checks.push({ check: 'users_dir_writable', ok: true });
    } catch (error) {
      checks.push({ check: 'users_dir_writable', ok: false, error: error.message });
    }
    try {
      const probeDir = path.join(dataDir, 'hh', profile);
      fs.mkdirSync(probeDir, { recursive: true });
      const probe = path.join(probeDir, '.write-probe');
      fs.writeFileSync(probe, 'probe', { mode: 0o600 });
      fs.unlinkSync(probe);
      checks.push({ check: 'data_dir_writable', ok: true });
    } catch (error) {
      checks.push({ check: 'data_dir_writable', ok: false, error: error.message });
    }
    if (report.credential && report.credential.restored) {
      try {
        const value = readCredentialFile(target);
        checks.push({ check: 'credential_readable', ok: !!value && value.trim().length > 0 });
      } catch (error) {
        checks.push({ check: 'credential_readable', ok: false, error: error.message });
      }
    }
    report.verification = checks;
  }

  console.log(JSON.stringify(report, null, 2));
  if (report.verification.some(check => !check.ok)) process.exitCode = 1;
}

main();
