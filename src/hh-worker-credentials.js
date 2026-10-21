'use strict';

// Explicit profile binding for the worker's credentials (#187 step 3).
//
// The worker runs with its own directories, so a profile credential has to be
// bound to it explicitly: which profile, which credential file, and where the
// copy lives. The binding is a small private file (no secret values in it) and
// the copy is refreshed from the source when the source changes — a recruiter
// re-login rotates the credential, and a stale copy would look like a broken
// HH account.
//
// Nothing here ever prints a credential value: only file names and outcomes.

const fs = require('fs');
const path = require('path');
const { tokensRoot } = require('./data-paths');
const { stateDir } = require('./hh-worker-schedule-store');

function bindingsFile(env = process.env) {
  return env.HH_WORKER_BINDINGS || path.join(stateDir(env), 'bindings.json');
}

// The shared resolver owns the default; an explicit directory wins, so a test
// or a staging host can point the binding somewhere else.
function tokensRootFor(env = process.env) {
  if (env.AGENT_TOKENS_DIR) return env.AGENT_TOKENS_DIR;
  if (env.AGENT_TOKENS_ROOT) return env.AGENT_TOKENS_ROOT;
  return tokensRoot();
}

function loadBindings({ env = process.env } = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(bindingsFile(env), 'utf8'));
    const profiles = Array.isArray(raw.profiles) ? raw.profiles : [];
    return profiles
      .filter(entry => entry && entry.profile && entry.source)
      .map(entry => ({
        profile: String(entry.profile),
        credential: String(entry.credential || 'hh'),
        source: String(entry.source),
      }));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function targetPath(binding, env = process.env) {
  return path.join(tokensRootFor(env), binding.profile, binding.credential);
}

// Copy a bound credential into the worker when the source is newer. Returns one
// record per binding: what happened, never what was copied.
function syncBoundCredentials({ env = process.env } = {}) {
  const out = [];
  for (const binding of loadBindings({ env })) {
    const target = targetPath(binding, env);
    let sourceStat = null;
    try {
      sourceStat = fs.statSync(binding.source);
    } catch {
      out.push({ profile: binding.profile, credential: binding.credential, action: 'source_missing' });
      continue;
    }
    let targetStat = null;
    try {
      targetStat = fs.statSync(target);
    } catch { /* no copy yet */ }
    if (targetStat && targetStat.mtimeMs >= sourceStat.mtimeMs && targetStat.size === sourceStat.size) {
      out.push({ profile: binding.profile, credential: binding.credential, action: 'unchanged' });
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const tmp = `${target}.tmp-${process.pid}`;
      fs.copyFileSync(binding.source, tmp);
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, target);
      out.push({ profile: binding.profile, credential: binding.credential, action: 'refreshed' });
    } catch (error) {
      out.push({ profile: binding.profile, credential: binding.credential, action: 'failed', error: error.message });
    }
  }
  return out;
}

// Read/write check of the bound credentials: the worker must be able to read
// the copy and to replace it (token refresh writes a new value back).
function verifyBoundCredentials({ env = process.env } = {}) {
  const out = [];
  for (const binding of loadBindings({ env })) {
    const target = targetPath(binding, env);
    const record = { profile: binding.profile, credential: binding.credential, target };
    try {
      const raw = fs.readFileSync(target, 'utf8');
      if (!raw.trim()) { record.ok = false; record.reason = 'empty'; out.push(record); continue; }
    } catch (error) {
      record.ok = false;
      record.reason = error.code === 'ENOENT' ? 'missing' : 'unreadable';
      out.push(record);
      continue;
    }
    try {
      const probe = `${target}.write-probe`;
      fs.writeFileSync(probe, 'probe', { mode: 0o600 });
      fs.unlinkSync(probe);
      record.ok = true;
    } catch (error) {
      record.ok = false;
      record.reason = 'not_writable';
    }
    out.push(record);
  }
  return out;
}

module.exports = { bindingsFile, loadBindings, targetPath, syncBoundCredentials, verifyBoundCredentials };
