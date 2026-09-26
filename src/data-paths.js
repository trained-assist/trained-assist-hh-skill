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

module.exports = { home, tokensRoot, dataRoot, usersRoot, connectPendingDir };
