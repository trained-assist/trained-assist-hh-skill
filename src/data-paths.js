'use strict';

// Profile data-path resolver. Every HH data root is derived here, never by a
// hardcoded os.homedir() at a call site: CI/staging isolation rewrites HOME,
// AGENT_TOKENS_*, AGENT_DATA_DIR and USERS_DIR, and a stray os.homedir() is
// exactly how a test or a canary escapes the sandbox. Env always wins; the
// home-relative default is a single, auditable fallback (L3 guard enforces it).

const os = require('os');
const path = require('path');

function home() {
  return process.env.HOME || os.homedir();
}

// AGENT_TOKENS_DIR is the legacy name, AGENT_TOKENS_ROOT the newer one; both are
// honoured so existing profiles keep working after a config migration.
function tokensRoot() {
  return process.env.AGENT_TOKENS_DIR || process.env.AGENT_TOKENS_ROOT || path.join(home(), 'agent-tokens');
}

function dataRoot() {
  return process.env.AGENT_DATA_DIR || path.join(home(), 'agent-data');
}

function usersRoot() {
  return process.env.USERS_DIR || path.join(home(), 'users');
}

function connectPendingDir() {
  return process.env.CONNECT_PENDING_DIR || path.join(home(), 'connect-pending');
}

// HH state (vacancies, ATS configs, recruiter identity, drafts) belongs to the
// profile, not to a project: the web pages (/hh/proactive, hub) and the core
// context store read <users>/<USER_ID>/contexts. A session bound to a project
// runs with cwd = <profile>/projects/<id>, so a cwd-relative write forked the
// state into the project and the site never saw it. Climb back to the profile
// root when cwd sits under <USER_ID>/projects/; any other cwd is used as is
// (legacy sessions, tests that chdir into a sandbox).
function profileWorkDir(cwd = process.cwd()) {
  const userId = String(process.env.USER_ID || '');
  if (!userId) return cwd;
  const parts = path.resolve(cwd).split(path.sep);
  for (let i = parts.length - 1; i > 0; i--) {
    if (parts[i] === 'projects' && parts[i - 1] === userId) return parts.slice(0, i).join(path.sep) || path.sep;
  }
  return cwd;
}

module.exports = { home, tokensRoot, dataRoot, usersRoot, connectPendingDir, profileWorkDir };
