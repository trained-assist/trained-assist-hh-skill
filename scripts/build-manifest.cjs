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

  // ── Recruiting satellites moved from core (agent#1470) ──────────────────────
  // Call Tips: login link / list are reads; prepare writes calltips-latest.json locally.
  calltips_get_login:       { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: USER_ONLY },
  calltips_list_candidates: { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: USER_ONLY },
  calltips_prepare:         { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: USER_ONLY },
  // Recruiter text tools: LLM drafting only, no HH or outbound effect.
  boolean_search:           { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: USER_ONLY },
  jd_generate:              { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: USER_ONLY },
  interview_questions_bank: { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: USER_ONLY },
  salary_benchmark:         { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: USER_ONLY },
  sourcing_checklist:       { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: USER_ONLY },
  // ApplyLink (moved from core 41-applylink, agent#1470): create/update writes a
  // vacancy on the ApplyLink worker; list/candidates are reads.
  applylink_create_vacancy: { effect: 'write', requiresApproval: false, retrySafety: 'unsafe', allowedTriggers: USER_ONLY },
  applylink_list_vacancies: { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: USER_ONLY },
  applylink_get_candidates: { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: USER_ONLY },
  // HH demo mode (moved from core 98-demo, agent#1470): simulated candidates stored
  // locally for the profile; no HH or outbound effect.
  demo_activate:          { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: USER_ONLY },
  demo_deactivate:        { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: USER_ONLY },
  demo_next_wave:         { effect: 'write', requiresApproval: false, retrySafety: 'unsafe', allowedTriggers: USER_ONLY },
  demo_reply:             { effect: 'write', requiresApproval: false, retrySafety: 'unsafe', allowedTriggers: USER_ONLY },
  demo_status:            { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: USER_ONLY },
  demo_candidates:        { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: USER_ONLY },
  demo_candidate_profile: { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: USER_ONLY },
  // Candidate-for-client report (moved from core 97b, agent#1470): notes file is local
  // state; render writes the profile HTML and publishes via core's /internal/publish.
  candidate_report_context:  { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: USER_ONLY },
  candidate_report_add_note: { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: USER_ONLY },
  candidate_report_html:   { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: USER_ONLY },
  // Interview analysis (moved from core 99, agent#1470): criteria are local profile
  // state; analyze reads a transcript and writes the analysis files (LLM, no HH effect).
  interview_set_criteria: { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: USER_ONLY },
  interview_get_criteria: { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: USER_ONLY },
  interview_analyze:      { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: USER_ONLY },
  // Interview transcription (#88): downloads a public source, calls Deepgram and
  // writes local transcript/structure files. Local state + an outbound read of a
  // third-party API, no hh.ru effect; re-running with the same source hits the
  // sha256 cache, so both are idempotent and user-triggered only.
  hh_interview_transcribe: { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: USER_ONLY },
  hh_interview_structure:  { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: USER_ONLY },
  // Interview → portrait requirements (#89): reads structure.json + the stored portrait,
  // writes the evaluation cache locally (LLM, no HH effect). Coverage reads that cache.
  hh_interview_evaluate: { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
  hh_interview_coverage: { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: READ_ONLY },
  // ── Read-only actions ──────────────────────────────────────────────────────
  hh_list_vacancies:      { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: READ_ONLY },
  hh_list_responses:      { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: READ_ONLY },
  hh_search_resumes:      { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: READ_ONLY },
  hh_funnel_stats:        { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: READ_ONLY },
  hh_get_messages:        { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: READ_ONLY },
  candidate_report_markdown:   { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: READ_ONLY },
  hh_vacancy_get_draft:   { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: READ_ONLY },
  hh_proactive_view:      { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: READ_ONLY },

  // ── Drafting/evaluation — local write (scores/drafts saved), no outbound HH effect ──
  hh_evaluate_candidate:    { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
  hh_extract_ats_config:    { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
  hh_generate_message_to_applicant:      { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
  hh_batch_evaluate:        { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
  hh_regenerate_messages:   { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
  hh_draft_review_page:     { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
  hh_open_ats_editor:       { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
  hh_vacancy_update_draft:  { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
  hh_vacancy_create_draft:  { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },

  // ── Candidate portrait (#83) — local context reads/writes, no outbound HH effect ──
  hh_portrait_extract:     { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
  hh_portrait_get:         { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: READ_ONLY },
  hh_portrait_update:      { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
  hh_portrait_completeness:{ effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: READ_ONLY },
  hh_portrait_to_ats:      { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
  cold_message_generate:    { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
  rejection_with_feedback:  { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY },
  // Schedulable (agent#1489 S7.1): hh_proactive_schedule is a wrapper creating one core
  // cron job per vacancy. Silent: cold-search Telegram notifications were retired —
  // results are read with hh_proactive_view, cron must never bring the pings back.
  hh_proactive_search:      { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: READ_ONLY,
    schedule: { label: 'Холодный поиск по вакансии', minIntervalMinutes: 30, delivery: 'silent', costClass: 'cheap_llm',
      settingsSchema: { type: 'object', required: ['vacancy_id'], properties: { vacancy_id: { type: 'string', minLength: 1 } } } } },

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
      ...(policy.schedule ? { schedule: policy.schedule } : {}),
    };
  });
  return { version: 1, providerId, actions };
}

// Core's strict v1 descriptor omits MCP-only description metadata.
function buildActionManifest() {
  const catalog = buildManifest();
  return { ...catalog, actions: catalog.actions.map(({ description, ...action }) => action) };
}

module.exports = { buildManifest, buildActionManifest, POLICY };

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  fs.writeFileSync(path.join(__dirname, '../provider-manifest.json'), JSON.stringify(buildManifest(), null, 2) + '\n');
  fs.writeFileSync(path.join(__dirname, '../action-provider-manifest.json'), JSON.stringify(buildActionManifest(), null, 2) + '\n');
}
