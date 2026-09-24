'use strict';
// HH provider's own v1 action manifest — metadata only, consumed by core's
// ActionProviderRegistry.register() (trained-assist-agent src/action-provider-registry.js).
// Registration is not authorization: this file declares policy (effect/approval/retry
// safety/allowed triggers), it does not grant it. Core still authenticates, binds
// profile/project capabilities and records durable history before any effect runs
// (docs/architecture/action-cron-contract-v1.md, "Provider contract").
//
// Classification below follows the HH export partition table in that doc:
//   Auth/setup            -> never cron-eligible, allowedTriggers: ['user']
//   Scheduling wrapper     -> compatibility wrapper over generic cron (not extracted here)
//   Domain state            -> local tracking state, write/idempotent, user+cron+durable_task
//   Discovery/escape hatch  -> explicit policy, never implicitly approved for cron
//   Actions (remaining)     -> read vs write vs external_message vs destructive per what
//                              the handler actually does on hh.ru, not by naming convention
//
// Reading data and drafting text (evaluate/generate/draft) do not authorize sending it —
// only actions that call hh.ru POST/PUT against a candidate's live negotiation state are
// external_message/destructive here.

const registry = require('../src/mcp-skills/registry');

const READ_ONLY = ['user', 'cron', 'durable_task'];
const USER_ONLY = ['user'];

// name -> { effect, requiresApproval, retrySafety, allowedTriggers }
// Anything not listed here defaults to the conservative { write, requiresApproval:true,
// unsafe, ['user'] } — see buildManifest — so a newly added tool in registry.js can never
// silently inherit a permissive policy just by existing.
const POLICY = {
  // ── Auth/setup — never cron-eligible ──────────────────────────────────────
  hh_connect:   { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: USER_ONLY },
  hh_status:    { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: READ_ONLY },
  hh_set_token: { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: USER_ONLY },

  // ── Scheduling wrapper — compatibility only, not extracted to generic cron here ──
  hh_proactive_schedule: { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: USER_ONLY },

  // ── Domain state — local tracking state, safe to retry, cron/durable_task eligible ──
  hh_set_active_vacancy:       { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
  hh_deactivate_vacancy:       { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
  hh_set_rejection_template:   { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: USER_ONLY },
  hh_proactive_scoring_prompt: { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: USER_ONLY },
  hh_proactive_queries:        { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: READ_ONLY },

  // ── Discovery/escape hatch — explicit policy, never implicitly cron-approved ──
  hh_discover: { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: USER_ONLY },
  hh_api_call: { effect: 'write', requiresApproval: true, retrySafety: 'unsafe', allowedTriggers: USER_ONLY },

  // ── Read-only actions ──────────────────────────────────────────────────────
  hh_list_vacancies:      { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: READ_ONLY },
  hh_list_responses:      { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: READ_ONLY },
  hh_search_resumes:      { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: READ_ONLY },
  hh_funnel_stats:        { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: READ_ONLY },
  hh_get_messages:        { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: READ_ONLY },
  hh_candidate_profile:   { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: READ_ONLY },
  hh_vacancy_get_draft:   { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: READ_ONLY },
  hh_proactive_view:      { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: READ_ONLY },

  // ── Drafting/evaluation — local write (scores/drafts saved), no outbound HH effect ──
  hh_evaluate_resume:       { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
  hh_evaluate_candidate:    { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
  hh_extract_ats_config:    { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
  hh_generate_message:      { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
  hh_batch_evaluate:        { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
  hh_regenerate_messages:   { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
  hh_draft_review_page:     { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
  hh_open_ats_editor:       { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
  hh_vacancy_update_draft:  { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
  hh_vacancy_create_draft:  { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
  cold_message_generate:    { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
  rejection_with_feedback:  { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
  hh_proactive_search:      { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },

  // ── Outbound message to a candidate — external_message, always approval-gated ──
  hh_send_message: { effect: 'external_message', requiresApproval: true, retrySafety: 'unsafe', allowedTriggers: USER_ONLY },

  // ── Publishing / mutating candidate pipeline state on hh.ru — destructive, approval-gated ──
  hh_invite_resume:        { effect: 'destructive', requiresApproval: true, retrySafety: 'unsafe', allowedTriggers: USER_ONLY },
  hh_move_candidate:       { effect: 'destructive', requiresApproval: true, retrySafety: 'unsafe', allowedTriggers: USER_ONLY },
  hh_bulk_reject:          { effect: 'destructive', requiresApproval: true, retrySafety: 'unsafe', allowedTriggers: USER_ONLY },
  hh_vacancy_publish_page: { effect: 'destructive', requiresApproval: true, retrySafety: 'unsafe', allowedTriggers: USER_ONLY },

  // ── hh_sync_messages — the PR 2b extraction target ──────────────────────────
  // Writes local candidate-history files only (never posts to hh.ru); dedup by HH
  // message id makes re-running safe. Cron/durable_task-eligible is the point of
  // extracting it out of the HH-owned background timer (see hh-sync-action.js).
  hh_sync_messages: { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
};

const DEFAULT_POLICY = { effect: 'write', requiresApproval: true, retrySafety: 'unsafe', allowedTriggers: USER_ONLY };

function buildManifest(providerId = 'hh') {
  const actions = registry.listAllTools().map(tool => {
    const policy = POLICY[tool.name] || DEFAULT_POLICY;
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      allowedTriggers: policy.allowedTriggers,
      effect: policy.effect,
      requiresApproval: policy.requiresApproval,
      retrySafety: policy.retrySafety,
    };
  });
  return { version: 1, providerId, actions };
}

module.exports = { buildManifest, POLICY };

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  fs.writeFileSync(path.join(__dirname, '../provider-manifest.json'), JSON.stringify(buildManifest(), null, 2) + '\n');
}
