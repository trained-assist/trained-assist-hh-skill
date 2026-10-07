'use strict';
const { dataRoot, usersRoot } = require('./data-paths.js');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildResumeText, resumeNotice } = require('./hh-resume');
const { standardRejectionText, REJECTION_GREETING } = require('./hh-rejection');
const { revisionMetaTag } = require('./hh-version');
const {communicationReviewHtml}=require('./hh-communication-review');

const BASE_USERS_DIR = usersRoot();

// Generates the HH candidates review page HTML (moved from server.js, see issue #942 Phase 0).
function generateReviewPageHtml(negotiations, vacancyTitle, username, callbackBase, dataDir, opts = {}) {
  const { syncedAt, vacancyId, lastScoredAt, vacancies = [], syncError = null } = opts;
  const listView = ['active', 'starred', 'archived'].includes(opts.list) ? opts.list : 'active';
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const candDir = path.join(dataDir || dataRoot(), 'hh', String(username), 'candidates');
  function readHistory(negId) {
    const file = path.join(candDir, `${negId}.json`);
    if (!fs.existsSync(file)) return { messages: [], ats_result: null };
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { messages: [], ats_result: null }; }
  }

  // Read ATS config version to validate cached drafts — must resolve the same way the
  // background scorer does (readAtsConfig: per-vacancy file first, legacy singleton
  // fallback), or a 2nd tracked vacancy's page would compare against vacancy A's
  // config version and wrongly invalidate every cached draft.
  let atsConfigVersion = null;
  // Same read tells us whether this vacancy has criteria AT ALL: without them the
  // background loop skips it and letters stop refreshing (issue #126) — a state the
  // page must show instead of leaving the recruiter to discover stale drafts.
  let hasAtsConfig = false;
  try {
    const { readAtsConfig } = require('./hh-scoring');
    const workDir = path.join(BASE_USERS_DIR, String(username));
    const atsCfg = readAtsConfig(workDir, vacancyId);
    atsConfigVersion = atsCfg?.updated_at || null;
    hasAtsConfig = !!atsCfg;
  } catch {}


  const candidates = negotiations.map(mapNeg);
  // Rejected candidates are surfaced separately ("ответил после отказа") — never in
  // the active/starred/archived lists and never scored.
  const discardedCandidates = (opts.discarded || []).map(neg => ({ ...mapNeg(neg), is_discarded: true }));
  function mapNeg(neg) {
    const r = neg.resume || {};
    const history = readHistory(neg.id);
    const ats = history.ats_result || null;
    const daysAgo = neg.updated_at ? Math.floor((Date.now() - new Date(neg.updated_at).getTime()) / 86400000) : null;
    return {
      negotiation_id: neg.id,
      response_status: vacancyId ? require('./hh-response-state').readResponseState(dataDir || dataRoot(), username, vacancyId, neg.id) : 'active',
      created_at: neg.created_at || '',
      updated_at: neg.updated_at || '',
      has_updates: !!neg.has_updates || (neg.counters?.unread_messages || 0) > 0,
      neg_state: neg._state || 'response',
      first_name: r.first_name || '',
      name: [r.last_name, r.first_name].filter(Boolean).join(' ') || 'Кандидат',
      score: ats?.score ?? null,
      verdict: ats?.verdict ?? null,
      reasoning: ats?.reasoning ?? null,
      // Set when the last background scoring attempt failed — shown instead of a bare
      // "не оценён" so a broken scorer is visible to the recruiter, not silent.
      scoring_error: history.scoring_error?.message || null,
      matched: ats?.matched || [],
      gaps: ats?.gaps || [],
      communication_steps:history.communication_steps||null,
      draft_is_stale:!!(opts.communicationEnabled&&(history.message_draft?.text||ats?.draft_message)&&!history.communication_steps),
      draft_message: (() => {
        const md = history.message_draft;
        if (md?.text && (!atsConfigVersion || md.config_version === atsConfigVersion)) return md.text;
        return ats?.draft_message ?? null;
      })(),
      days_since_activity: daysAgo,
      resume_text: buildResumeText(neg),
      resume_notice: resumeNotice(neg, ats),
      history_messages: history.messages || [],
      already_sent: (history.messages || []).some(m => m.role === 'employer'),
      needs_reply: (() => {
        // HH counters answer "is there something unread"; the local history answers
        // "who spoke last". Local history is synced from HH on every page load and
        // only stores messages HH confirmed (each carries its hh_id), so it is the
        // exact source for the last sender.
        if (neg.counters?.unread_messages > 0) return true;
        const msgs = history.messages || [];
        const hhMessages = neg.counters?.messages || 0;
        if (msgs.length > 0) {
          // HH knows about more chat messages than we stored → our history is stale,
          // the last sender is unknown, so let the recruiter look instead of guessing.
          if (hhMessages > msgs.length) return true;
          return msgs[msgs.length - 1].role !== 'employer';
        }
        // has_updates is a coarse HH negotiation flag. When we do have a complete
        // message history, the last sender above is more precise: a status/update flag
        // must not put a candidate back in «Неотвеченные» after our reply.
        if (neg.has_updates) return true;
        // No local history at all. counters.messages counts real chat messages only —
        // the candidate's cover letter is NOT counted (verified against the HH API:
        // a response with our single message reports messages=1). 0 → nobody wrote in
        // the chat yet, the response itself still needs an answer. Never `<= 1`: that
        // misfiled every candidate we already answered as "Неотвеченные".
        return hhMessages === 0;
      })(),
      alternate_url: r.alternate_url || null,
      salary: r.salary ? `${(r.salary.amount || '').toLocaleString?.() || r.salary.amount} ${r.salary.currency || ''}`.trim() : null,
      msg_from_candidate: (history.messages || []).filter(m => m.role === 'applicant').length,
      msg_from_us: (history.messages || []).filter(m => m.role === 'employer').length,
      last_msg_role: (() => {
        const msgs = history.messages || [];
        return msgs.length > 0 ? msgs[msgs.length - 1].role : null;
      })(),
    };
  }

  function sortCandidates(list) {
    return [...list].sort((a, b) => {
      if (a.score != null && b.score != null) return (b.score || 0) - (a.score || 0) || (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0);
      if (a.score != null) return -1;
      if (b.score != null) return 1;
      return (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0);
    });
  }

  const counts = { active: 0, starred: 0, archived: 0 };
  candidates.forEach(c => { counts[c.response_status]++; });
  const visibleCandidates = candidates.filter(c => c.response_status === listView);
  const sorted = sortCandidates(visibleCandidates);
  const waitingCandidates = sortCandidates(visibleCandidates.filter(c => c.needs_reply));
  // We wrote, but the candidate has never replied
  const silentCandidates = sortCandidates(visibleCandidates.filter(c =>
    c.msg_from_us > 0 && c.msg_from_candidate === 0 && !c.needs_reply
  ));
  // No employer message at all — never initiated contact
  const noContactCandidates = sortCandidates(visibleCandidates.filter(c => c.msg_from_us === 0));
  // Both sides wrote; our reply is last and no action is pending
  const dialogCandidates = sortCandidates(visibleCandidates.filter(c =>
    c.msg_from_us > 0 && c.msg_from_candidate > 0 && c.last_msg_role === 'employer' && !c.needs_reply
  ));
  // Rejected candidates who wrote back after our rejection — the ones whose
  // "почему?" would otherwise sit unread forever.
  const repliedAfterReject = sortCandidates(discardedCandidates.filter(c => c.needs_reply));

  const colorMap = { 'ПРОПУСТИТЬ': '#16a34a', 'УТОЧНИТЬ': '#d97706', 'ОТКЛОНИТЬ': '#dc2626' };
  const bgMap = { 'ПРОПУСТИТЬ': '#f0fdf4', 'УТОЧНИТЬ': '#fffbeb', 'ОТКЛОНИТЬ': '#fef2f2' };
  const actionable = sorted.filter(c => c.verdict && c.verdict !== 'ОТКЛОНИТЬ').length;
  const agentSecret = process.env.AGENT_SECRET || '';
  const { createHmac } = require('crypto');
  const pageToken = agentSecret ? createHmac('sha256', agentSecret).update(String(username)).digest('hex').slice(0, 16) : '';

  const ageMin = syncedAt ? Math.round((Date.now() - syncedAt) / 60000) : null;
  const ageText = ageMin === null ? '' : ageMin === 0 ? 'только что' : `${ageMin} мин назад`;
  const scoredMin = lastScoredAt ? Math.round((Date.now() - lastScoredAt) / 60000) : null;
  const scoredText = scoredMin === null ? '' : scoredMin === 0 ? 'скоринг только что' : scoredMin < 60 ? `скоринг ${scoredMin} мин назад` : `скоринг ${Math.round(scoredMin/60)} ч назад`;

  let nextCardIndex = 0;
  function buildCardsHtml(list) {
    return list.map(c => {
      const i = nextCardIndex++;
    const hasScore = c.score != null;
    const col = colorMap[c.verdict] || '#94a3b8';
    const bg = bgMap[c.verdict] || '#fff';
    const scorePct = hasScore ? Math.round((c.score || 0) * 10) : 0;

    const matched = (c.matched || []).map(m => `<span class="tag tag-ok">${esc(m)}</span>`).join('');
    const gaps = (c.gaps || []).map(g => `<span class="tag tag-gap">${esc(g)}</span>`).join('');
    const daysNote = c.days_since_activity != null ? `<span class="meta"> · активность ${c.days_since_activity}д назад</span>` : '';

    const histMsgs = c.history_messages || [];
    const histSection = histMsgs.length === 0
      ? '<div class="hist-none">💬 Первое сообщение — переписки ещё не было</div>'
      : `<details class="hist-details"><summary class="hist-summary">📨 История диалога (${histMsgs.length} сообщ.)</summary>
           <div class="hist-thread">${histMsgs.map(m => `
             <div class="hist-msg hist-${esc(m.role || 'employer')}">
               <span class="hist-who">${m.role === 'employer' ? 'Рекрутер' : 'Кандидат'}</span>
               <span class="hist-time">${(m.timestamp || '').slice(0, 10)}</span>
               <div class="hist-text">${esc(m.text || '')}</div>
             </div>`).join('')}
           </div></details>`;

    const resumeSection = c.resume_text
      ? `<p class="resume-status">${esc(c.resume_notice)}</p><details class="resume-details"><summary class="resume-summary">📄 Резюме (текст)</summary>
           <pre class="resume-text">${esc(c.resume_text)}</pre>
         </details>`
      : '';

    const isActionable = c.verdict && c.verdict !== 'ОТКЛОНИТЬ';
    const isReject = c.verdict === 'ОТКЛОНИТЬ' && !c.is_discarded;

    const checkboxHtml = (isReject ? '' : `<label><input type="checkbox" class="card-cb" id="cb-${i}" data-idx="${i}" data-score="${(c.score || 0).toFixed(1)}" data-stale="${c.draft_is_stale ? '1' : '0'}" data-auto-select="${isActionable && c.response_status !== 'archived' ? '1' : '0'}" ${isActionable && c.response_status !== 'archived' && !c.draft_is_stale ? 'checked' : ''} onchange="onCheck()"> Отправить</label>`)
      + `<label><input type="checkbox" class="reject-cb" id="reject-cb-${i}" data-idx="${i}" data-score="${(c.score || 0).toFixed(1)}" onchange="onCheck()"> Отказать</label>`;

    const scoreHtml = hasScore
      ? `<div class="score-wrap">
           <div class="score-bar"><div class="score-fill" style="width:${scorePct}%;background:${col}"></div></div>
           <span class="score-num" style="color:${col}">${(c.score || 0).toFixed(1)}/10</span>
           <span class="verdict-badge" style="background:${col}">${esc(c.verdict)}</span>
         </div>`
      : c.scoring_error
        ? `<span class="verdict-none verdict-error" title="${esc(c.scoring_error)}">оценка не получена</span>`
        : '<span class="verdict-none">не оценён</span>';

    const hhBtn = c.alternate_url
      ? ` <a href="${esc(c.alternate_url)}" target="_blank" rel="noopener" class="hh-link-btn" title="Открыть резюме на HH">↗ HH</a>`
      : '';
    const profileToken = agentSecret
      ? require('crypto').createHmac('sha256', agentSecret).update(username).digest('hex').slice(0, 16)
      : '';
    const profileBtn = ` <a href="candidate?neg_id=${esc(c.negotiation_id)}&username=${esc(username)}&token=${profileToken}&vacancy_id=${esc(vacancyId || '')}" target="_blank" class="hh-link-btn" title="Открыть профиль кандидата">👤 Профиль</a>`;
    const nameHtml = `${esc(c.name)}${hhBtn}${profileBtn}${c.is_discarded ? ' <span class="verdict-badge" style="background:#7c3aed">↩️ ответил после отказа</span>' : ''}`;

    const hasDraft = !!c.draft_message;
    const msgLabel = c.already_sent ? 'Follow-up (уже писали)' : hasDraft ? 'Черновик сообщения' : 'Сообщение';
    const msgMeta = (c.msg_from_candidate || c.msg_from_us)
      ? `<div class="msg-meta">${c.msg_from_candidate} от кандидата · ${c.msg_from_us} от нас</div>`
      : '';
    const msgSection = isReject
      ? `<div class="msg-section">
           ${msgMeta}
           ${c.already_sent ? '<span class="meta">Контакт начат</span>' : ''}
           <div class="msg-label-row">
             <label class="msg-label" style="color:#dc2626">Сообщение об отказе</label>
             <button class="btn btn-gen" id="gen-${i}" onclick="generateRejection(${i},'${esc(c.negotiation_id)}','${esc(c.name)}')" title="Сгенерировать отказное сообщение">✦ Сгенерировать отказ</button>
           </div>
           <textarea class="msg-area" id="msg-${i}" rows="4">${esc(standardRejectionText(c.first_name))}</textarea>
           <div class="btns">
             <button class="btn btn-send-reject" onclick="rejectWithMessage(${i},'${esc(c.negotiation_id)}')">✗ Отправить отказ</button>
             <button class="btn-copy" onclick="copyMsg(${i})">📋 Копировать</button>
             <button class="btn btn-skip" onclick="setResponseState(this,'${esc(c.negotiation_id)}','archived')">В архив</button>
           </div>
         </div>`
      : `<div class="msg-section">
           ${msgMeta}
           ${c.already_sent ? '<span class="meta">Контакт начат</span>' : ''}
           <div class="msg-label-row">
             <label class="msg-label">${msgLabel}</label>
             <button class="btn btn-gen" id="gen-${i}" data-idx="${i}" data-negid="${esc(c.negotiation_id)}" data-name="${esc(c.name)}" data-sent="${c.already_sent ? '1' : '0'}" onclick="generateOne(${i},'${esc(c.negotiation_id)}','${esc(c.name)}',${!!c.already_sent})" title="Сгенерировать черновик">✦ Сгенерировать</button>
           </div>
           <div class="funnel-step" style="font-size:11px;color:var(--muted);margin:-4px 0 6px"></div>
           <div class="communication-review">${communicationReviewHtml(c.communication_steps)}</div>
           ${c.draft_is_stale ? '<p class="draft-stale" role="status">Старый черновик: обновите его по сценарию перед отправкой.</p>' : ''}
           <textarea class="msg-area" id="msg-${i}" rows="5" oninput="markEdited(this)">${hasDraft ? esc(c.draft_message) : ''}</textarea>
           <div class="btns">
             <button class="btn btn-send" data-stale="${c.draft_is_stale ? '1' : '0'}" onclick="sendOne(this,${i},'${esc(c.negotiation_id)}',false,this.dataset.stale==='1')"${c.draft_is_stale ? ' title="Черновик устарел — отправка потребует ручного подтверждения"' : ''}>✓ Отправить</button>
             <button class="btn-copy" onclick="copyMsg(${i})">📋 Копировать</button>
             <button class="btn btn-skip" onclick="setResponseState(this,'${esc(c.negotiation_id)}','archived')">В архив</button>
             <button class="btn btn-send-reject" onclick="rejectWithMessage(${i},'${esc(c.negotiation_id)}')">✗ Отправить отказ</button>
           </div>
         </div>`;

    const salaryNote = c.salary ? `<span class="meta"> · зп ${esc(c.salary)}</span>` : '';
    return `<div class="card" id="card-${i}" data-score="${hasScore ? (c.score || 0).toFixed(1) : '0'}" data-neg="${esc(c.negotiation_id)}" data-first-name="${esc(c.first_name)}" style="background:${bg};border-left:4px solid ${col}">
  <div class="card-header">
    <div class="card-header-left">
      ${checkboxHtml}
      <div>
        <span class="name">${nameHtml}</span>
        ${daysNote}${salaryNote}
      </div>
    </div>
    ${scoreHtml}
  </div>
  <div class="btns">
    <button class="btn" data-testid="response-star" onclick="setResponseState(this,'${esc(c.negotiation_id)}','${c.response_status === 'starred' ? 'active' : 'starred'}')">${c.response_status === 'starred' ? '★ Убрать звезду' : '☆ В избранное'}</button>
    ${c.response_status === 'archived' ? `<button class="btn" data-testid="response-restore" onclick="setResponseState(this,'${esc(c.negotiation_id)}','active')">Восстановить</button>` : ''}
    <span class="meta">Отклик: ${esc(c.created_at.slice(0,10))} · Обновление HH: ${esc(c.updated_at.slice(0,10))}${c.has_updates ? ' · Есть обновления HH' : ''}</span>
  </div>
  ${c.reasoning ? `<p class="reasoning">${esc(c.reasoning)}</p>` : ''}
  ${matched || gaps ? `<div class="tags">${matched}${gaps}</div>` : ''}
  ${histSection}
  ${resumeSection}
  ${msgSection}
</div>`;
    });
  }

  const waitingCardsHtml = buildCardsHtml(waitingCandidates);
  const silentCardsHtml = buildCardsHtml(silentCandidates);
  const noContactCardsHtml = buildCardsHtml(noContactCandidates);
  const dialogCardsHtml = buildCardsHtml(dialogCandidates);
  const postRejectCardsHtml = buildCardsHtml(repliedAfterReject);
  const allCardsHtml = buildCardsHtml(sorted);

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
${revisionMetaTag()}
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ревью кандидатов — ${esc(vacancyTitle)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f1f5f9;color:#1e293b;padding:24px 24px 96px}
h1{font-size:22px;font-weight:700;margin-bottom:4px}
.subtitle{color:#64748b;font-size:14px;margin-bottom:16px}
.toolbar{display:flex;align-items:center;gap:8px;margin-bottom:20px;flex-wrap:wrap}
.toolbar-label{font-size:13px;color:#64748b;margin-right:4px}
.tb-btn{padding:5px 12px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;background:#fff;color:#475569;transition:background .15s,color .15s}
.tb-btn:hover,.tb-btn.active{background:#4f46e5;color:#fff;border-color:#4f46e5}
.tb-sep{width:1px;height:20px;background:#e2e8f0;margin:0 4px}
.card{background:#fff;border-radius:12px;padding:20px;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,.08);transition:opacity .3s}
/* «Отправлено» — это учёт, а не мёртвая карточка: блок повторной отправки живёт
   обратным отсчётом на самой кнопке (startSendCooldown). Раньше карточка серела и
   переставала реагировать на клики — это выглядело как сломавшаяся страница. */
.card.done{opacity:.6;box-shadow:inset 3px 0 0 #16a34a}
.card.skipped{opacity:.35;pointer-events:none}
.card-header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:10px}
.card-header-left{display:flex;align-items:flex-start;gap:10px}
.card-cb,.reject-cb{width:18px;height:18px;margin-top:2px;cursor:pointer;flex-shrink:0}
.card-cb{accent-color:#4f46e5}
.reject-cb{accent-color:#dc2626}
.name{font-size:17px;font-weight:600}
.resume-link{color:inherit;text-decoration:none}
.resume-link:hover{text-decoration:underline}
.hh-link-btn{display:inline-block;margin-left:8px;padding:2px 8px;font-size:12px;font-weight:600;color:#d6001c;border:1px solid #d6001c;border-radius:4px;text-decoration:none;vertical-align:middle;opacity:.85}
.hh-link-btn:hover{opacity:1;background:#fff5f5}
.meta{font-size:12px;color:#94a3b8}
.score-wrap{display:flex;align-items:center;gap:8px;flex-shrink:0}
.score-bar{width:80px;height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden}
.score-fill{height:100%;border-radius:3px;transition:width .4s}
.score-num{font-size:14px;font-weight:600;min-width:38px}
.verdict-badge{font-size:12px;font-weight:700;color:#fff;padding:3px 8px;border-radius:99px;white-space:nowrap}
.verdict-none{font-size:12px;color:#94a3b8;font-style:italic}
.verdict-error{color:#dc2626;cursor:help}
.reasoning{font-size:13px;color:#475569;line-height:1.5;margin-bottom:10px}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.tag{font-size:12px;padding:2px 8px;border-radius:4px;font-weight:500}
.tag-ok{background:#dcfce7;color:#15803d}
.tag-gap{background:#fee2e2;color:#b91c1c}
.msg-section{border-top:1px solid #e2e8f0;padding-top:12px;margin-top:8px}
.msg-label-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.msg-label{font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.04em}
.btn-gen{font-size:11px;padding:3px 8px;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:6px;cursor:pointer;color:#475569;font-weight:500}
.btn-gen:hover:not(:disabled){background:#e2e8f0}
.btn-gen:disabled{opacity:.5;cursor:not-allowed}
.msg-area.generating{background:repeating-linear-gradient(90deg,#f1f5f9 0%,#e2e8f0 50%,#f1f5f9 100%);background-size:200% 100%;animation:shimmer 1.4s infinite linear;opacity:.7}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.msg-area{width:100%;border:1px solid #e2e8f0;border-radius:8px;padding:10px;font-size:14px;line-height:1.5;font-family:inherit;resize:vertical;min-height:80px}
.msg-area:focus{outline:none;border-color:#6366f1}
.btns{display:flex;gap:8px;margin-top:8px}
.btn{padding:8px 18px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .2s}
.btn:hover{opacity:.85}
.btn-send{background:#16a34a;color:#fff}
.btn-send[data-stale="1"]{background:#b45309}
.btn-send.cooldown{opacity:.6;cursor:progress}
.btn-send-reject{background:#dc2626;color:#fff}
.btn-skip{background:#e2e8f0;color:#475569}
.reject-note{font-size:13px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:10px;font-style:italic}
.hist-none{font-size:12px;color:#94a3b8;margin:8px 0 4px;font-style:italic}
.hist-details,.resume-details{margin:8px 0 4px}
.hist-summary,.resume-summary{font-size:12px;font-weight:600;color:#64748b;cursor:pointer;padding:4px 0;user-select:none}
.hist-thread{margin-top:8px;display:flex;flex-direction:column;gap:6px}
.hist-msg{padding:8px 10px;border-radius:8px;font-size:13px}
.hist-employer{background:#eff6ff;border-left:3px solid #3b82f6}
.hist-applicant{background:#f0fdf4;border-left:3px solid #22c55e}
.hist-who{font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-right:8px}
.hist-time{font-size:11px;color:#94a3b8}
.hist-text{margin-top:4px;white-space:pre-wrap;line-height:1.4}
.resume-text{font-size:12px;white-space:pre-wrap;font-family:inherit;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin-top:8px;line-height:1.5;max-height:300px;overflow-y:auto;color:#334155}
.footer{position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid #e2e8f0;padding:12px 24px;display:flex;align-items:center;gap:16px;box-shadow:0 -2px 8px rgba(0,0,0,.08)}
.bulk-status{position:absolute;left:0;right:0;bottom:100%;padding:10px 18px;background:#eef2ff;color:#3730a3;border-top:1px solid #c7d2fe;font-size:13px}
.counter{font-size:14px;color:#475569;flex:1}
.counter strong{color:#1e293b}
.btn-send-all{background:#4f46e5;color:#fff;padding:9px 22px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .2s}
.btn-send-all:disabled{opacity:.4;cursor:not-allowed}
.btn-send-all:not(:disabled):hover{opacity:.85}
.btn-reject-all{background:#dc2626;color:#fff;padding:9px 22px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .2s}
.btn-reject-all:disabled{opacity:.4;cursor:not-allowed}
.btn-reject-all:not(:disabled):hover{opacity:.85}
.guard-block{margin-top:10px;padding:10px 12px;border:1px solid #fca5a5;background:#fef2f2;border-radius:8px}
.guard-reason{font-size:13px;color:#b91c1c;line-height:1.4}
.guard-actions{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
.btn-guard-fix{background:#fff;border:1px solid #cbd5e1;color:#475569}
.btn-guard-force{background:#dc2626;color:#fff}
.hist-msg.just-sent{outline:2px solid #86efac}
.toast{position:fixed;top:20px;right:20px;padding:10px 18px;border-radius:8px;background:#16a34a;color:#fff;font-size:14px;font-weight:600;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,.15);animation:fadein .2s}
.toast-err{background:#dc2626}
@keyframes fadein{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}
@media(max-width:640px){
body{padding:12px 12px 100px}
h1{font-size:18px}
.card{padding:14px}
.card-header{flex-direction:column;gap:8px}
.score-wrap{flex-direction:row;align-self:flex-start}
.footer{padding:10px 12px;flex-wrap:wrap;gap:8px}
.counter{width:100%;font-size:13px}
.btn-reject-all,.btn-send-all{flex:1;padding:10px 12px;font-size:13px}
.btns{flex-wrap:wrap}
.btn{flex:1;min-width:120px;text-align:center}
.toolbar{gap:5px}
.tb-btn{padding:5px 8px;font-size:12px;min-height:36px}
.msg-area{font-size:13px}
/* Мобильный аудит #174: 6 вкладок-фильтров в один ряд давали вылет страницы на
   116px при 360 — вся навигация по откликам уезжала за экран. Переносим. */
.tabs{flex-wrap:wrap}
.tab-btn{min-height:40px}
.btn-send-all,.btn-reject-all{min-height:44px}
#regenAllBtn{flex:1 1 100%}
}
.sync-btn{background:none;border:none;color:#6366f1;font-size:13px;cursor:pointer;font-weight:500;padding:0;text-decoration:underline;text-underline-offset:2px}
.sync-btn:hover{opacity:.75}
.sync-btn:disabled{opacity:.5;cursor:not-allowed;text-decoration:none}
.vacancy-tabs{display:flex;gap:4px;margin-bottom:16px;flex-wrap:wrap}
.vacancy-tab{padding:6px 14px;border:1px solid #c7d2fe;border-radius:20px;font-size:13px;font-weight:600;text-decoration:none;color:#4f46e5;background:#eef2ff}
.vacancy-tab.active{background:#4f46e5;color:#fff;border-color:#4f46e5}
.tabs{display:flex;gap:4px;margin-bottom:20px}
.tab-btn{padding:6px 16px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;background:#fff;color:#64748b;transition:all .15s}
.tab-btn.active{background:#4f46e5;color:#fff;border-color:#4f46e5}
.tab-panel{display:none}
.tab-panel.active{display:block}
.msg-meta{font-size:12px;color:#94a3b8;margin-bottom:6px}
.draft-stale{font-size:12px;color:#9a6700;background:#fff7d6;border:1px solid #f2d675;border-radius:6px;padding:7px 9px;margin:4px 0}
.btn-copy{background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;border-radius:8px;font-size:13px;font-weight:500;padding:6px 12px;cursor:pointer}
.btn-copy:hover{background:#e2e8f0}
</style>
</head>
<body>
<h1>Кандидаты: ${esc(vacancyTitle)}</h1>
${require('./hh-nav').vacancyPickerHtml(vacancies, vacancyId, v => `?username=${encodeURIComponent(username)}&token=${pageToken}&vacancy_id=${encodeURIComponent(v.id)}`, `${callbackBase}/hh/vacancy-new?username=${encodeURIComponent(username)}&token=${pageToken}`)}
${syncError ? `<p role="alert">${esc(syncError)}</p>` : ''}
${!hasAtsConfig ? `<div id="no-ats-banner" role="alert" style="background:rgba(240,180,41,.12);border:1px solid rgba(240,180,41,.35);color:#8a5a00;border-radius:8px;padding:12px 16px;margin:12px 0;font-size:14px">
  ⚠️ Письма этой вакансии не обновляются — нет критериев оценки. Фоновая перегенерация без них не работает.
  <a href="${callbackBase}/hh/ats-editor?username=${encodeURIComponent(username)}&token=${pageToken}&vacancy_id=${encodeURIComponent(vacancyId || '')}&extract=1" style="color:#8a5a00;font-weight:600;margin-left:6px">Собрать критерии из текста вакансии</a>
  <a href="${callbackBase}/hh/ats-editor?username=${encodeURIComponent(username)}&token=${pageToken}&vacancy_id=${encodeURIComponent(vacancyId || '')}" style="color:#8a5a00;font-weight:600">Открыть редактор →</a>
</div>` : ''}
<nav class="vacancy-tabs" aria-label="Статус отклика">${[['active','Активные'],['starred','★ Избранные'],['archived','Архив']].map(([status,label]) => `<a class="vacancy-tab${status === listView ? ' active' : ''}" href="?username=${encodeURIComponent(username)}&token=${pageToken}&vacancy_id=${encodeURIComponent(vacancyId || '')}&list=${status}">${label} (${counts[status]})</a>`).join('')}</nav>
<p class="subtitle">${sorted.length} откликов · ${waitingCandidates.length} ждут ответа${ageText ? ` · обновлено ${ageText}` : ''}${scoredText ? ` · ${scoredText}` : ''} · <button class="sync-btn" id="syncBtn" onclick="syncNow()" title="Загрузить актуальные отклики и сообщения из HH; черновики не генерируются">↻ Синхронизировать отклики</button></p>
<p id="responseUpdates" role="status" aria-live="polite"></p>
<div class="toolbar">
  <span class="toolbar-label" id="bucketLabel">Выбрать по баллу (округление до целого):</span>
  <button class="tb-btn score-btn" data-bucket="10" onclick="toggleBucket(10)" title="Выбрать со скором 10" aria-label="Выбрать со скором 10">10</button>
  <button class="tb-btn score-btn" data-bucket="9" onclick="toggleBucket(9)" title="Выбрать со скором 9" aria-label="Выбрать со скором 9">9</button>
  <button class="tb-btn score-btn" data-bucket="8" onclick="toggleBucket(8)" title="Выбрать со скором 8" aria-label="Выбрать со скором 8">8</button>
  <button class="tb-btn score-btn" data-bucket="7" onclick="toggleBucket(7)" title="Выбрать со скором 7" aria-label="Выбрать со скором 7">7</button>
  <button class="tb-btn score-btn" data-bucket="6" onclick="toggleBucket(6)" title="Выбрать со скором 6" aria-label="Выбрать со скором 6">6</button>
  <button class="tb-btn score-btn" data-bucket="5" onclick="toggleBucket(5)" title="Выбрать со скором 5" aria-label="Выбрать со скором 5">5</button>
  <button class="tb-btn score-btn" data-bucket="4" onclick="toggleBucket(4)" title="Выбрать со скором 4" aria-label="Выбрать со скором 4">4</button>
  <button class="tb-btn score-btn" data-bucket="3" onclick="toggleBucket(3)" title="Выбрать со скором 3" aria-label="Выбрать со скором 3">3</button>
  <button class="tb-btn score-btn" data-bucket="2" onclick="toggleBucket(2)" title="Выбрать со скором 2" aria-label="Выбрать со скором 2">2</button>
  <button class="tb-btn score-btn" data-bucket="1" onclick="toggleBucket(1)" title="Выбрать со скором 1" aria-label="Выбрать со скором 1">1</button>
  <div class="tb-sep"></div>
  <button class="tb-btn" onclick="selectAll(true)" title="Отметить всех на этой вкладке к отправке">✓ Выбрать все</button>
  <button class="tb-btn" onclick="selectAll(false)">✗ Снять все</button>
  <div class="tb-sep"></div>
  <button class="tb-btn tb-danger" id="selectRejectAllBtn" onclick="selectRejectAll()" title="Отметить всех на этой вкладке к отказу">🚫 Отказать все</button>
</div>
<div class="tabs">
  <button class="tab-btn" onclick="switchTab('waiting',this)">🔴 Неотвеченные (${waitingCandidates.length})</button>
  <button class="tab-btn" onclick="switchTab('silent',this)">😴 Молчат (${silentCandidates.length})</button>
  <button class="tab-btn" onclick="switchTab('nocontact',this)">📭 Ещё не писали (${noContactCandidates.length})</button>
  <button class="tab-btn" onclick="switchTab('dialog',this)">💬 Диалог (${dialogCandidates.length})</button>
  ${repliedAfterReject.length ? `<button class="tab-btn" onclick="switchTab('postreject',this)">↩️ Ответили после отказа (${repliedAfterReject.length})</button>` : ''}
  <button class="tab-btn active" onclick="switchTab('all',this)">📨 Все (${sorted.length})</button>
</div>
<div id="tab-waiting" class="tab-panel">
  ${waitingCardsHtml.length === 0 ? '<p style="color:#94a3b8;padding:24px;text-align:center">Все отвечено — нет кандидатов, ожидающих ответа.</p>' : waitingCardsHtml.join('')}
</div>
<div id="tab-silent" class="tab-panel">
  ${silentCardsHtml.length === 0 ? '<p style="color:#94a3b8;padding:24px;text-align:center">Нет кандидатов, которым написали но они не ответили.</p>' : silentCardsHtml.join('')}
</div>
<div id="tab-nocontact" class="tab-panel">
  ${noContactCardsHtml.length === 0 ? '<p style="color:#94a3b8;padding:24px;text-align:center">Всем кандидатам уже написали.</p>' : noContactCardsHtml.join('')}
</div>
<div id="tab-dialog" class="tab-panel">
  ${dialogCardsHtml.length === 0 ? '<p style="color:#94a3b8;padding:24px;text-align:center">Нет активных диалогов без ожидающих ответов.</p>' : dialogCardsHtml.join('')}
</div>
${repliedAfterReject.length ? `<div id="tab-postreject" class="tab-panel">
  ${postRejectCardsHtml.join('')}
</div>` : ''}
<div id="tab-all" class="tab-panel active">
  ${allCardsHtml.join('')}
</div>
<div class="footer">
  <div class="counter" id="bulkScopeHint">Массовые действия — только на открытой вкладке: Отправить <strong id="selCount">0</strong> · Отказать <strong id="rejCount">0</strong> · Готово (все вкладки): <strong id="sentCount">0</strong></div>
  <div class="bulk-status" id="bulkGenerationStatus" role="status" aria-live="polite" hidden></div>
  <button class="btn-reject-all" id="regenRetryFailedBtn" onclick="retryFailedRegeneration()" hidden>Повторить ошибки</button>
  <button class="btn-reject-all" id="regenAllBtn" onclick="regenerateAll()" title="Перегенерировать черновики на открытой вкладке; отредактированные вручную не трогаются">🔄 Перегенерировать черновики</button>
  <button class="btn-reject-all" id="rejectAllBtn" onclick="rejectAll()" disabled title="Отказать отмеченным на открытой вкладке">Отказать (0) на вкладке</button>
  <button class="btn-send-all" id="sendAllBtn" onclick="sendAll()" disabled title="Отправить отмеченным на открытой вкладке">Отправить (0) на вкладке</button>
</div>
<script>
const CALLBACK_BASE = '${callbackBase}';
const HH_USER = '${esc(username)}';
const HH_VACANCY_ID = '${esc(String(vacancyId || ''))}';
const HH_PAGE_TOKEN = '${pageToken}';
const REJECTION_GREETING = ${JSON.stringify(REJECTION_GREETING)};
const done = new Set();
let bulkGenerationActive = false;
let bulkJobPolling = false;
async function checkResponseUpdates() {
  if (document.hidden) return;
  try {
    const q = new URLSearchParams({ username: HH_USER, token: HH_PAGE_TOKEN, vacancy_id: HH_VACANCY_ID });
    const r = await fetch(CALLBACK_BASE + '/hh/response-updates?' + q);
    if (!r.ok) throw new Error('sync status unavailable');
    const data = await r.json();
    if (data.synced_at > ${Number(syncedAt) || 0}) document.getElementById('responseUpdates').textContent = 'В HH появились изменения. Синхронизируйте отклики; черновики обновляются отдельно кнопкой «Перегенерировать все черновики».';
  } catch { document.getElementById('responseUpdates').textContent = 'Не удалось проверить обновления HH. Синхронизируйте отклики для повтора.'; }
}
setInterval(checkResponseUpdates, 60000);
async function setResponseState(btn, negId, status) {
  btn.disabled = true;
  try {
    const r = await fetch(CALLBACK_BASE + '/hh/response-state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: HH_USER, token: HH_PAGE_TOKEN, vacancy_id: HH_VACANCY_ID, negotiation_id: negId, status }) });
    if (!r.ok) throw new Error('Не удалось сохранить статус');
    location.reload();
  } catch (e) { btn.disabled = false; showToast(e.message, true); }
}

function switchTab(id, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + id).classList.add('active');
  btn.classList.add('active');
  onCheck();
}

function copyMsg(i) {
  const ta = document.getElementById('msg-' + i);
  if (!ta) return;
  navigator.clipboard.writeText(ta.value).then(() => showToast('📋 Скопировано')).catch(() => {
    ta.select(); document.execCommand('copy'); showToast('📋 Скопировано');
  });
}

async function syncNow() {
  if (bulkGenerationActive) { showToast('⏳ Дождитесь завершения перегенерации черновиков.', true); return; }
  const btn = document.getElementById('syncBtn');
  btn.disabled = true; btn.textContent = '↻ Обновляю…';
  try {
    const r = await fetch(CALLBACK_BASE + '/hh/sync-negotiations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: HH_USER, vacancy_id: HH_VACANCY_ID, token: HH_PAGE_TOKEN }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error || ('HTTP ' + r.status));
    }
    location.reload();
  } catch(e) {
    showToast('❌ Ошибка обновления: ' + e.message, true);
    btn.disabled = false; btn.textContent = '↻ Синхронизировать отклики';
  }
}

function plural(n, forms) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}
function showToast(msg, isError) {
  const t = document.createElement('div');
  t.className = 'toast' + (isError ? ' toast-err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}


// Every POST gets a client-side deadline. Before, only /hh/send-and-reject had one:
// /hh/send could sit on "⏳" for as long as the server took (guard LLM call + HH POST),
// with no way to tell "still working" from "hung" — that read as a frozen page.
window.HH_ACTION_TIMEOUT_MS = 45000;
window.HH_GENERATION_TIMEOUT_MS = 210000;

async function hhAction(endpoint, payload, timeoutMs) {
  const deadline = timeoutMs || window.HH_ACTION_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadline);
  try {
    const r = await fetch(CALLBACK_BASE + endpoint, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: HH_USER, token: HH_PAGE_TOKEN, ...payload }),
    });
    const data = await r.json();
    if (!r.ok) { const error = new Error(data.error || r.statusText); error.code = data.code; error.communication_stage = data.communication_stage; error.request_id = data.request_id; error.missing_fields = Array.isArray(data.missing_fields) ? data.missing_fields : []; throw error; }
    return data;
  } catch(e) {
    if (e.name === 'AbortError') {
      if(endpoint === '/hh/generate-message')throw new Error('Подготовка черновика не завершилась за ' + Math.round(deadline / 1000) + ' с. Сообщение кандидату не отправлялось. Попробуйте обновить черновик.');
      throw new Error('Ответ HH не пришёл за ' + Math.round(deadline / 1000) + ' c. Запрос мог выполниться — проверьте переписку на HH перед повтором.');
    }
    if (e instanceof TypeError || e instanceof SyntaxError) {
      if(endpoint === '/hh/generate-message')throw new Error('Не удалось получить черновик. Сообщение кандидату не отправлялось. Попробуйте обновить черновик.');
      throw new Error('Не удалось получить подтверждение. Запрос мог выполниться — проверьте переписку и статус на HH перед повтором.');
    }
    throw e;
  } finally { clearTimeout(timer); }
}

// Live "we are actually waiting" signal: the button counts seconds instead of
// sitting on a static ⏳, so a slow guard check never looks like a hung page.
function startSendClock(btn, label) {
  if (!btn) return () => {};
  const t0 = Date.now();
  btn.dataset.baseLabel = label || btn.dataset.baseLabel || btn.textContent;
  const base = btn.dataset.baseLabel;
  btn.textContent = base + ' 0с';
  const id = setInterval(() => {
    btn.textContent = base + ' ' + Math.round((Date.now() - t0) / 1000) + 'с';
  }, 1000);
  return () => clearInterval(id);
}

// Блок повторной отправки после доставки: HH не дедуплицирует письма, поэтому второй
// клик отправляет кандидату дубль. Блок ВИДИМЫЙ — обратный отсчёт на кнопке, — и ровно
// на 15 секунд. Раньше защита была другой и противоречивой: карточка серала и
// блокировалась целиком (выглядело как зависшая страница), а блок finally всё равно
// включал кнопку сразу после успеха, так что отправка всё ещё проходила дважды.
const SEND_COOLDOWN_MS = 15000;
window.HH_SEND_COOLDOWN_MS = window.HH_SEND_COOLDOWN_MS || SEND_COOLDOWN_MS;

const sendCooldowns = new Map();
function startSendCooldown(btn, i) {
  if (!btn) return;
  const prev = sendCooldowns.get(i);
  if (prev) { clearInterval(prev); sendCooldowns.delete(i); }
  const until = Date.now() + (Number(window.HH_SEND_COOLDOWN_MS) || SEND_COOLDOWN_MS);
  btn.classList.add('cooldown');
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(sendCooldowns.get(i));
      sendCooldowns.delete(i);
      btn.disabled = false;
      btn.classList.remove('cooldown');
      btn.textContent = '✓ Отправить';
      return;
    }
    btn.disabled = true;
    btn.textContent = '✓ Отправлено · ' + left + 'с';
  };
  sendCooldowns.set(i, setInterval(tick, 250));
  tick();
}

function activeTabLabel() {
  const btn = document.querySelector('.tab-btn.active');
  return btn ? btn.textContent.trim() : 'открытой вкладке';
}
function markEdited(target) {
  const ta = typeof target === 'number' ? document.getElementById('msg-' + target) : target;
  if (ta) ta.dataset.edited = '1';
}
function isHandEdited(i) {
  const textarea = typeof i === 'number'
    ? document.getElementById('msg-' + i)
    : i?.closest?.('.card')?.querySelector('.msg-area');
  return textarea?.dataset?.edited === '1';
}

function onCheck() {
  const ns = document.querySelectorAll('.tab-panel.active .card-cb:checked').length;
  const nr = document.querySelectorAll('.tab-panel.active .reject-cb:checked').length;
  document.getElementById('selCount').textContent = ns;
  document.getElementById('rejCount').textContent = nr;
  const sb = document.getElementById('sendAllBtn');
  sb.textContent = 'Отправить (' + ns + ') на вкладке'; sb.disabled = ns === 0;
  const rb = document.getElementById('rejectAllBtn');
  rb.textContent = 'Отказать (' + nr + ') на вкладке'; rb.disabled = nr === 0;
}

const activeBuckets = new Set();
function toggleBucket(n) {
  const btn = document.querySelector('.score-btn[data-bucket="'+n+'"]');
  if (activeBuckets.has(n)) { activeBuckets.delete(n); btn.classList.remove('active'); }
  else { activeBuckets.add(n); btn.classList.add('active'); }
  document.querySelectorAll('.tab-panel.active .card-cb').forEach(cb => {
    if (done.has(parseInt(cb.dataset.idx)) || cb.disabled) return;
    const bucket = Math.round(parseFloat(cb.dataset.score || 0));
    if (bucket === n) cb.checked = activeBuckets.has(n);
  });
  onCheck();
}

function selectAll(checked) {
  document.querySelectorAll('.tab-panel.active .card-cb').forEach(cb => {
    if (!done.has(parseInt(cb.dataset.idx)) && !cb.disabled) cb.checked = checked;
  });
  activeBuckets.clear();
  document.querySelectorAll('.score-btn').forEach(b => b.classList.remove('active'));
  onCheck();
}

// Symmetric to «Выбрать все», but selecting is already an outward-facing
// decision (a rejection letter leaves for each checked card), so it asks first
// and reports the scope. Unchecking stays silent — it withdraws the intent.
function selectRejectAll() {
  const cbs = [...document.querySelectorAll('.tab-panel.active .reject-cb')]
    .filter(cb => !done.has(parseInt(cb.dataset.idx)) && !cb.disabled);
  if (!cbs.length) { showToast('На «' + activeTabLabel() + '» нет активных кандидатов'); return; }
  const already = cbs.filter(cb => cb.checked).length;
  if (already === cbs.length) { cbs.forEach(cb => { cb.checked = false; }); onCheck(); showToast('Отметки к отказу сняты'); return; }
  if (!window.confirm('Отметить ' + cbs.length + ' кандидатов на вкладке «' + activeTabLabel() + '» к отказу?\\n\\nПисьма об отказе ещё не отправлены — они уйдут только после подтверждения кнопкой «Отказать (N) на вкладке».')) return;
  cbs.forEach(cb => { cb.checked = true; });
  onCheck();
}

function markDone(i) {
  const negId = document.getElementById('card-'+i).dataset.neg;
  document.querySelectorAll('.card').forEach(card => {
    if (card.dataset.neg !== negId) return;
    done.add(Number(card.id.slice(5)));
    card.classList.add('done');
    card.querySelectorAll('input[type=checkbox], button').forEach(el => { el.checked = false; el.disabled = true; });
  });
  document.getElementById('sentCount').textContent = new Set([...document.querySelectorAll('.card.done')].map(card => card.dataset.neg)).size;
}

async function regenerateAll() {
  const btn = document.getElementById('regenAllBtn');
  const candidates = Array.from(document.querySelectorAll('.tab-panel.active .btn-gen[data-negid]'))
    .filter(b => !b.disabled && !done.has(parseInt(b.dataset.idx)));
  const handEdited = candidates.filter(b => isHandEdited(b));
  const targets = candidates.filter(b => !isHandEdited(b));
  if (!targets.length) { showToast(handEdited.length ? 'Все черновики на вкладке отредактированы вручную — они не перезаписываются' : 'Нечего перегенерировать'); return; }
  if (!window.confirm('Поставить в серверную очередь ' + targets.length + ' ' + plural(targets.length, ['черновик', 'черновика', 'черновиков'])
    + ' на вкладке «' + activeTabLabel() + '»? Тексты будут заменены целиком.'
    + (handEdited.length ? '\\n\\n' + handEdited.length + ' ' + plural(handEdited.length, ['черновик', 'черновика', 'черновиков']) + ' с ручной правкой останутся нетронутыми.' : ''))) return;
  const saved = { request_key: makeRegenerationRequestKey(), vacancy_id: HH_VACANCY_ID,
    negotiation_ids: targets.map(b => b.dataset.negid), revision: 0 };
  targets.forEach(b => setRegenerationCardState(b.dataset.negid, 'queued'));
  saveRegenerationState(saved);
  try {
    const started = await hhAction('/hh/review-regeneration-start', {
      vacancy_id: saved.vacancy_id, request_key: saved.request_key, negotiation_ids: saved.negotiation_ids,
    });
    saved.job_id = started.job_id;
    saveRegenerationState(saved);
    await pollRegenerationJob(saved);
  } catch (e) {
    targets.forEach(b => setRegenerationCardState(b.dataset.negid, 'failed', e.message));
    bulkGenerationActive = false;
    showToast('❌ Не удалось поставить черновики в очередь: ' + e.message, true);
  }
}

function regenerationStorageKey() { return 'hh-review-regeneration:' + HH_USER + ':' + HH_VACANCY_ID; }
function makeRegenerationRequestKey() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}
function saveRegenerationState(saved) {
  try { localStorage.setItem(regenerationStorageKey(), JSON.stringify(saved)); } catch { /* optional resume hint */ }
}
function queueEta(job) {
  const pending = (job.counts?.queued || 0) + (job.counts?.running || 0);
  if (!pending) return '';
  const mean = job.average_duration_ms || 60000;
  const minutes = Math.max(1, Math.ceil(pending * mean / Math.max(1, job.concurrency || 3) / 60000));
  return ' · осталось около ' + minutes + ' мин';
}
function setRegenerationCardState(negId, state, error, message, action) {
  document.querySelectorAll('.card').forEach(card => {
    if (card.dataset.neg !== negId) return;
    const i = Number(card.id.slice(5));
    const textarea = card.querySelector('.msg-area');
    const gen = card.querySelector('.btn-gen');
    const busy = state === 'queued' || state === 'running';
    if (textarea) textarea.disabled = busy;
    if (gen) { gen.disabled = busy; gen.textContent = busy ? (state === 'running' ? '⏳ Генерируется' : 'В очереди') : '✦ Переписать'; }
    card.querySelectorAll('.btn-send, .card-cb, .reject-cb, .btn-send-reject').forEach(el => { el.disabled = busy || done.has(i); });
    const step = card.querySelector('.funnel-step');
    if (step && busy) step.textContent = state === 'running' ? '⏳ Черновик генерируется на сервере…' : 'В очереди на перегенерацию';
    if (step && error) { step.style.color = '#b91c1c'; step.setAttribute('role', 'alert'); step.textContent = 'Ошибка обновления черновика: ' + error; }
    if (state === 'succeeded') {
      if (textarea && !textarea.dataset.edited) textarea.value = message || '';
      card.querySelector('.draft-stale')?.remove();
      if (step) { step.style.color = ''; step.removeAttribute('role'); step.textContent = action ? 'Шаг воронки: ' + action : ''; }
      const send = card.querySelector('.btn-send');
      if (send) { send.dataset.stale = '0'; send.removeAttribute('title'); send.disabled = false; }
      const checkbox = card.querySelector('.card-cb');
      if (checkbox) {
        checkbox.dataset.stale = '0';
        const bucket = Math.round(parseFloat(checkbox.dataset.score || '0'));
        checkbox.checked = activeBuckets.has(bucket) || (!activeBuckets.size && checkbox.dataset.autoSelect === '1');
        checkbox.disabled = false;
      }
      const rejectCheckbox = card.querySelector('.reject-cb'); if (rejectCheckbox) rejectCheckbox.disabled = false;
      const rejectButton = card.querySelector('.btn-send-reject'); if (rejectButton) rejectButton.disabled = false;
    }
    if (state === 'failed') {
      if (textarea) textarea.disabled = false;
      if (gen) gen.disabled = false;
      card.querySelectorAll('.btn-send, .card-cb, .reject-cb, .btn-send-reject').forEach(el => { el.disabled = false; });
    }
    if (busy) bulkGenerationActive = true;
  });
}

async function pollRegenerationJob(saved) {
  if (bulkJobPolling) return;
  bulkJobPolling = true;
  const key = regenerationStorageKey();
  const status = document.getElementById('bulkGenerationStatus');
  const retry = document.getElementById('regenRetryFailedBtn');
  const btn = document.getElementById('regenAllBtn');
  bulkGenerationActive = true;
  if (btn) btn.disabled = true;
  if (retry) retry.hidden = true;
  try {
    if (!saved.job_id) {
      const started = await hhAction('/hh/review-regeneration-start', {
        vacancy_id: saved.vacancy_id, request_key: saved.request_key, negotiation_ids: saved.negotiation_ids,
      });
      saved.job_id = started.job_id;
    }
    let terminal = false;
    while (!terminal) {
      const query = new URLSearchParams({ username: HH_USER, token: HH_PAGE_TOKEN,
        job_id: saved.job_id, after: String(saved.revision || 0) });
      const response = await fetch(CALLBACK_BASE + '/hh/review-regeneration-status?' + query);
      const job = await response.json();
      if (!response.ok) throw new Error(job.error || 'Не удалось прочитать состояние очереди');
      for (const item of job.changes || []) setRegenerationCardState(item.negotiation_id, item.status, item.error, item.message, item.funnel_action);
      saved.revision = job.revision;
      saved.job_id = job.id;
      saveRegenerationState(saved);
      const complete = (job.counts?.succeeded || 0) + (job.counts?.failed || 0);
      const failed = job.counts?.failed || 0;
      const running = job.counts?.running || 0;
      if (status) {
        status.hidden = false;
        status.textContent = ['completed', 'completed_with_errors'].includes(job.status)
          ? 'Перегенерация завершена: ' + (job.counts?.succeeded || 0) + '/' + job.total + ' успешно · ошибок ' + failed + '.'
          : 'Серверная очередь: ' + complete + '/' + job.total + ' готово · ' + running + ' выполняется' + queueEta(job) + '. Можно закрыть страницу; очередь продолжит работу.';
      }
      terminal = ['completed', 'completed_with_errors'].includes(job.status);
      if (terminal && failed && retry) retry.hidden = false;
      if (!terminal) await new Promise(resolve => setTimeout(resolve, 3000));
    }
  } catch (e) {
    if (status) { status.hidden = false; status.textContent = 'Не удалось получить состояние очереди: ' + e.message + '. Задача сохранена; обновите страницу для продолжения.'; }
    showToast('⚠️ Очередь сохранена на сервере. Состояние можно восстановить, обновив страницу.', true);
  } finally {
    bulkJobPolling = false;
    bulkGenerationActive = false;
    if (btn) btn.disabled = false;
  }
}

async function retryFailedRegeneration() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(regenerationStorageKey()) || 'null'); } catch { saved = null; }
  if (!saved?.job_id) return showToast('Не найдена сохранённая задача для повтора.', true);
  try {
    await hhAction('/hh/review-regeneration-retry', { job_id: saved.job_id });
    saved.revision = 0;
    saveRegenerationState(saved);
    await pollRegenerationJob(saved);
  } catch (e) { showToast('❌ Не удалось поставить ошибки на повтор: ' + e.message, true); }
}

async function resumeRegenerationJob() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(regenerationStorageKey()) || 'null'); } catch { saved = null; }
  if (saved?.vacancy_id === HH_VACANCY_ID && (saved.job_id || (saved.request_key && saved.negotiation_ids?.length))) {
    await pollRegenerationJob(saved);
  }
}

async function generateOne(i, negId, candidateName, alreadySent) {
  const btn = document.getElementById('gen-'+i);
  const ta = document.getElementById('msg-'+i);
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Подготовка…'; }
  const startedAt=Date.now();
  if (ta) { ta.classList.add('generating'); ta.placeholder = 'Изучаем диалог и готовим следующий шаг. Это может занять до 3,5 минут.'; }
  const progressTimer=setInterval(()=>{if(btn)btn.textContent='⏳ Подготовка · '+Math.floor((Date.now()-startedAt)/1000)+' с';},1000);
  try {
    const resumeEl = document.querySelector('#card-'+i+' pre.resume-text');
    const resumeText = resumeEl?.textContent || '';
    const data = await hhAction('/hh/generate-message', {
      negotiation_id: negId,
      candidate_name: candidateName,
      resume_text: resumeText,
      already_sent: alreadySent,
      // Without this the route falls back to the legacy singleton config — on a
      // multi-vacancy profile that is another vacancy's criteria and no test task.
      vacancy_id: HH_VACANCY_ID || null,
    }, window.HH_GENERATION_TIMEOUT_MS);
    const card=document.getElementById('card-'+i);
    if(card?.querySelector('.draft-stale')&&!data.communication_steps) throw new Error('Сценарий не подтвердил обновление черновика. Старый текст оставлен без изменений.');
    if (ta) { ta.value = data.message || ''; ta.classList.remove('generating'); ta.placeholder = ''; delete ta.dataset?.edited; }
    const step = document.querySelector('#card-'+i+' .funnel-step');
    if (step) { step.style.color='';step.removeAttribute('role');step.textContent = data.funnel_action
      ? 'Шаг воронки: ' + data.funnel_action + (data.funnel_reason ? ' — ' + data.funnel_reason : '')
      : ''; }
    card?.querySelector('.draft-stale')?.remove();
    const sendBtn=card?.querySelector('.btn-send');if(sendBtn)sendBtn.disabled=false;
    const sendSelection=card?.querySelector('.card-cb');
    if(sendSelection){const bucket=Math.round(parseFloat(sendSelection.dataset.score||'0'));sendSelection.dataset.stale='0';sendSelection.disabled=false;sendSelection.checked=activeBuckets.has(bucket)||(!activeBuckets.size&&sendSelection.dataset.autoSelect==='1');onCheck();}
    if(data.communication_steps){
      const panel=document.querySelector('#card-'+i+' .communication-review');
      if(panel){
        panel.replaceChildren();
        const details=document.createElement('details'),summary=document.createElement('summary');
        summary.textContent='Состояние и следующий шаг';details.append(summary);
        for(const text of [data.communication_steps.state?.state?.summary,data.communication_steps.goal?.reason,data.communication_steps.goal?.goal?.instruction]){
          if(text){const p=document.createElement('p');p.textContent=text;details.append(p);}
        }
        panel.append(details);
      }
    }
    if (btn) { btn.disabled = false; btn.textContent = '✦ Переписать'; }
    if (data.guard_warning) showToast('⚠️ Черновик после перегенерации всё ещё под вопросом: ' + data.guard_warning, true);
    // No ATS criteria for this vacancy: the letter was written and saved, but the
    // background loop will not refresh it until criteria exist (issue #126). Say so
    // instead of letting the recruiter discover the staleness a week later.
    if (data.no_ats_config) {
      showToast('⚠️ Критерии оценки не заданы — письмо сохранено, но фон обновлять его не будет. Заполни ATS воронку.', true);
      const banner = document.getElementById('no-ats-banner');
      if (banner) banner.hidden = false;
    }
    return true;
  } catch(e) {
    if (ta) { ta.classList.remove('generating'); ta.placeholder = ''; }
    if (btn) { btn.disabled = false; btn.textContent = '✦ Сгенерировать'; }
    // The failure used to be swallowed here: the button simply reset and the
    // recruiter read it as "nothing changed" (issue #126, defect 2).
    const missingContext=Array.isArray(e?.missing_fields)&&e.missing_fields.length?' Не хватает подтверждённого контекста: '+e.missing_fields.join('; ')+'.':'';
    const diagnostic=[e?.communication_stage?'этап: '+e.communication_stage:'',e?.request_id?'ID: '+e.request_id:''].filter(Boolean);
    const errorMessage = (e && e.message ? e.message : String(e)) + missingContext + (diagnostic.length?' ('+diagnostic.join(', ')+')':'');
    const step = document.querySelector('#card-'+i+' .funnel-step');
    if (step) { step.style.color='#b91c1c';step.setAttribute('role','alert');step.textContent = 'Ошибка обновления черновика: ' + errorMessage; }
    if (!bulkGenerationActive) showToast('❌ Ошибка генерации: ' + errorMessage, true);
    return false;
  } finally { clearInterval(progressTimer); }
}

function generateRejection(i) {
  const ta = document.getElementById('msg-' + i);
  if (ta) ta.value = standardRejection(i);
}

const rejecting = new Set();
function rejectionStatus(negId, text, busy) {
  document.querySelectorAll('.card').forEach(card => {
    if (card.dataset.neg !== negId) return;
    let status = card.querySelector('.rejection-status');
    if (!status) {
      status = document.createElement('p');
      status.className = 'rejection-status';
      status.setAttribute('role', 'status');
      card.appendChild(status);
    }
    status.textContent = text;
    card.querySelectorAll('button, input[type=checkbox], textarea').forEach(el => {
      el.disabled = busy || card.classList.contains('done');
      if (busy && el.type === 'checkbox') el.checked = false;
    });
  });
}

async function sendAndRejectOne(i, negId, force) {
  if (done.has(i) || rejecting.has(negId)) return;
  const msg = document.getElementById('msg-'+i)?.value || '';
  if (!msg.trim()) return;
  rejecting.add(negId);
  rejectionStatus(negId, '⏳ Отправляем отказ. Дождитесь результата…', true);
  onCheck();
  try {
    const data = await hhAction('/hh/send-and-reject', { negotiation_id: negId, message: msg, force: !!force });
    if (data.blocked) {
      rejecting.delete(negId);
      rejectionStatus(negId, 'Отказ не отправлен: ' + (data.reason || 'сообщение заблокировано'), false);
      showGuardBlock(i, negId, data.reason, 'reject');
      showToast('🚫 Guard остановил отказ — исправьте текст или отправьте принудительно', true);
      return;
    }
    if (!data.ok) throw new Error(data.error || 'Результат отказа не подтверждён. Проверьте HH перед повтором.');
    insertSentMessage(i, msg);
    markDone(i); onCheck();
    rejectionStatus(negId, '✅ Сообщение отправлено. Кандидат переведён в отказ на HH.', true);
  } catch(e) {
    rejectionStatus(negId, '⚠️ ' + e.message, false);
  } finally {
    rejecting.delete(negId);
  }
}

async function autoGenerate() {
  const allGenBtns = [...document.querySelectorAll('[id^="gen-"]')];
  const emptyBtns = allGenBtns.filter(btn => {
    const i = btn.id.replace('gen-', '');
    const ta = document.getElementById('msg-'+i);
    return ta && !ta.value.trim();
  });
  if (emptyBtns.length === 0) return;
  const CONCURRENCY = 4;
  let idx = 0;
  async function worker() {
    while (idx < emptyBtns.length) {
      const btn = emptyBtns[idx++];
      btn.click();
      await new Promise(r => setTimeout(r, 50));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, emptyBtns.length) }, worker));
}

// A guard block is a normal outcome, not a crash: show it inline on the card with both
// ways out (fix the text / send anyway). The native confirm() it replaced froze the
// whole page and left the button stuck on "⏳..." — the recruiter saw nothing happen
// and no message on HH, which is what got reported as "interface hangs".
function showGuardBlock(i, negId, reason, mode) {
  hideGuardBlock(i);
  const card = document.getElementById('card-' + i);
  if (!card) return;
  const panel = document.createElement('div');
  panel.className = 'guard-block';
  panel.id = 'guard-' + i;
  panel.dataset.mode = mode || 'send';
  // Built with DOM calls, not innerHTML + inline onclick: the negId/quoting round-trip
  // through a template literal is exactly where a button silently disappears.
  const reasonEl = document.createElement('div');
  reasonEl.className = 'guard-reason';
  reasonEl.textContent = '\u{1F6AB} Guard: ' + (reason || 'сообщение заблокировано');
  const actions = document.createElement('div');
  actions.className = 'guard-actions';
  const fixBtn = document.createElement('button');
  fixBtn.className = 'btn btn-guard-fix';
  fixBtn.type = 'button';
  fixBtn.textContent = 'Исправить текст';
  fixBtn.addEventListener('click', () => editAfterGuard(i));
  const forceBtn = document.createElement('button');
  forceBtn.className = 'btn btn-guard-force';
  forceBtn.type = 'button';
  forceBtn.textContent = 'Всё равно отправить';
  forceBtn.addEventListener('click', () => forceSend(i));
  actions.append(fixBtn, forceBtn);
  panel.append(reasonEl, actions);
  const area = document.getElementById('msg-' + i);
  (area?.closest('.msg-section') || card).appendChild(panel);
}

function hideGuardBlock(i) { document.getElementById('guard-' + i)?.remove(); }

function editAfterGuard(i) {
  hideGuardBlock(i);
  const ta = document.getElementById('msg-' + i);
  if (!ta) return;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.scrollIntoView({ block: 'center' });
  showToast('Поправьте текст и отправьте снова');
}

function forceSend(i) {
  const panel = document.getElementById('guard-' + i);
  const mode = panel?.dataset.mode || 'send';
  const negId = document.getElementById('card-' + i)?.dataset.neg || '';
  hideGuardBlock(i);
  if (mode === 'reject') return sendAndRejectOne(i, negId, true);
  return sendOne(document.querySelector('#card-' + i + ' .btn-send'), i, negId, true);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Optimistic insert: the delivered message shows up in the card's dialogue thread and
// in the «N от нас» counter right away. Before, the page only greyed the card out and
// the recruiter had to reload (and even then saw the message twice — a duplicate-write
// bug, fixed in src/hh-history.js).
function insertSentMessage(i, text) {
  const card = document.getElementById('card-' + i);
  if (!card) return;
  const bubble = document.createElement('div');
  bubble.className = 'hist-msg hist-employer just-sent';
  const stamp = new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  bubble.innerHTML = '<span class="hist-who">Рекрутер</span><span class="hist-time">' + escapeHtml(stamp) + '</span>'
    + '<div class="hist-text">' + escapeHtml(text) + '</div>';
  const details = card.querySelector('details.hist-details');
  if (details) {
    const thread = details.querySelector('.hist-thread');
    if (thread) { thread.appendChild(bubble); details.open = true; }
    const sum = details.querySelector('.hist-summary');
    if (sum) { const n = (details.querySelectorAll('.hist-msg').length); sum.textContent = '📨 История диалога (' + n + ' сообщ.)'; }
  } else {
    const placeholder = card.querySelector('.hist-none');
    const wrap = document.createElement('details');
    wrap.className = 'hist-details';
    wrap.open = true;
    wrap.innerHTML = '<summary class="hist-summary">📨 История диалога (1 сообщ.)</summary>';
    const thread = document.createElement('div');
    thread.className = 'hist-thread';
    wrap.appendChild(thread);
    thread.appendChild(bubble);
    if (placeholder) placeholder.replaceWith(wrap); else card.querySelector('.msg-section')?.before(wrap);
  }
  const meta = card.querySelector('.msg-meta');
  if (meta) {
    // NOTE: this script is emitted through a JS template literal — every backslash in a
    // regex must be doubled here, or \d silently becomes a literal 'd' in the page.
    meta.textContent = meta.textContent.replace(/(\\d+)\\s+от нас/, (all, n) => (Number(n) + 1) + ' от нас') + ' · ✅ отправлено только что';
  }
}

// btn is passed in from the click handler on purpose: the old version read the global
// window.event, which is undefined on the forced re-send path — the button then stayed
// disabled with a "⏳..." label for the rest of the session.
async function sendOne(btn, i, negId, force, forceStale) {
  const msg = document.getElementById('msg-'+i)?.value || '';
  if (!msg) { showToast('Сообщение пустое', true); return; }
  if (forceStale && !window.confirm('Сценарий или диалог изменился после создания черновика. Отправить этот текст вручную только выбранному кандидату?')) return;
  hideGuardBlock(i);
  const stopClock = startSendClock(btn, '⏳ Проверка и отправка');
  if (btn) btn.disabled = true;
  let sent = false;
  try {
    let data;
    try {
      data = await hhAction('/hh/send', { negotiation_id: negId, message: msg, force: !!force, force_stale: !!forceStale });
    } catch(e) {
      // The list view can miss a freshness change that the authoritative send
      // route catches. Ask for an explicit one-candidate override, then retry.
      if (!forceStale && e.code === 'STALE_COMMUNICATION_DRAFT' && window.confirm('Сервер обнаружил, что сценарий или диалог изменился. Отправить этот текст вручную только выбранному кандидату?')) {
        forceStale = true;
        data = await hhAction('/hh/send', { negotiation_id: negId, message: msg, force: !!force, force_stale: true });
      } else throw e;
    }
    if (data.blocked) {
      showGuardBlock(i, negId, data.reason);
      showToast('🚫 Guard остановил отправку — исправьте текст или отправьте принудительно', true);
      return;
    }
    insertSentMessage(i, msg);
    markDone(i); onCheck();
    sent = true;
    showToast('✅ Отправлено! Повторная отправка заблокирована на ' + Math.round((Number(window.HH_SEND_COOLDOWN_MS) || SEND_COOLDOWN_MS) / 1000) + ' с.');
  } catch(e) {
    showToast('❌ ' + e.message, true);
  } finally {
    stopClock();
    const b = btn || document.querySelector('#card-' + i + ' .btn-send');
    if (b) {
      if (sent) startSendCooldown(b, i);
      else { b.disabled = false; b.classList.remove('cooldown'); b.textContent = '✓ Отправить'; }
    }
  }
}

function skipOne(i) {
  done.add(i);
  document.getElementById('card-'+i).classList.add('skipped');
  document.querySelectorAll('#card-'+i+' input[type=checkbox]').forEach(cb => { cb.checked = false; cb.disabled = true; });
  onCheck();
}

async function sendAll() {
  const cbs = [...document.querySelectorAll('.tab-panel.active .card-cb:checked')];
  if (!cbs.length) return;
  // The general confirmation is the guard, not the stale-draft one: a recruiter
  // who clicked through score buckets must see how many real candidates the
  // letters go to, and on which tab, before anything leaves for HH.
  const withText = cbs.filter(cb => (document.getElementById('msg-' + parseInt(cb.dataset.idx))?.value || '').trim());
  const empty = cbs.length - withText.length;
  const question = 'Отправить ' + withText.length + ' ' + plural(withText.length, ['письмо', 'письма', 'писем'])
    + ' на вкладке «' + activeTabLabel() + '»?\\n\\n'
    + (empty ? 'У ' + empty + ' ' + plural(empty, ['кандидата', 'кандидатов', 'кандидатов']) + ' текста нет — они будут пропущены.\\n\\n' : '')
    + 'Каждое письмо уйдёт кандидату в HH от вашего имени. Отменить массовую отправку нельзя.';
  if (!window.confirm(question)) return;
  const staleWithMessage = withText.filter(cb => cb.dataset.stale === '1');
  if (staleWithMessage.length && !window.confirm('У ' + staleWithMessage.length + ' выбранных кандидатов черновик помечен как устаревший. Отправить эти тексты без обновления? Будут проверены запрет контакта и дубли.')) return;
  const sb = document.getElementById('sendAllBtn');
  sb.disabled = true; sb.textContent = '⏳ Отправляю...';
  let ok = 0;
  let failed = 0;
  for (let position = 0; position < cbs.length; position++) {
    const cb = cbs[position];
    const i = parseInt(cb.dataset.idx);
    const negId = document.getElementById('card-'+i)?.dataset.neg || '';
    const msg = document.getElementById('msg-'+i)?.value || '';
    if (!msg) continue;
    sb.textContent = '⏳ Отправляю ' + (position + 1) + '/' + cbs.length + '...';
    try {
      let d;
      try {
        d = await hhAction('/hh/send', { negotiation_id: negId, message: msg, force_stale: cb.dataset.stale === '1' });
      } catch (e) {
        if (cb.dataset.stale !== '1' && e.code === 'STALE_COMMUNICATION_DRAFT' && window.confirm('Сервер обнаружил устаревший черновик у выбранного кандидата. Отправить этот текст без обновления?')) {
          d = await hhAction('/hh/send', { negotiation_id: negId, message: msg, force_stale: true });
        } else throw e;
      }
      if (d.blocked) { showToast('🚫 Guard: ' + (d.reason || 'заблокировано'), true); continue; }
      markDone(i); ok++;
    } catch(e) { failed++; showToast('❌ ' + e.message, true); }
  }
  onCheck();
  if (ok > 0 || failed > 0) showToast('Отправлено: ' + ok + (failed ? ' · ошибок: ' + failed : ''));
}

function standardRejection(i) {
  const name = document.getElementById('card-' + i)?.dataset.firstName?.trim();
  return (name ? name + ', здравствуйте! ' : 'Здравствуйте! ') + REJECTION_GREETING;
}

async function rejectWithMessage(i, negId) {
  if (done.has(i) || rejecting.has(negId)) return;
  const ta = document.getElementById('msg-' + i);
  if (!ta) return;
  ta.value = standardRejection(i);
  if (!confirm('Отправить отказ кандидату со следующим сообщением?\\n\\n' + ta.value)) return;
  return sendAndRejectOne(i, negId);
}

async function rejectAll() {
  const cbs = [...document.querySelectorAll('.tab-panel.active .reject-cb:checked')];
  const targets = cbs.map(cb => {
    const i = parseInt(cb.dataset.idx);
    return { i, negId: document.getElementById('card-' + i)?.dataset.neg || '' };
  }).filter(t => t.negId);
  if (!targets.length) return;
  if (!confirm('Отказать ' + targets.length + ' кандидатам на вкладке «' + activeTabLabel() + '»? Каждому уйдёт стандартное сообщение об отказе со статусом «Не подходит».')) return;
  const rb = document.getElementById('rejectAllBtn');
  rb.disabled = true;
  let ok = 0, fail = 0;
  // Sequential on purpose: /hh/send-and-reject is a two-step, persisted operation,
  // and a burst of parallel two-step calls risks HH rate-limits mid-batch.
  for (let k = 0; k < targets.length; k++) {
    const t = targets[k];
    const msg = standardRejection(t.i);
    const ta = document.getElementById('msg-' + t.i);
    if (ta) ta.value = msg;
    rb.textContent = '⏳ ' + (k + 1) + '/' + targets.length + '…';
    rejectionStatus(t.negId, '⏳ Отправляем отказ…', true);
    try {
      const d = await hhAction('/hh/send-and-reject', { negotiation_id: t.negId, message: msg });
      if (d.blocked) { fail++; rejectionStatus(t.negId, 'Отказ не отправлен: ' + (d.reason || 'заблокировано'), false); continue; }
      if (!d.ok) { fail++; rejectionStatus(t.negId, '⚠️ ' + (d.error || 'не подтверждено'), false); continue; }
      ok++;
      markDone(t.i);
      rejectionStatus(t.negId, '✅ Отказ отправлен, кандидат переведён в «Не подходит».', true);
    } catch(e) {
      fail++;
      rejectionStatus(t.negId, '⚠️ ' + e.message, false);
    }
  }
  onCheck();
  rb.disabled = false;
  rb.textContent = 'Отказать (' + document.querySelectorAll('.tab-panel.active .reject-cb:checked').length + ')';
  showToast(fail ? '⚠️ ' + ok + ' ок / ' + fail + ' ошибок' : '✅ Отказано с сообщением: ' + ok, fail > 0);
}

onCheck();
resumeRegenerationJob();
</script>
</body>
</html>`;
}

module.exports = { generateReviewPageHtml };
