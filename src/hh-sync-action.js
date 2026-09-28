'use strict';
// hh_sync_messages action — the extraction target called out explicitly in
// docs/architecture/action-cron-contract-v1.md (trained-assist-agent, issue #1209):
// "hh_sync_messages is not an existing MCP tool. The implementation
// syncHhMessagesToHistory is called from scoring/browser routes. PR 2 must expose a
// single action around it, with explicit vacancy and scoped context arguments."
//
// This module does not reimplement sync — it calls the existing, unchanged
// fetchAllHhNegotiations/syncHhMessagesToHistory from hh-negotiations.js so the
// candidate-history file format and dedup logic used by the background scoring loop
// and this new action are byte-for-byte the same implementation (parity tests assert
// this). What's new here is argument/credential handling: explicit vacancy_id, and a
// scoped capability (hh-capability.js) instead of the background loop's own directory
// scan over every profile under AGENT_TOKENS_DIR.

const { createHhNegotiations } = require('./hh-negotiations');

// fetchAllHhNegotiations/syncHhMessagesToHistory are pure w.r.t. the factory's injected
// deps (refreshHhToken/readChatId/getSecretsCache) — those are only reached by
// getHhNegotiationsWithCache/runHhScoringForUser, neither of which this action calls.
// Token refresh here is the action's own explicit concern (see refreshToken option
// below), not implicit background-loop behavior.
const { fetchAllHhNegotiations, syncHhMessagesToHistory } = createHhNegotiations({
  refreshHhToken: async () => null,
  readChatId: () => null,
  getSecretsCache: () => ({}),
});

/**
 * @param {object} capability - from createHhCapability({ userId, workDir }); scoped to one profile.
 * @param {object} args
 * @param {string} args.vacancy_id - required; sync is always scoped to one vacancy (no implicit "all vacancies").
 * @param {boolean} [args.incremental] - true → only candidates updated since last sync (matches the background loop's mode).
 * @param {number} [args.cap] - max candidates to sync when incremental=false (default 15, matches existing behavior).
 * @param {function} [args.refreshToken] - async (userId) => newAccessToken|null. Optional; if omitted, an
 *   expired-token error is returned as-is rather than silently retried.
 */
async function syncMessagesAction(capability, args = {}) {
  const { vacancy_id, incremental = false, cap = 15, refreshToken } = args;
  if (!vacancy_id || typeof vacancy_id !== 'string') {
    return { ok: false, error: 'vacancy_id обязателен.' };
  }

  const token = capability.readToken();
  if (!token?.access_token) {
    return { ok: false, error: 'HH не подключён.' };
  }

  let accessToken = token.access_token;
  let negotiations;
  try {
    negotiations = await fetchAllHhNegotiations(vacancy_id, accessToken);
  } catch (e) {
    const isAuthError = /HH 40[13].*token[-_]?expired/i.test(String(e.message || ''));
    if (isAuthError && typeof refreshToken === 'function') {
      const fresh = await refreshToken(capability.userId);
      if (!fresh) return { ok: false, error: e.message };
      accessToken = fresh;
      try {
        negotiations = await fetchAllHhNegotiations(vacancy_id, accessToken);
      } catch (e2) {
        return { ok: false, error: e2.message };
      }
    } else {
      return { ok: false, error: e.message };
    }
  }

  // syncHhMessagesToHistory writes under <dataDir>/hh/<username>/candidates/ — same
  // root capability.candidateDir was built from, passed through as-is so both callers
  // (this action and the background loop) write the exact same files.
  const result = await syncHhMessagesToHistory(capability.dataRoot, capability.userId, negotiations, accessToken, {
    incremental,
    cap,
    maxConcurrent: 4,
  });

  return { ok: true, vacancy_id, synced: result.synced, new_messages: result.newMessages };
}

module.exports = { syncMessagesAction };
