'use strict';
// hh_sync_messages — the action extraction target from
// docs/architecture/action-cron-contract-v1.md (trained-assist-agent #1209).
//
// Unlike the other 37 tools in this provider (90/91/91b/92-*.js), this handler does not
// read USER_ID/AGENT_TOKENS_DIR/process.cwd() directly. It builds a scoped capability
// (hh-capability.js) bound to this process's USER_ID once, then calls the sync action
// through it — the first tool in this provider following the "provider gets only scoped
// context/artifact/credentials, never a broad env switch" shape the contract describes
// for the eventual invokeAction runtime (PR 3). The other 37 tools are unchanged broad-
// access migration debt, not silently fixed by this file.

const { createHhCapability } = require('../../hh-capability');
const { syncMessagesAction } = require('../../hh-sync-action');
const { refreshHhToken } = require('../../hh-utils');

const USER_ID = process.env.USER_ID || '';

module.exports = {
  // Matches the readiness convention of every other HH tool module (90/91/91b/92-*.js):
  // gated on a connected HH token, not unconditionally true — sync has nothing to do
  // without one. Short-circuits without USER_ID (e.g. static tool-listing/discovery
  // calls before any profile is bound) instead of constructing a capability that would
  // reject an empty userId.
  isReady: () => !!USER_ID && !!createHhCapability({ userId: USER_ID }).readToken(),

  tools: {
    hh_sync_messages: {
      description:
        'Sync HH negotiation message threads into local candidate history for one vacancy. ' +
        'Fetches messages from HH API for candidates HH shows as having more messages than stored locally, ' +
        'merges them (dedup by HH message id). This is the same sync the background scoring loop performs ' +
        'every 5 minutes — call it directly for an on-demand refresh (e.g. before opening the review page, ' +
        'or from a cron job) instead of waiting for the next background tick.',
      inputSchema: {
        type: 'object',
        properties: {
          vacancy_id: { type: 'string', description: 'Vacancy ID to sync messages for. Required — sync is always scoped to one vacancy.' },
          incremental: { type: 'boolean', description: 'true = only candidates HH shows as updated since our last sync (default false = sync all, capped by `cap`).' },
          cap: { type: 'number', description: 'Max candidates to sync when incremental=false (default 15).' },
        },
        required: ['vacancy_id'],
      },
      handler: async ({ vacancy_id, incremental, cap } = {}) => {
        const capability = createHhCapability({ userId: USER_ID });
        return syncMessagesAction(capability, {
          vacancy_id,
          incremental,
          cap,
          refreshToken: (userId) => refreshHhToken(userId, {
            HH_CLIENT_ID: process.env.HH_CLIENT_ID,
            HH_CLIENT_SECRET: process.env.HH_CLIENT_SECRET,
          }),
        });
      },
    },
  },
};
