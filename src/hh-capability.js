'use strict';
// Scoped capability for a single profile — the first non-broad-access surface in this
// provider (issue #1209 / docs/architecture/action-cron-contract-v1.md in trained-assist-agent).
//
// Every existing MCP tool (90/91/91b/92-*.js) still resolves paths against the shared
// AGENT_TOKENS_DIR/AGENT_DATA_DIR/USERS_DIR roots directly — that migration debt is
// unchanged by this file (see hh-utils.js, user-tokens.js). This module is deliberately
// narrow: it is the capability object handed to the new hh_sync_messages action (and any
// future action written against the v1 contract), bound to exactly one { userId, workDir }
// pair at construction time. It cannot list or touch another profile's directory — there
// is no TOKENS_ROOT/USERS_ROOT reference here, only paths built from the bound userId.
//
// user-tokens.js's cross-account chatId→username migration is intentionally NOT
// reproduced here: that one-time legacy migration needs to scan sibling directories by
// design, which is exactly the broad-access shape a scoped capability must not have. A
// profile with only legacy chatId-keyed tokens (no username-keyed hh token file yet) will
// see readToken() return null until something else (existing hh_status/hh_connect flow)
// performs that migration first — no regression, because hh_sync_messages does not run
// standalone: today it only runs after runHhScoringForUser has already loaded a token the
// old way, and the same is true for its cron-eligible successor.

const fs = require('fs');
const path = require('path');
const { tokensRoot, dataRoot, usersRoot } = require('./data-paths');

/**
 * Build a capability object scoped to one profile. No method on the returned object
 * accepts a userId/workDir argument — the binding happens once, here, so a bug in a
 * caller can't accidentally widen scope to another profile mid-call.
 */
function createHhCapability({ userId, workDir }) {
  if (!userId || typeof userId !== 'string') {
    throw Object.assign(new Error('createHhCapability requires userId'), { code: 'INVALID_ARGUMENTS' });
  }
  const resolvedWorkDir = workDir || path.join(usersRoot(), userId);

  const tokenFile = path.join(tokensRoot(), userId, 'hh');
  const candidateDir = path.join(dataRoot(), 'hh', userId, 'candidates');

  function readToken() {
    try {
      const raw = fs.readFileSync(tokenFile, 'utf8').trim();
      return raw.startsWith('{') ? JSON.parse(raw) : { access_token: raw };
    } catch {
      return null;
    }
  }

  function contextPath(skill, key) {
    return path.join(resolvedWorkDir, 'contexts', skill, `${key}.json`);
  }

  function readContext(skill, key) {
    try {
      return JSON.parse(fs.readFileSync(contextPath(skill, key), 'utf8'));
    } catch {
      return null;
    }
  }

  async function writeContext(skill, key, value) {
    const file = contextPath(skill, key);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(
      file,
      JSON.stringify({ value, updated_at: new Date().toISOString() }, null, 2),
    );
  }

  function candidateHistoryPath(negotiationId) {
    return path.join(candidateDir, `${negotiationId}.json`);
  }

  function readCandidateHistory(negotiationId) {
    try {
      return JSON.parse(fs.readFileSync(candidateHistoryPath(negotiationId), 'utf8'));
    } catch {
      return { messages: [], ats_result: null };
    }
  }

  function writeCandidateHistory(negotiationId, history) {
    fs.mkdirSync(candidateDir, { recursive: true });
    fs.writeFileSync(candidateHistoryPath(negotiationId), JSON.stringify(history, null, 2), { mode: 0o600 });
  }

  return {
    userId,
    workDir: resolvedWorkDir,
    // dataRoot is exposed (not just the derived candidateDir) so callers that need to
    // hand a "dataDir" to existing shared functions (e.g. syncHhMessagesToHistory's
    // (dataDir, username, ...) signature in hh-negotiations.js) don't have to
    // reverse-engineer it by walking back up candidateDir.
    dataRoot: dataRoot(),
    readToken,
    readContext,
    writeContext,
    candidateDir,
    candidateHistoryPath,
    readCandidateHistory,
    writeCandidateHistory,
  };
}

module.exports = { createHhCapability };
