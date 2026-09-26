'use strict';

// hh_quick_answer — host-only action for core's deterministic Telegram quick
// answers (/hh_status, /hh_vacancies, /hh_send…/hh_send_yes, /hh_reject…).
// Epic trained-assist-agent#1470 P1.3: core used to require('../hh-quick')
// in-process; now it spawns this provider and calls one intent.
//
// hostOnly: never listed to the model and refused unless the process was
// spawned by core as a host action (MCP_HOST_ACTION=1). send_confirm /
// reject_confirm execute outbound HH effects; only a user-typed /hh_*_yes may
// reach them, never a model tool call.

const q = require('../../hh-quick');

const WORK_DIR = () => process.env.WORK_DIR || process.cwd();

const INTENTS = {
  status:          (u) => q.hhStatus(u),
  my_vacancies:    (u, w) => q.hhMyVacancies(u, w),
  funnel:          (u, w) => q.hhFunnelStats(u, w),
  new_responses:   (u, w) => q.hhNewResponses(u, w),
  ats_editor:      (u) => q.hhAtsEditor(u),
  // Review page only makes sense with a selected vacancy; otherwise let the
  // caller fall through to the full session (same as the former core branch).
  review_page:     (u, w) => (q.readActiveVacancy(w) ? q.hhReviewPage(u) : null),
  where_prompt:    (u) => q.hhWherePrompt(u),
  show_ats_config: (u) => q.hhShowAtsConfig(u),
  style_page:      (u) => q.hhStylePage(u),
  send_preview:    (u, w, t) => q.hhSendPreview(u, w, t),
  send_confirm:    (u, w) => q.hhSendConfirm(u, w),
  send_cancel:     (u, w) => q.hhSendCancel(u, w),
  reject_dry_run:  (u, w, t) => q.hhRejectDryRun(u, w, t),
  reject_confirm:  (u, w) => q.hhRejectConfirm(u, w),
  reject_cancel:   (u, w) => q.hhRejectCancel(u, w),
};

module.exports = {
  hostOnly: true,
  INTENTS,
  tools: {
    hh_quick_answer: {
      description: 'Host-only: deterministic HH quick answer for a user-typed command.',
      inputSchema: {
        type: 'object',
        properties: {
          intent: { type: 'string', enum: Object.keys(INTENTS) },
          task: { type: 'string', description: 'Raw user command text (for /hh_send, /hh_reject).' },
        },
        required: ['intent'],
      },
      handler: async ({ intent, task } = {}) => {
        const fn = INTENTS[intent];
        if (!fn) throw new Error(`Unknown intent: ${intent}`);
        const userId = process.env.USER_ID || '';
        if (!userId) throw new Error('USER_ID required');
        const out = await fn(userId, WORK_DIR(), String(task || ''));
        // Empty string = "no quick answer, fall through to a full session".
        return out == null ? '' : String(out);
      },
    },
  },
};
