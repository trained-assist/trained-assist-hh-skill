'use strict';
const {legacyTestTask} = require('./hh-communication-plan');
const {communicationFailurePayload}=require('./hh-communication-client');
// HH HTTP routes — all /hh/* + /api/hh/proactive/* (moved from core src/handlers/hh.js,
// trained-assist-agent#1470). The host (core server.js) owns the HTTP server and the
// AGENT_SECRET gate and mounts these via hhLib('hh-routes'):
//   handleHhPublic — pre-gate routes (authenticated by the HH token file / HMAC param);
//   handleHhAuthed — post-gate routes (ats-config, reset-ats-results).
// Host services arrive in ctx: notifyProfile, getSecretsCache, secrets, BASE_USERS_DIR, PORT,
// runMcpTool and the negotiation cache functions from createHhNegotiations().
const path = require('path');
const os = require('os');
const fs = require('fs');
const { dataRoot, tokensRoot, usersRoot } = require('./data-paths.js');
const { browserApiBase, publicPageBase, COLD_SEARCH_ENV } = require('./hh-publish-domain');
const userWorkDir = (username) => path.join(usersRoot(), String(username));

const { sendRejection, REJECT_REASON_ACTION } = require('./hh-rejection');
const { hydrateResume, buildResumeText, resumeNotice, resumeHash } = require('./hh-resume');
const { hhFetchWithRefresh, isHhAuthError, hhAuthErrorResponse, hhFetch, hhPut, hhPostForm, readHhToken, readHhTokenFile, readCredentialFileSafe, refreshHhToken, readActiveVacancies } = require('./hh-utils');
// Credential store (trained-assist-agent#1939): every credential file this
// module touches (`hh`, `openrouter`, `hh-message-style`, `hh-message-base-prompt`)
// passes through it — legacy plaintext transparent, a v2 envelope decrypted,
// a base64 stub never returned, a missing CRED_ENCRYPTION_KEY → plaintext with a
// warning (never a hard failure).
const { writeCredentialFile, deleteCredential } = require('./credential-store');
const { bullshitGuard } = require('./hh-bullshit-guard');
const { buildAvailabilityBlock, buildRecruiterIdentity, buildMessageSystemPrompt, buildRejectionSystemPrompt, loadBaseOverride, loadInstructionsTemplate, resolveMessageInstructions, DEFAULT_MESSAGE_BASE, DEFAULT_MESSAGE_INSTRUCTIONS, BASE_PROMPT_FILENAME, INSTRUCTIONS_TEMPLATE_FILENAME } = require('./hh-message-prompts');
const { buildDraftUserMessage, historySignature } = require('./hh-draft-message');
const { planNextStep, buildTestTaskMessage } = require('./hh-funnel');
const {readCommunicationGenerationInputs,captureGenerationGuard,contactForbidden,communicationEnabledFor,generateAndStoreCommunication,staleCommunicationDraft,refreshCommunicationHistory}=require('./hh-communication-runtime');
const { generateConversation } = require('./conversation-generation');
const { hhLlm } = require('./hh-llm');
const { ladderToken } = require('./llm-ladder');
const { hhInterviewConfigAllowsTime } = require('./hh-negotiations');
const { appendLocalMessage } = require('./hh-history');
const {acquireCandidateSendLock}=require('./hh-send-lock');
const {skillRevision,isSha}=require('./hh-version');
const {reconcilePendingSend,performCommunicationSend}=require('./hh-communication-send');

// Cold-search schedule lives in the host's generic cron (#1489 S7.1); these routes reach
// it only through the provider's hh_proactive_schedule tool, invoked via the host's
// runMcpTool (ctx.runMcpTool, bound by each handler call below).
let hostRunMcpTool = null;
async function coldSearchSchedule(username, workDir, params) {
  try {
    if (!hostRunMcpTool) throw new Error('host runMcpTool not provided');
    const text = await hostRunMcpTool({ tool: 'hh_proactive_schedule', params, username, workDir, timeoutMs: 20000 });
    return JSON.parse(text || '{}');
  } catch (e) { return { error: e.message }; }
}
async function coldSearchMonitoring(username, workDir, vacancyId) {
  const legacy = require('./hh-cold-search-schedule').getSchedules(username, workDir)[vacancyId] || {};
  const flags = { starred: !!legacy.starred, archived: !!legacy.archived };
  if (!vacancyId) return flags;
  const st = await coldSearchSchedule(username, workDir, { action: 'status', vacancy_id: String(vacancyId) });
  if (st.error) return { ...flags, enabled: false, error: `Статус расписания недоступен: ${st.error}` };
  return { ...flags, enabled: !!st.enabled, last_attempt: st.last_run || null,
    last_success: st.last_status === 'succeeded' ? st.last_run : null,
    status: st.last_status || null, next_run: st.next_run || null };
}
const { generateProactivePageHtml } = require('./hh-proactive-page');
const { runProactiveSearch, scoreUnscoredProactiveCandidates } = require('./hh-proactive-search');
const { hhStylePageHtml } = require('./hh-style-html');
const { generateReviewPageHtml } = require('./hh-review-page-html');
const { withHhNav } = require('./hh-nav');
const hhHub = require('./hh-hub');
const { vacanciesPageHtml, planPageHtml } = require('./hh-hub-html');
const { vacancyNewPageHtml } = require('./hh-vacancy-new-html');
const { extractTextFromBuffer } = require('./hh-doc-text');
const hhPortrait = require('./hh-portrait');
const { candidateNewPageHtml } = require('./hh-candidate-new-html');
const hhCandidateDocs = require('./hh-candidate-docs');
const { TYPES: CANDIDATE_DOC_TYPES } = require('./hh-doc-classify');
const evalDocs = require('./hh-candidate-eval-docs');
const reportPdf = require('./hh-report-pdf');
const evalJob = require('./hh-eval-job');

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req, maxBytes = 1_048_576) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > maxBytes) { req.destroy(); return reject(new Error('body too large')); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function proactiveHmac(uname) {
  const { createHmac } = require('crypto');
  const secret = process.env.AGENT_SECRET || '';
  return createHmac('sha256', secret).update(uname).digest('hex').slice(0, 16);
}

// Browser pages act for exactly one recruiter: they carry that recruiter's HMAC
// (`token` in the JSON body), never the master AGENT_SECRET. Server-to-server
// callers may still use the Bearer secret. No secret configured = local dev.
function pageAuthOk(req, username, token) {
  const secret = process.env.AGENT_SECRET || '';
  if (!secret) return true;
  if (req.headers.authorization === `Bearer ${secret}`) return true;
  return !!username && String(token || '') === proactiveHmac(String(username));
}

// Signed URL to the recruiter's proactive results page. Was referenced in server.js
// but never defined there — /api/hh/proactive/search always 500'd. Defined here
// (same scheme as 92-hh-proactive.js / hh-autoscan.js proactiveUrlFor). `vacancyId`
// is a plain, non-HMAC'd query param appended alongside the token — same pattern as
// hhReviewUrl in hh-quick.js — so multi-vacancy step 7's tab switcher can deep-link
// straight into the right tab. Omitted (falsy) → no param, unchanged for
// single-vacancy callers.
function proactiveUrl(username, vacancyId) {
  const base = publicPageBase(username, COLD_SEARCH_ENV, 'https://recruiter-assistant.ru');
  const token = proactiveHmac(username);
  const vacancyParam = vacancyId ? `&vacancy_id=${encodeURIComponent(vacancyId)}` : '';
  return `${base}/hh/proactive?username=${encodeURIComponent(username)}&token=${token}${vacancyParam}`;
}

const { latestProactiveFile } = require('./hh-cold-search-snapshots');

function appendGuardBlock(username, negId, reason, checks, blocked = true) {
  try {
    const dataDir = dataRoot();
    const logPath = path.join(dataDir, 'hh', String(username), 'guard-log.json');
    let entries = [];
    try { entries = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch {}
    entries.unshift({ at: Date.now(), neg_id: negId, reason, checks, blocked });
    if (entries.length > 100) entries.length = 100;
    fs.writeFileSync(logPath, JSON.stringify(entries), { mode: 0o600 });
  } catch { /* non-critical */ }
}

function generateCandidateProfileHtml(neg, history, username, callbackBase, reviewUrl) {
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const r = neg?.resume || {};
  const ats = history?.ats_result || null;
  const msgs = history?.messages || [];
  const draft = history?.message_draft?.text || ats?.draft_message || '';

  const name = [r.last_name, r.first_name].filter(Boolean).join(' ') || neg?.applicant?.name || 'Кандидат';
  const jobTitle = r.title || '';
  const expMonths = r.total_experience?.months || 0;
  const expStr = expMonths ? `${Math.floor(expMonths / 12)} лет ${expMonths % 12 ? (expMonths % 12) + ' мес' : ''}`.trim() : '';
  const location = r.area?.name || '';
  const salary = r.salary ? `${r.salary.amount?.toLocaleString('ru-RU')} ${r.salary.currency}` : '';
  const hhLink = neg?.alternate_url || r.alternate_url || '';
  const coverLetter = neg?.message || '';

  const colorMap = { 'ПРОПУСТИТЬ': '#16a34a', 'УТОЧНИТЬ': '#ca8a04', 'ОТКЛОНИТЬ': '#dc2626' };
  const col = colorMap[ats?.verdict] || '#64748b';
  const scorePct = ats?.score != null ? Math.round(ats.score * 10) : 0;

  const metaItems = [jobTitle, expStr, location, salary].filter(Boolean);

  // ATS section
  const matchedHtml = (ats?.matched || []).map(m => `<span class="tag tag-ok">${esc(m)}</span>`).join('');
  const gapsHtml = (ats?.gaps || []).map(g => `<span class="tag tag-gap">${esc(g)}</span>`).join('');

  // Message history
  const histHtml = msgs.length === 0
    ? '<p class="no-msgs">Переписки ещё не было</p>'
    : msgs.map(m => `<div class="msg-bubble msg-${esc(m.role || 'employer')}">
        <div class="msg-meta-row"><span class="msg-who">${m.role === 'employer' ? '👔 Рекрутер' : '👤 Кандидат'}</span><span class="msg-time">${(m.timestamp || '').slice(0, 10)}</span></div>
        <div class="msg-body">${esc(m.text || '').replace(/\n/g, '<br>')}</div>
      </div>`).join('');

  const neg_id = neg?.id || history?.neg_id || '';

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)} — профиль кандидата</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#f1f5f9;color:#1e293b;min-height:100vh}
.topbar{background:#1e293b;color:#f8fafc;padding:12px 24px;display:flex;align-items:center;gap:16px;position:sticky;top:0;z-index:10}
.topbar a{color:#94a3b8;text-decoration:none;font-size:14px}
.topbar a:hover{color:#f8fafc}
.topbar .cname{font-size:18px;font-weight:700;color:#fff;flex:1}
.page{max-width:860px;margin:0 auto;padding:24px 16px;display:grid;gap:16px}
.card{background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.card h2{font-size:16px;font-weight:600;color:#64748b;margin-bottom:16px;border-bottom:1px solid #f1f5f9;padding-bottom:8px}
.hero-meta{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
.hero-meta span{font-size:14px;color:#64748b}
.hero-meta .sep{color:#cbd5e1}
.hh-btn{display:inline-flex;align-items:center;gap:4px;padding:6px 12px;background:#d6001c;color:#fff;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600}
.hh-btn:hover{background:#b0001a}
.score-section{display:flex;align-items:center;gap:16px;padding:16px;background:#f8fafc;border-radius:8px;margin-bottom:16px}
.score-big{font-size:36px;font-weight:800;line-height:1}
.score-details{flex:1}
.score-bar{height:8px;background:#e2e8f0;border-radius:4px;margin-bottom:6px}
.score-fill{height:100%;border-radius:4px}
.verdict-big{font-size:13px;font-weight:700;padding:4px 10px;border-radius:20px;color:#fff;display:inline-block}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.tag{padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600}
.tag-ok{background:#dcfce7;color:#166534}
.tag-gap{background:#fee2e2;color:#991b1b}
.reasoning{font-size:14px;color:#475569;margin-top:12px;font-style:italic;line-height:1.5}
.job{padding:12px 0;border-bottom:1px solid #f1f5f9}
.job:last-child{border-bottom:none}
.job-header{font-size:14px;margin-bottom:4px}
.job-dates{color:#94a3b8;font-size:12px;font-weight:400}
.job-desc{font-size:13px;color:#64748b;margin-top:4px;line-height:1.5}
.skills{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.skill-tag{background:#f1f5f9;color:#475569;padding:4px 10px;border-radius:20px;font-size:12px}
.edu-list{font-size:13px;color:#64748b;margin-top:8px;padding-left:16px}
.cover{font-size:14px;line-height:1.7;white-space:pre-wrap;color:#374151;background:#fefce8;padding:16px;border-radius:8px;border-left:3px solid #ca8a04}
.msg-bubble{padding:12px 16px;border-radius:8px;margin-bottom:10px}
.msg-employer{background:#eff6ff;border-left:3px solid #3b82f6}
.msg-applicant{background:#f0fdf4;border-left:3px solid #22c55e}
.msg-meta-row{display:flex;justify-content:space-between;margin-bottom:4px}
.msg-who{font-size:12px;font-weight:700;color:#64748b}
.msg-time{font-size:11px;color:#94a3b8}
.msg-body{font-size:14px;line-height:1.6;white-space:pre-wrap}
.no-msgs{color:#94a3b8;font-style:italic;padding:12px 0}
.draft-area{width:100%;border:1px solid #e2e8f0;border-radius:8px;padding:12px;font-size:14px;font-family:inherit;resize:vertical;min-height:120px;color:#1e293b;background:#fff;margin-bottom:12px}
.btn-send{background:#2563eb;color:#fff;border:none;padding:10px 24px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
.btn-send:hover{background:#1d4ed8}
.btn-send:disabled{background:#94a3b8;cursor:default}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1e293b;color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;display:none;z-index:100}
.toast.err{background:#dc2626}
</style>
</head>
<body>
<div class="topbar">
  <a href="${esc(reviewUrl)}">← Назад к ревью</a>
  <span class="cname">${esc(name)}</span>
  ${hhLink ? `<a class="hh-btn" href="${esc(hhLink)}" target="_blank" rel="noopener">↗ HH</a>` : ''}
</div>

<div class="page">

  <!-- Hero: meta info -->
  <div class="card">
    <h2>Основная информация</h2>
    <div class="hero-meta">
      ${metaItems.map((x, i) => `<span>${esc(x)}</span>${i < metaItems.length - 1 ? '<span class="sep">·</span>' : ''}`).join('')}
    </div>
  </div>

  <!-- ATS Score -->
  ${ats ? `<div class="card">
    <h2>Оценка ATS</h2>
    <div class="score-section">
      <div class="score-big" style="color:${col}">${ats.score != null ? ats.score.toFixed(1) : '—'}</div>
      <div class="score-details">
        <div class="score-bar"><div class="score-fill" style="width:${scorePct}%;background:${col}"></div></div>
        <span class="verdict-big" style="background:${col}">${esc(ats.verdict || '')}</span>
      </div>
    </div>
    ${matchedHtml || gapsHtml ? `<div class="tags">${matchedHtml}${gapsHtml}</div>` : ''}
    ${ats.reasoning ? `<p class="reasoning">${esc(ats.reasoning)}</p>` : ''}
  </div>` : ''}

  <!-- Message history -->
  <div class="card">
    <h2>История переписки (${msgs.length} сообщ.)</h2>
    ${histHtml}
  </div>

  <!-- Draft / send -->
  <div class="card">
    <h2>${msgs.some(m => m.role === 'employer') ? 'Follow-up' : 'Новое сообщение'}</h2>
    <textarea class="draft-area" id="draft-msg">${esc(draft)}</textarea>
    <div style="display:flex;gap:8px">
      <button class="btn-send" id="sendBtn" onclick="doSend()" ${!neg_id ? 'disabled' : ''}>✓ Отправить в HH</button>
    </div>
  </div>

  <!-- Experience -->
  <div class="card"><h2>Резюме</h2><p>${esc(resumeNotice(neg, ats))}</p>
    <pre style="white-space:pre-wrap;font-family:inherit">${esc(buildResumeText(neg || {}))}</pre>
  </div>

  <!-- Cover letter -->
  ${coverLetter ? `<div class="card">
    <h2>Сопроводительное письмо</h2>
    <div class="cover">${esc(coverLetter)}</div>
  </div>` : ''}

</div>

<div class="toast" id="toast"></div>

<script>
const NEG_ID = '${esc(String(neg_id))}';
const HH_USER = '${esc(String(username))}';
const HH_PAGE_TOKEN = '${process.env.AGENT_SECRET ? proactiveHmac(String(username)) : ''}';
const CALLBACK_BASE = ${JSON.stringify(callbackBase)} || (location.pathname.startsWith('/agent/') ? '/agent' : '');

function showToast(msg, err) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : '');
  t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, 4000);
}

async function doSend(force) {
  const msg = document.getElementById('draft-msg').value.trim();
  if (!msg) { showToast('Сообщение пустое', true); return; }
  const btn = document.getElementById('sendBtn');
  btn.disabled = true; btn.textContent = '⏳...';
  try {
    const r = await fetch(CALLBACK_BASE + '/hh/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: HH_USER, token: HH_PAGE_TOKEN, negotiation_id: NEG_ID, message: msg, force: !!force }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await r.json().catch(() => ({}));
    if (data.blocked) {
      btn.disabled = false; btn.textContent = '✓ Отправить в HH';
      if (confirm('🚫 Guard: ' + (data.reason || 'заблокировано') + '\n\nЭто ты лично проверяешь и отправляешь — всё равно отправить?')) {
        return doSend(true);
      }
    } else if (!r.ok) {
      showToast('❌ ' + (data.error || r.statusText), true);
      btn.disabled = false; btn.textContent = '✓ Отправить в HH';
    } else {
      showToast('✅ Отправлено!');
      btn.textContent = '✓ Отправлено';
      // Reload to show new message in history
      setTimeout(() => location.reload(), 1500);
    }
  } catch(e) {
    showToast('❌ ' + e.message, true);
    btn.disabled = false; btn.textContent = '✓ Отправить в HH';
  }
}
</script>
</body>
</html>`;
}

/**
 * Pre-gate HH routes (no AGENT_SECRET — authenticated by HH token file / HMAC).
 * Returns true if the request was handled.
 */
async function handleHhPublic(req, url, res, ctx) {
  if(['/hh/ats-editor','/hh/ats-config','/hh/generate-message'].includes(url.pathname)){const rev=skillRevision();if(isSha(rev))res.setHeader('X-HH-Skill-Rev',rev);}
  if (ctx.runMcpTool) hostRunMcpTool = ctx.runMcpTool;
  // Recruiting-hub nav bar (#1742): injected into every authorized GET /hh/* HTML page
  // by wrapping res — the page handlers below are unchanged.
  withHhNav(req, url, res, { isAuthorized: (u, t) => !process.env.AGENT_SECRET || t === proactiveHmac(u) });
  const { secrets, getSecretsCache, BASE_USERS_DIR, PORT,
          getHhNegotiationsWithCache, syncHhMessagesToHistory, fetchAllHhNegotiations, getHhDiscardedWithCache, hhCacheFile } = ctx;
  const _secretsCache = getSecretsCache();

  function proactiveErrPage(msg) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Проактивный поиск</title>
<style>body{font-family:system-ui;padding:48px;text-align:center;background:#f1f5f9;color:#1e293b}</style>
</head><body><h2>${msg}</h2></body></html>`);
  }

if (req.method === 'OPTIONS' && (url.pathname === '/hh/send' || url.pathname === '/hh/reject' || url.pathname === '/hh/send-and-reject' || url.pathname === '/hh/ats-config' || url.pathname === '/hh/ats-extract' || url.pathname === '/hh/review' || url.pathname === '/hh/candidate' || url.pathname === '/hh/reset-ats-results' || url.pathname === '/hh/generate-message' || url.pathname === '/hh/update-style' || url.pathname === '/hh/update-base-prompt' || url.pathname === '/hh/update-instructions-template' || url.pathname === '/hh/message-instructions-template' || url.pathname === '/hh/response-state' || url.pathname === '/hh/sync-negotiations')) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  return res.end();
}

if (req.method === 'GET' && url.pathname === '/hh/response-updates') {
  const username = url.searchParams.get('username');
  const vacancyId = url.searchParams.get('vacancy_id');
  if (![username, vacancyId].every(x => /^[a-zA-Z0-9_-]+$/.test(String(x || '')))) return json(res, 400, { error: 'Invalid scope' });
  if (process.env.AGENT_SECRET && url.searchParams.get('token') !== proactiveHmac(username)) return json(res, 403, { error: 'Invalid token' });
  if (!readActiveVacancies(path.join(BASE_USERS_DIR, username)).some(v => String(v.id) === vacancyId)) return json(res, 403, { error: 'Unknown vacancy' });
  res.setHeader('Cache-Control', 'no-store');
  try {
    const dataDir = dataRoot();
    const saved = JSON.parse(fs.readFileSync(hhCacheFile(dataDir, username, vacancyId), 'utf8'));
    return json(res, 200, { synced_at: saved.synced_at });
  } catch { return json(res, 200, { synced_at: null }); }
}

if (req.method === 'POST' && url.pathname === '/hh/response-state') {
  // Cross-origin: the review page (src/hh-review-page-html.js) stars/archives from
  // CALLBACK_BASE, a different origin than the page. Same class as the
  // /hh/message-instructions-template fix in #135 — see tests/guards/cross-origin-calls.
  res.setHeader('Access-Control-Allow-Origin', '*');
  const body = JSON.parse(await readBody(req));
  const { username, vacancy_id, negotiation_id, status, token } = body;
  if (![username, vacancy_id, negotiation_id].every(x => /^[a-zA-Z0-9_-]+$/.test(String(x || '')))) return json(res, 400, { error: 'Invalid scope' });
  if (process.env.AGENT_SECRET && token !== proactiveHmac(username)) return json(res, 403, { error: 'Invalid token' });
  const vacancies = readActiveVacancies(path.join(BASE_USERS_DIR, username));
  if (!vacancies.some(v => String(v.id) === String(vacancy_id))) return json(res, 403, { error: 'Unknown vacancy' });
  const dataDir = dataRoot();
  try {
    const cache = JSON.parse(fs.readFileSync(hhCacheFile(dataDir, username, vacancy_id), 'utf8'));
    if (!cache.negotiations.some(n => String(n.id) === String(negotiation_id))) return json(res, 404, { error: 'Unknown response' });
    require('./hh-response-state').setResponseState(dataDir, username, vacancy_id, negotiation_id, status);
    return json(res, 200, { ok: true, status });
  } catch (e) { return json(res, 400, { error: e.message }); }
}

if (req.method === 'GET' && url.pathname === '/hh/review') {
  const username = url.searchParams.get('username') || '';
  const hhTokensBase = tokensRoot();
  const tokenFile = path.join(hhTokensBase, String(username), 'hh');
  const errPage = (msg) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>HH Ревью</title>
<style>body{font-family:system-ui;padding:48px;text-align:center;background:#f1f5f9;color:#1e293b}h2{margin-bottom:12px}</style>
</head><body><h2>${msg}</h2></body></html>`);
  };
  // Token check: HMAC-SHA256(AGENT_SECRET, username).slice(0,16)
  const agentSecret = process.env.AGENT_SECRET || '';
  if (agentSecret) {
    const { createHmac } = require('crypto');
    const expected = createHmac('sha256', agentSecret).update(username).digest('hex').slice(0, 16);
    const given = url.searchParams.get('token') || '';
    if (given !== expected) return errPage('Ссылка недействительна. Запроси новую у бота.');
  }
  if (!username || !fs.existsSync(tokenFile)) return errPage('HH не подключён. Скажи боту «подключи HH».');
  const tokenData = readHhTokenFile(tokenFile);
  if (!tokenData) return errPage('Ошибка чтения токена.');

  const dataDir = dataRoot();
  const workDir = path.join(BASE_USERS_DIR, username);
  const activeVacancies = readActiveVacancies(workDir);
  const requestedVacancyId = url.searchParams.get('vacancy_id') || '';
  const vacancy = requestedVacancyId ? activeVacancies.find(v => String(v.id) === requestedVacancyId) : activeVacancies[0];
  if (!vacancy?.id) return errPage('Вакансия не выбрана. Скажи боту «мои вакансии» и выбери вакансию.');

  let negotiations = [], syncedAt = null, syncError = null;
  try {
    const result = await getHhNegotiationsWithCache(dataDir, username, vacancy.id, tokenData.access_token);
    negotiations = result.negotiations;
    syncedAt = result.synced_at;
    // The negotiations fetch may have refreshed the rotating credential.
    const currentToken = readHhTokenFile(tokenFile);
    if (currentToken?.access_token) tokenData.access_token = currentToken.access_token;
  } catch (e) {
    console.error('[hh/review] fetch error:', e.message);
    syncError = 'Не удалось обновить отклики из HH. Показаны последние сохранённые данные.';
    try {
      const cached = JSON.parse(fs.readFileSync(hhCacheFile(dataDir, username, vacancy.id), 'utf8'));
      negotiations = cached.negotiations; syncedAt = cached.synced_at;
    } catch { syncError = 'Не удалось загрузить отклики из HH. Нажмите «Обновить» для повтора.'; }
  }

  // Sync changed HH threads into local history before rendering. A fixed slice of
  // the first 15 negotiations starved conversations later in the list forever;
  // the incremental selector checks every negotiation's updated_at against its
  // last local sync and fetches only conversations that actually changed.
  await syncHhMessagesToHistory(dataDir, username, negotiations, tokenData.access_token, {
    incremental: true,
    maxConcurrent: 4,
  }).catch(e => {
    console.error('[hh/review] message sync error:', e.message);
  });

  // Rejected candidates are not part of the review list, but a candidate can reply
  // after being rejected. Fetch discard-stage negotiations and sync their threads so
  // such replies surface as "ответил после отказа" instead of silently going unread.
  let discarded = [];
  try {
    discarded = await getHhDiscardedWithCache(dataDir, username, vacancy.id, tokenData.access_token);
    await syncHhMessagesToHistory(dataDir, username, discarded, tokenData.access_token, { incremental: true, cap: 30 }).catch(e => {
      console.error('[hh/review] discard sync error:', e.message);
    });
  } catch (e) {
    console.error('[hh/review] discard fetch error:', e.message);
  }

  let lastScoredAt = null;
  try {
    const logPath = path.join(dataDir, 'hh', String(username), 'last-scoring.json');
    if (fs.existsSync(logPath)) lastScoredAt = JSON.parse(fs.readFileSync(logPath, 'utf8')).at || null;
  } catch { /* non-critical */ }

  const callbackBase = ''; // Same-origin public URL, including legacy /agent links.
  const html = generateReviewPageHtml(negotiations, vacancy.title || 'Вакансия', username, callbackBase, dataDir, {
    syncedAt, syncError, list: url.searchParams.get('list') || 'active',
    vacancyId: vacancy.id,
    communicationEnabled: communicationEnabledFor(username, vacancy.id),
    lastScoredAt,
    vacancies: activeVacancies,
    discarded,
  });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
  return;
}

if (req.method === 'GET' && url.pathname === '/hh/candidate') {
  const username = url.searchParams.get('username') || '';
  const neg_id = url.searchParams.get('neg_id') || '';
  const errPage = (msg) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Профиль кандидата</title>
<style>body{font-family:system-ui;padding:48px;text-align:center;background:#f1f5f9;color:#1e293b}</style>
</head><body><h2>${msg}</h2></body></html>`);
  };
  const agentSecret = process.env.AGENT_SECRET || '';
  if (agentSecret) {
    const { createHmac } = require('crypto');
    const expected = createHmac('sha256', agentSecret).update(username).digest('hex').slice(0, 16);
    if ((url.searchParams.get('token') || '') !== expected) return errPage('Ссылка недействительна.');
  }
  if (!username || !neg_id) return errPage('Не указан username или neg_id.');
  const hhTokensBase = tokensRoot();
  const tokenFile = path.join(hhTokensBase, String(username), 'hh');
  if (!fs.existsSync(tokenFile)) return errPage('HH не подключён.');
  const tokenData = readHhTokenFile(tokenFile);
  if (!tokenData) return errPage('Ошибка чтения токена.');

  const dataDir = dataRoot();
  const candFile = path.join(dataDir, 'hh', String(username), 'candidates', `${neg_id}.json`);
  const history = fs.existsSync(candFile)
    ? (() => { try { return JSON.parse(fs.readFileSync(candFile, 'utf8')); } catch { return {}; } })()
    : {};

  // Fetch single negotiation from HH API for resume + cover letter
  let neg = null;
  try {
    neg = await hhFetch(`/negotiations/${neg_id}`, tokenData);
    await hydrateResume(neg, tokenData);
  } catch (e) {
    console.error(`[hh/candidate] fetch neg ${neg_id}:`, e.message);
  }

  const callbackBase = '';
  const reviewUrl = require('./hh-quick').hhReviewUrl(username, url.searchParams.get('vacancy_id') || neg?.vacancy?.id);

  const html = generateCandidateProfileHtml(neg, history, username, callbackBase, reviewUrl);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
  return;
}

if (req.method === 'GET' && url.pathname === '/hh/sync-log') {
  const username = url.searchParams.get('username') || '';
  const agentSecret = process.env.AGENT_SECRET || '';
  if (agentSecret) {
    const { createHmac } = require('crypto');
    const expected = createHmac('sha256', agentSecret).update(username).digest('hex').slice(0, 16);
    if ((url.searchParams.get('token') || '') !== expected) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><html><body style="font-family:system-ui;padding:48px;text-align:center"><h2>Ссылка недействительна.</h2></body></html>');
    }
  }
  const dataDir = dataRoot();
  const hhDir = path.join(dataDir, 'hh', username);
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(path.join(hhDir, 'sync-log.json'), 'utf8')); } catch {}
  let guardEntries = [];
  try { guardEntries = JSON.parse(fs.readFileSync(path.join(hhDir, 'guard-log.json'), 'utf8')); } catch {}
  const fmt = ts => new Date(ts).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const rows = entries.length === 0
    ? '<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:24px">Нет данных — скоринг ещё не запускался</td></tr>'
    : entries.map(e => {
        const msgs = e.new_messages_loaded != null ? `+${e.new_messages_loaded} сообщ.` : '—';
        const msgsColor = (e.new_messages_loaded || 0) > 0 ? '#2563eb' : '#94a3b8';
        const scoredColor = (e.scored || 0) > 0 ? '#16a34a' : '#94a3b8';
        const errColor = (e.sync_errors || 0) > 0 ? '#dc2626' : '#94a3b8';
        const errStr = e.sync_errors != null ? (e.sync_errors > 0 ? `⚠ ${e.sync_errors}` : '—') : '—';
        return `<tr>
          <td>${fmt(e.at)}</td>
          <td>${e.checked ?? '—'}</td>
          <td style="color:${msgsColor}">${msgs}</td>
          <td style="color:${scoredColor}">${(e.scored || 0) > 0 ? '+' + e.scored + ' скор.' : 'без изм.'}</td>
          <td style="color:#64748b">${e.with_new_messages != null ? e.with_new_messages + ' канд.' : '—'}</td>
          <td style="color:${errColor}">${errStr}</td>
        </tr>`;
      }).join('');
  const guardRows = guardEntries.length === 0
    ? '<tr><td colspan="4" style="text-align:center;color:#94a3b8;padding:16px">Guard блокировок не было</td></tr>'
    : guardEntries.slice(0, 20).map(g => `<tr>
        <td>${fmt(g.at)}</td>
        <td style="color:#64748b;font-family:monospace;font-size:12px">${g.neg_id || '—'}</td>
        <td style="color:${g.blocked === false ? '#d97706' : '#dc2626'}">${g.blocked === false ? '⚠ пропущена проверка' : '⛔ заблокировано'}</td>
        <td style="color:#64748b">${g.reason || '—'}</td>
      </tr>`).join('');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  return res.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>История скоринга</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f1f5f9;color:#1e293b;padding:24px}h1{font-size:20px;font-weight:700;margin-bottom:4px}.sub{font-size:13px;color:#64748b;margin-bottom:20px}h2{font-size:16px;font-weight:600;margin:24px 0 8px}table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);margin-bottom:8px}th{background:#f8fafc;font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.04em;padding:10px 16px;text-align:left;border-bottom:1px solid #e2e8f0}td{padding:10px 16px;font-size:14px;border-bottom:1px solid #f1f5f9}tr:last-child td{border-bottom:none}/* Мобильный аудит #174: 6-колоночный лог не влезал в 360 и растягивал всю страницу на 256px. Таблица скроллится внутри своей обёртки, страница — нет. */.table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:12px}.table-scroll table{min-width:560px}.table-scroll.guard table{min-width:480px}@media(max-width:480px){body{padding:12px}}</style>
</head><body>
<h1>История скоринга и Guard</h1>
<p class="sub">Последние запуски · ${username}</p>
<h2>Фоновый скоринг</h2>
<div class="table-scroll"><table><thead><tr><th>Время (МСК)</th><th>Проверено</th><th>Новых сообщ.</th><th>Скоринг</th><th>С активностью</th><th>API ошибки</th></tr></thead><tbody>${rows}</tbody></table></div>
<h2>Bullshit Guard — последние блокировки и пропуски проверки</h2>
<div class="table-scroll guard"><table><thead><tr><th>Время</th><th>neg_id</th><th>Статус</th><th>Причина</th></tr></thead><tbody>${guardRows}</tbody></table></div>
</body></html>`);
}

// Editor page writes (moved pre-gate: the page authenticates with the recruiter's
// HMAC, not the master secret it used to embed).
if (req.method === 'POST' && url.pathname === '/hh/ats-config') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const body = JSON.parse(await readBody(req));
  const { config, stages, username, vacancy_id: vacancyId } = body || {};
  if (!config || typeof config !== 'object') return json(res, 400, { error: 'config required' });
  if (!pageAuthOk(req, username, body?.token)) return json(res, 403, { error: 'invalid token' });
  if (!/^[a-zA-Z0-9_-]+$/.test(String(vacancyId || ''))) return json(res, 400, { error: 'vacancy_id required' });
  // Must match BASE_USERS_DIR so runHhScoringForUser can find the file
  const contextBase = username
    ? path.join(BASE_USERS_DIR, username, 'contexts')
    : path.join(process.cwd(), 'contexts');
  const hhContextDir = path.join(contextBase, 'hh');
  fs.mkdirSync(hhContextDir, { recursive: true });
  const hhTokensBase = tokensRoot();
  let now = new Date().toISOString();
  // Once the editor knows which vacancy it's editing (multi-vacancy tabs), save under
  // the per-vacancy key only — writing to the legacy singleton too would let whichever
  // vacancy tab saves last silently clobber the others' config (same class of bug
  // step 2/6 fixed for the background scoring read path; see hh-scoring.js readAtsConfig).
  const configName = vacancyId ? `ats_config:${vacancyId}` : 'ats_config';
  // The editor form only knows some fields (no filters.area, search queries, …).
  // Keep whatever it doesn't send instead of silently dropping it on every save.
  const configFile = path.join(hhContextDir, `${configName}.json`);
  let prev = {};
  let currentRevision = null;
  try { const envelope = JSON.parse(fs.readFileSync(configFile, 'utf8')); prev = envelope.value || {}; currentRevision = envelope.updated_at || null; } catch { /* first save */ }
  if (Number.isFinite(Date.parse(currentRevision)) && Date.parse(now) <= Date.parse(currentRevision)) now = new Date(Date.parse(currentRevision) + 1).toISOString();
  if (typeof prev === 'string') { try { prev = JSON.parse(prev); } catch { prev = {}; } }
  const { normalizeCommunicationPlan } = require('./hh-communication-plan');
  if (body.expected_revision !== undefined) {
    if (body.expected_revision !== currentRevision) return json(res, 409, { error: 'Конфиг изменён. Перезагрузите страницу перед сохранением.', code: 'CONFIG_REVISION_CONFLICT' });
  }
  let normalizedPlan;
  if (config.communication_plan !== undefined) {
    try { normalizedPlan = normalizeCommunicationPlan(config.communication_plan); } catch (error) { return json(res, 400, { error: error.message, code: error.code }); }
  }
  const merged = { ...prev, ...config, vacancy_id: vacancyId, ...(normalizedPlan ? {communication_plan: normalizedPlan} : {}) };
  if (prev.filters && typeof prev.filters === 'object') merged.filters = { ...prev.filters, ...(config.filters || {}) };
  // Epic #112: the per-vacancy message instructions auto-fill from the recruiter's
  // global template (or the default) at the first save, and keep tracking it until
  // the recruiter edits them. An edited instruction is never overwritten on later
  // saves; reverting it to exactly the current template re-syncs it to 'global'.
  if (vacancyId) {
    const template = loadInstructionsTemplate(hhTokensBase, username) || DEFAULT_MESSAGE_INSTRUCTIONS;
    const owned = String(merged.message_instructions || '').trim();
    if (!owned) {
      merged.message_instructions = template;
      merged.message_instructions_source = 'global';
      merged.message_instructions_synced_at = now;
    } else {
      merged.message_instructions_source = owned === template ? 'global' : 'recruiter';
      if (merged.message_instructions_source === 'global') merged.message_instructions_synced_at = now;
    }
  }
  if (fs.existsSync(configFile)) {
    const backupDir = path.join(hhContextDir, 'backups'); fs.mkdirSync(backupDir, {recursive:true, mode:0o700});
    fs.copyFileSync(configFile, path.join(backupDir, `${configName}.${Date.now()}.json`));
  }
  const temporary = `${configFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ value: merged, updated_at: now }, null, 2), {mode:0o600});
  fs.renameSync(temporary, configFile);
  if (Array.isArray(stages) && !normalizedPlan) fs.writeFileSync(path.join(hhContextDir, `ats_stages:${vacancyId}.json`), JSON.stringify({value:stages,updated_at:now},null,2));
  console.log(`[hh/ats-config] saved vacancy="${config.vacancy_title}" vacancy_id=${vacancyId || 'legacy'} stages=${stages?.length || 0} user=${username || 'default'}`);
  if (username && latestProactiveFile(username, String(vacancyId))) {
    setImmediate(() => scoreUnscoredProactiveCandidates(username, { vacancyId: String(vacancyId) }).catch(error => {
      console.error(`[hh/ats-config] cold-search rescore failed for vacancy=${vacancyId}:`, error.message);
    }));
  }
  return json(res, 200, { ok: true, revision: now });
}

if (req.method === 'POST' && url.pathname === '/hh/reset-ats-results') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Only explicitly scoped histories are reset; legacy unstamped histories remain intact.
  const body = JSON.parse(await readBody(req));
  const { username, vacancy_id: vacancyId } = body || {};
  if (!pageAuthOk(req, username, body?.token)) return json(res, 403, { error: 'invalid token' });
  if (!username || !/^[a-zA-Z0-9_-]+$/.test(String(vacancyId || ''))) return json(res, 400, { error: 'username and vacancy_id required' });
  const dataDir = dataRoot();
  const candDir = path.join(dataDir, 'hh', String(username), 'candidates');
  let reset = 0;
  let skipped = 0;
  if (fs.existsSync(candDir)) {
    for (const f of fs.readdirSync(candDir)) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(candDir, f);
      try {
        const hist = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (String(hist.vacancy_id || hist.ats_result?.vacancy_id || '') !== String(vacancyId)) { skipped++; continue; }
        if (hist.ats_result !== undefined) {
          delete hist.ats_result;
          hist.ats_reset_at = new Date().toISOString();
          fs.writeFileSync(fp, JSON.stringify(hist, null, 2));
          reset++;
        } else {
          skipped++;
        }
      } catch { skipped++; }
    }
  }
  console.log(`[hh/reset-ats-results] user=${username} reset=${reset} skipped=${skipped}`);
  return json(res, 200, { ok: true, reset, skipped });
}

// Collect ATS criteria from the HH vacancy text (issue #126, slice 4). The review page
// shows a vacancy without criteria as "letters stop updating" — but until now there was
// no way to fix it from the page itself: criteria could only be produced by the chat
// LLM, so a recruiter without chat access was stuck in a circle (criteria cannot be
// entered by hand → background skipped the vacancy → letters froze). This route fetches
// the vacancy text from HH and runs the SAME hh_extract_ats_config tool the agent uses,
// so page and chat produce identical configs — including the measurability guard.
if (req.method === 'POST' && url.pathname === '/hh/ats-extract') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const body = JSON.parse(await readBody(req));
  const { username, vacancy_id: vacancyId } = body || {};
  if (!username || !vacancyId) return json(res, 400, { error: 'missing fields' });
  if (!pageAuthOk(req, username, body?.token)) return json(res, 403, { error: 'invalid token' });
  const tokenFile = path.join(tokensRoot(), String(username), 'hh');
  const hhToken = fs.existsSync(tokenFile) ? readHhTokenFile(tokenFile) : null;
  if (!hhToken) return json(res, 403, { error: 'HH не подключён для этого профиля' });
  if (typeof hostRunMcpTool !== 'function') return json(res, 503, { error: 'host runMcpTool not provided' });

  let vacancyText = '';
  try {
    const vac = await hhFetch(`/vacancies/${vacancyId}`, hhToken);
    const desc = (vac.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
    const skills = (vac.key_skills || []).map(s => s.name).join(', ');
    vacancyText = [`Вакансия: ${vac.name || ''}`, desc && `Описание и требования:\n${desc}`, skills && `Ключевые навыки: ${skills}`]
      .filter(Boolean).join('\n\n');
  } catch (e) {
    console.error('[hh/ats-extract] vacancy fetch failed:', e.message);
    return json(res, 502, { error: `Не удалось получить текст вакансии с HH: ${e.message}` });
  }
  if (!vacancyText.trim()) return json(res, 422, { error: 'У вакансии на HH нет описания — критерии извлекать не из чего. Заполни описание вакансии или напиши критерии руками.' });

  let out;
  try {
    const text = await hostRunMcpTool({
      tool: 'hh_extract_ats_config',
      params: { vacancy_text: vacancyText, vacancy_id: String(vacancyId) },
      username,
      workDir: path.join(BASE_USERS_DIR, username),
      timeoutMs: 120_000,
    });
    out = JSON.parse(text || '{}');
  } catch (e) {
    console.error(`[hh/ats-extract] user=${username} vacancy=${vacancyId}:`, e.message);
    return json(res, 500, { error: e.message });
  }
  if (out && out.error) return json(res, 422, { error: out.error });
  return json(res, 200, { ok: true, config: out?.config || null, dropped_criteria: out?.dropped_criteria || [], replaced_criteria: out?.replaced_criteria || [] });
}

if (req.method === 'GET' && url.pathname === '/hh/ats-editor') {
  const username = url.searchParams.get('username') || '';
  const agentSecret = process.env.AGENT_SECRET || '';
  if (agentSecret) {
    const { createHmac } = require('crypto');
    const expected = createHmac('sha256', agentSecret).update(username).digest('hex').slice(0, 16);
    const given = url.searchParams.get('token') || '';
    if (given !== expected) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><html><body style="font-family:system-ui;padding:48px;text-align:center"><h2>Ссылка недействительна. Запроси новую у бота.</h2></body></html>');
    }
  }
  const { atsEditorHtml } = require('./hh-ats-editor-html');
  const { readAtsConfig, readAtsDraft } = require('./hh-scoring');
  // Must match BASE_USERS_DIR — Claude writes contexts here via cwd
  const workDir = path.join(BASE_USERS_DIR, username);
  const contextBase = path.join(workDir, 'contexts');
  let stagesFile = path.join(contextBase, 'hh', 'ats_stages.json');
  const activeVacancies = readActiveVacancies(workDir);
  const requestedVacancyId = url.searchParams.get('vacancy_id') || '';
  if (requestedVacancyId && !/^[a-zA-Z0-9_-]+$/.test(requestedVacancyId)) return json(res, 400, {error:'Invalid vacancy_id'});
  const activeVacancy = requestedVacancyId
    ? (activeVacancies.find(v => String(v.id) === requestedVacancyId) || {id:requestedVacancyId,title:''})
    : activeVacancies[0] || null;
  const scopedStagesFile = path.join(contextBase, 'hh', `ats_stages:${activeVacancy?.id || ''}.json`);
  if (fs.existsSync(scopedStagesFile)) stagesFile = scopedStagesFile;
  let configRevision = null;
  try {configRevision = JSON.parse(fs.readFileSync(path.join(contextBase,'hh',`ats_config:${activeVacancy?.id}.json`),'utf8')).updated_at || null;} catch {}
  let currentConfig = readAtsConfig(workDir, activeVacancy?.id || null);
  // No live config yet — offer the LLM-extracted draft (hh_extract_ats_config) as the
  // starting point instead. The draft never goes live on its own: it only reaches
  // scoring once the recruiter reviews it here and clicks Save.
  let isDraft = false;
  if (!currentConfig) {
    const draft = readAtsDraft(workDir, activeVacancy?.id || null);
    if (draft) { currentConfig = draft; isDraft = true; }
  }
  let currentStages = null;
  try {
    if (fs.existsSync(stagesFile)) currentStages = JSON.parse(fs.readFileSync(stagesFile, 'utf8')).value;
  } catch {}
  const migration = require('./hh-communication-plan').prepareLegacyPlan(currentConfig || {}, currentStages || []);
  if (currentConfig && !currentConfig.communication_plan) currentConfig = {...currentConfig, communication_plan:migration.plan};
  // Prefill from HH (issue #126). The editor used to demand a vacancy title and a
  // context the recruiter had to type by hand, and refuse to save without them — while
  // HH already knows both. Fill them in server-side, but only into fields that are
  // still empty, and never fail the page over it.
  const prefill = { vacancyTitle: activeVacancy?.title || '', vacancyContext: '' };
  if (activeVacancy?.id) {
    try {
      const tokenFile = path.join(tokensRoot(), String(username), 'hh');
      if (fs.existsSync(tokenFile)) {
        const tokenData = readHhTokenFile(tokenFile);
        // Hard 6s cap: HH being slow must not hold the editor hostage.
        const vac = await Promise.race([
          hhFetch(`/vacancies/${activeVacancy.id}`, tokenData),
          new Promise((_, reject) => setTimeout(() => reject(new Error('hh timeout')), 6000)),
        ]);
        prefill.vacancyContext = (vac.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
        if (vac.name) prefill.vacancyTitle = vac.name;
      }
    } catch { /* HH offline — editor opens with whatever the recruiter types */ }
  }
  if (currentConfig) {
    if (currentConfig.vacancy_title) prefill.vacancyTitle = '';
    if (currentConfig.vacancy_context) prefill.vacancyContext = '';
  }
  const callbackBase = browserApiBase(process.env, PORT);
  const html = atsEditorHtml(currentConfig, currentStages, {
    callbackBase,
    username,
    pageToken: agentSecret ? proactiveHmac(username) : '',
    vacancies: activeVacancies,
    activeVacancyId: activeVacancy?.id || '',
    isDraft,
    migration,
    configRevision,
    prefill,
  });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  return res.end(html);
}

if (req.method === 'POST' && url.pathname === '/hh/send') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  const { username, negotiation_id, message, force, force_stale } = body || {};
  if (!username || !negotiation_id || !message) return json(res, 400, { error: 'missing fields' });
  if (!pageAuthOk(req, username, body?.token)) return json(res, 403, { error: 'invalid token' });

  const hhTokensBase = tokensRoot();
  const tokenFile = path.join(hhTokensBase, String(username), 'hh');
  if (!fs.existsSync(tokenFile)) return json(res, 403, { error: 'HH not connected for this user' });
  const tokenData = readHhTokenFile(tokenFile);
  if (!tokenData) return json(res, 403, { error: 'HH token unreadable' });

  const releaseSendLock=acquireCandidateSendLock(username,negotiation_id);
  if(!releaseSendLock)return json(res,409,{ok:false,code:'SEND_IN_PROGRESS',error:'Отправка этому кандидату уже выполняется.'});
  try{
  const dataDir = dataRoot();
  const histDir = path.join(dataDir, 'hh', String(username), 'candidates');
  fs.mkdirSync(histDir, { recursive: true });
  const histFile = path.join(histDir, `${negotiation_id}.json`);
  const history = fs.existsSync(histFile) ? JSON.parse(fs.readFileSync(histFile, 'utf8')) : { messages: [] };
  history.messages = history.messages || [];

  // Per-vacancy guard scope (epic #112): the interview-time rules come from THIS
  // vacancy's ATS config, not a global singleton that spills one vacancy into another.
  let effectiveVacancyId=body?.vacancy_id||history.communication_snapshot?.context?.vacancy_id||history.vacancy_id||null;
  if (!effectiveVacancyId) {
    const vcFile = path.join(BASE_USERS_DIR, String(username), 'contexts', 'hh', 'active_vacancy.json');
    try { effectiveVacancyId = JSON.parse(fs.readFileSync(vcFile, 'utf8'))?.value?.id || null; } catch { /* no active vacancy */ }
  }
  const communicationSend=communicationEnabledFor(username,effectiveVacancyId)&&!!history.communication_steps;
  const refreshSendHistory=()=>refreshCommunicationHistory(history,negotiation_id,endpoint=>hhFetch(endpoint,tokenData));
  const persistSendHistory=()=>fs.writeFileSync(histFile,JSON.stringify(history,null,2),{mode:0o600});
  if(communicationSend){
    try{const previous=await reconcilePendingSend({history,message,refresh:refreshSendHistory,persist:persistSendHistory});if(previous?.delivered)return json(res,200,{ok:true,reconciled:true,send_event:previous.event});}
    catch(e){return json(res,503,{ok:false,error:e.message,code:e.code||'SEND_OUTCOME_UNKNOWN'});}
  }
  if(communicationEnabledFor(username,effectiveVacancyId)&&contactForbidden(history))return json(res,409,{ok:false,code:'CONTACT_FORBIDDEN',error:'Кандидат явно запретил дальнейший контакт.'});
  let staleOverrideReason=null;
  if(communicationEnabledFor(username,effectiveVacancyId)&&!history.communication_steps&&(message===history.ats_result?.draft_message||message===history.message_draft?.text)){
    if(!force_stale)return json(res,409,{ok:false,code:'STALE_COMMUNICATION_DRAFT',error:'Обновите черновик по сохранённому сценарию перед отправкой.'});
    staleOverrideReason='legacy draft has no saved communication state';
  }
  if (communicationEnabledFor(username,effectiveVacancyId) && history.communication_steps) {
    let currentResumeHash=null;
    try{const latest=await refreshCommunicationHistory(history,negotiation_id,endpoint=>hhFetch(endpoint,tokenData));await hydrateResume(latest,tokenData);if(latest._resume_status!=='full')throw new Error('Полное резюме HH недоступно для проверки актуальности.');currentResumeHash=resumeHash(latest);}catch(e){return json(res,503,{ok:false,code:'HH_FRESHNESS_UNAVAILABLE',error:e.message});}
    const {readAtsConfig}=require('./hh-scoring');
    const config=readAtsConfig(path.join(BASE_USERS_DIR,String(username)),effectiveVacancyId);
    if(staleCommunicationDraft(history,config||{},currentResumeHash,readCommunicationGenerationInputs({username,workDir:path.join(BASE_USERS_DIR,String(username)),vacancyId:effectiveVacancyId}))){
      if(!force_stale)return json(res,409,{ok:false,code:'STALE_COMMUNICATION_DRAFT',error:'Диалог или сценарий изменился. Обновите черновик перед отправкой.'});
      staleOverrideReason='dialogue or saved scenario changed';
    }
  }
  if(staleOverrideReason)console.warn('[hh/send] stale draft manually approved '+JSON.stringify({user:username,negotiation_id,reason:staleOverrideReason,message_hash:require('crypto').createHash('sha256').update(String(message)).digest('hex')}));
  const allowSpecificTime = hhInterviewConfigAllowsTime(username, effectiveVacancyId);
  const exactPlannedMaterial=communicationEnabledFor(username,effectiveVacancyId)&&history.communication_steps?.material&&message===history.communication_steps.message;
  const guard = exactPlannedMaterial?{ok:true,checks:{}}:await bullshitGuard(message, history.messages, { username, allowSpecificTime });
  if (!guard.ok) {
    if (!force) {
      console.warn(`[hh/send] guard blocked user=${username} neg=${negotiation_id} reason="${guard.reason}"`);
      appendGuardBlock(username, negotiation_id, guard.reason, guard.checks);
      return json(res, 200, { ok: false, blocked: true, reason: guard.reason, checks: guard.checks });
    }
    // Recruiter reviewed the block and chose to send anyway — this path is only
    // reachable from the single-candidate send buttons, never from sendAll(),
    // so a bulk blast can't self-override. Still logged for the guard history page.
    console.warn(`[hh/send] guard block FORCED by user=${username} neg=${negotiation_id} reason="${guard.reason}"`);
    appendGuardBlock(username, negotiation_id, `[отправлено вручную несмотря на блок] ${guard.reason}`, guard.checks, false);
  }
  if (guard.degraded) {
    console.warn(`[hh/send] guard degraded (semantic check skipped) user=${username} neg=${negotiation_id} checks=${JSON.stringify(guard.checks)}`);
    appendGuardBlock(username, negotiation_id, 'семантическая проверка пропущена (' + (guard.checks.llm_skipped || 'unknown') + ')', guard.checks, false);
  }
  if (guard.checks.invented_time) {
    appendGuardBlock(username, negotiation_id, 'сообщение упоминает время/дату — не блокирует отправку, только для истории', guard.checks, false);
  }

  const firstContact = !history.messages.some(m => m.role === 'employer');
  try {
    let delivery=null;
    const send=()=>hhPostForm(`/negotiations/${negotiation_id}/messages`,tokenData,{message});
    const sent=communicationSend?(delivery=await performCommunicationSend({history,message,send,refresh:refreshSendHistory,persist:persistSendHistory,source:force_stale?'http_manual_stale_override':'http'})).sent:await send();
    // Persist the id HH confirmed: without it the next sync re-added the same message
    // as a second copy (every outbound message looked like two sends — and the guard
    // read that inflated history). See src/hh-history.js.
    history.messages = appendLocalMessage(history, {
      role: 'employer', text: message,
      hhId: sent?.id ?? sent?.message?.id ?? null,
      timestamp: sent?.created_at || null,
    });
    fs.writeFileSync(histFile, JSON.stringify(history, null, 2), { mode: 0o600 });
    console.log(`[hh/send] user=${username} neg=${negotiation_id} len=${message.length}`);
    // Delivery already succeeded — answer now and move the stage afterwards. Awaiting
    // the negotiation fetch + stage move inline added up to 30 s of a dead-looking
    // spinner on the review page for a cosmetic HH state change.
    json(res, 200, { ok: true,...(delivery?{send_event:delivery.event,reconciled:delivery.reconciled}:{}) });
    if (firstContact) {
      (async () => {
        try {
          const negotiation = await hhFetch(`/negotiations/${negotiation_id}`, tokenData);
          if (negotiation.state?.id === 'response') {
            await hhPut(`/negotiations/consider/${negotiation_id}`, tokenData);
          }
        } catch (e) {
          console.warn('[hh/send] stage move to consider failed:', e.message);
        }
      })();
    }
    return;
  } catch (e) {
    console.error('[hh/send] error:', e.message);
    return json(res,e.code==='SEND_OUTCOME_UNKNOWN'?503:500,{ok:false,error:e.message,...(e.code?{code:e.code}:{})});
  }
  }finally{releaseSendLock();}
}

if (req.method === 'POST' && url.pathname === '/hh/generate-message') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const body = JSON.parse(await readBody(req));
  const { username, negotiation_id, resume_text, candidate_name, already_sent, message_type } = body || {};
  if (!username || !negotiation_id) return json(res, 400, { error: 'missing fields' });
  if (!pageAuthOk(req, username, body?.token)) return json(res, 403, { error: 'invalid token' });

  const hhTokensBase = tokensRoot();
  // Writing goes through our llm-ladder (src/conversation-generation.js) — the ladder
  // token replaces the old per-user OpenRouter key requirement for this route; the
  // guard still degrades gracefully without its own key (hh-bullshit-guard.js).
  if (!communicationEnabledFor(username,body?.vacancy_id) && !ladderToken()) return json(res, 503, { error: 'llm-ladder token not configured' });

  const styleFile = path.join(hhTokensBase, String(username), 'hh-message-style');
  const commStyle = readCredentialFileSafe(styleFile)?.trim() || null;
  const baseOverride = loadBaseOverride(hhTokensBase, username);

  // Read recruiter identity config (agency, name, signature, rules)
  let msgCfg = null;
  try {
    const msgCfgFile = path.join(BASE_USERS_DIR, String(username), 'contexts', 'hh', 'message_config.json');
    if (fs.existsSync(msgCfgFile)) {
      const raw = JSON.parse(fs.readFileSync(msgCfgFile, 'utf8'));
      let val = raw?.value;
      if (typeof val === 'string') val = JSON.parse(val);
      if (val && typeof val === 'object') msgCfg = val;
    }
  } catch { /* ignore */ }

  const dataDir = dataRoot();
  const candDir = path.join(dataDir, 'hh', String(username), 'candidates');
  const histFile = path.join(candDir, `${negotiation_id}.json`);
  const historyText=fs.existsSync(histFile)?fs.readFileSync(histFile,'utf8'):null;
  const history=historyText!==null?JSON.parse(historyText):{messages:[]};
  let msgs = history.messages || [];
  const hasPriorContact = msgs.some(m => m.role === 'employer');
  const candidateReplied = msgs.some(m => m.role === 'applicant');
  const msgType = message_type === 'rejection' ? 'rejection'
    : candidateReplied ? 'reply'
    : (already_sent || hasPriorContact ? 'followup' : 'initial');

  // Read HH token once — reused for resume fetch and vacancy fetch
  let hhToken = null;
  try {
    const hhTokenFile = path.join(hhTokensBase, String(username), 'hh');
    if (fs.existsSync(hhTokenFile)) hhToken = readHhTokenFile(hhTokenFile);
  } catch { /* ignore */ }

  if(communicationEnabledFor(username,body?.vacancy_id)&&hhToken){try{await refreshCommunicationHistory(history,negotiation_id,endpoint=>hhFetchWithRefresh(endpoint,hhToken,username,_secretsCache));msgs=history.messages||[];}catch(e){if(isHhAuthError(e))return json(res,401,hhAuthErrorResponse(e));return json(res,503,{error:e.message,code:'HH_FRESHNESS_UNAVAILABLE'});}}

  let sourceResumeHash=null;
  let fullResumeText = (resume_text || '').trim();
  if (hhToken) {
    try {
      const neg = await hhFetch(`/negotiations/${negotiation_id}`, hhToken);
      await hydrateResume(neg, hhToken);
      if (neg._resume_status === 'full'){fullResumeText = buildResumeText(neg);sourceResumeHash=resumeHash(neg);}else if(communicationEnabledFor(username,body?.vacancy_id))throw new Error('Полное резюме HH недоступно.');
    } catch(e) {if(communicationEnabledFor(username,body?.vacancy_id))return json(res,503,{error:e.message,code:'HH_PROFILE_UNAVAILABLE'}); /* legacy preview may use page text */ }
  }

  // Fetch vacancy description from HH API for targeted message generation
  let vacancyContext = '';
  if (hhToken) {
    try {
      const vacancyCtxFile = path.join(userWorkDir(username), 'contexts', 'hh', 'active_vacancy.json');
      const vacData = fs.existsSync(vacancyCtxFile) ? JSON.parse(fs.readFileSync(vacancyCtxFile, 'utf8'))?.value : null;
      if (vacData?.id) {
        const vac = await hhFetch(`/vacancies/${vacData.id}`, hhToken);
        const descText = (vac.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
        const skills = (vac.key_skills || []).map(s => s.name).join(', ');
        const parts = [`Вакансия: ${vac.name || ''}`];
        if (descText) parts.push('Описание и требования:\n' + descText);
        if (skills) parts.push('Ключевые навыки: ' + skills);
        vacancyContext = parts.join('\n\n');
      }
    } catch { /* ignore — generate without vacancy context */ }
  }

  // Read the ATS config the way the rest of the pipeline does: per-vacancy first
  // (ats_config:{id}), legacy singleton as fallback. This route used to read ONLY
  // the singleton, so on a multi-vacancy profile the button generated a letter with
  // another vacancy's availability block and no test task at all.
  const vacancyId = (body?.vacancy_id || '') || null;
  const vacancyCtxFile = path.join(BASE_USERS_DIR, String(username), 'contexts', 'hh', 'active_vacancy.json');
  let effectiveVacancyId = vacancyId;
  if (!effectiveVacancyId && fs.existsSync(vacancyCtxFile)) {
    try { effectiveVacancyId = JSON.parse(fs.readFileSync(vacancyCtxFile, 'utf8'))?.value?.id || null; } catch { /* ignore */ }
  }
  const { readAtsConfig } = require('./hh-scoring');
  const atsConfig = readAtsConfig(BASE_USERS_DIR ? path.join(BASE_USERS_DIR, String(username)) : process.cwd(), effectiveVacancyId);
  const interviewConfig = atsConfig?.interview_config || null;
  const availabilityBlock = buildAvailabilityBlock(interviewConfig);
  const vacancyInstruction = resolveMessageInstructions({ username, tokensBase: hhTokensBase, atsConfig });

  if (communicationEnabledFor(username,body?.vacancy_id)) {
    try {
      const readGenerationInputs=()=>readCommunicationGenerationInputs({username,workDir:path.join(BASE_USERS_DIR,String(username)),vacancyId:effectiveVacancyId});
      const assertFresh=captureGenerationGuard({historyFile:histFile,expectedHistoryText:historyText,readInputs:readGenerationInputs,expectedInputs:{atsConfig:atsConfig||{},communicationStyle:commStyle||undefined,senderProfile:msgCfg||{}}});
      assertFresh();
      const result=await generateAndStoreCommunication(history,{
        assertFresh,atsConfig:atsConfig||{},sourceResumeHash,resumeText:fullResumeText,candidateName:candidate_name||'',
        senderProfile:msgCfg||{},communicationStyle:commStyle||undefined,
        context:{vacancy_id:effectiveVacancyId},
        ...(msgType==='rejection'?{forceGoal:{instruction:'Напиши вежливый отказ кандидату, сохраняя фактические условия вакансии.'}}:{})
      });
      fs.mkdirSync(candDir,{recursive:true});
      fs.writeFileSync(histFile,JSON.stringify(history,null,2),{mode:0o600});
      return json(res,200,{ok:true,message:result.message||'',funnel_action:result.action,funnel_reason:result.reason,communication_steps:result.steps});
    } catch(e) {
      console.error('[hh/communication] '+JSON.stringify({code:e.code||'COMMUNICATION_FAILED',stage:e.communication_stage||null,request_id:e.request_id||null,provider_status:e.status||null,provider_attempts:e.provider_attempts??null,metrics:e.communication_metrics||null}));
      return json(res,e.code==='PLAN_REVIEW_REQUIRED'?409:503,communicationFailurePayload(e));
    }
  }

  const recruiterCtx = buildRecruiterIdentity(msgCfg);
  const systemPrompt = msgType === 'rejection'
    ? buildRejectionSystemPrompt({ recruiterCtx, commStyle })
    : buildMessageSystemPrompt({ vacancyContext, recruiterCtx, commStyle, baseOverride, vacancyInstruction, atsConfig });

  const firstName = (candidate_name || 'Кандидат').split(' ')[0];
  const ats = history.ats_result || {};

  // Funnel decides the step, the writer only renders it (01.10.2026). A rejection
  // the recruiter explicitly asked for bypasses the planner.
  let plan = null;
  if (msgType !== 'rejection') {
    plan = await planNextStep({
      history: msgs,
      atsResult: ats,
      atsConfig: atsConfig || {},
      resumeText: fullResumeText,
      username,
    });
  }

  const userMsg = msgType === 'rejection'
    ? `Напиши вежливый отказ кандидату ${firstName}.`
    : buildDraftUserMessage({
      messageType: msgType,
      firstName,
      resumeText: fullResumeText,
      atsResult: ats,
      history: msgs,
      availabilityBlock,
      action: plan ? plan.action : null,
      missingSkills: plan?.missing_skills || [],
      testTask: legacyTestTask(atsConfig),
      vacancyInstruction,
    });

  function callLlm(userContent) {
    // One abstraction for every candidate-message write: ladder 'conversation'
    // (gemini-3.1-flash-lite-preview first), exchange recorded for the bench.
    return generateConversation({
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
      temperature: 0.7,
      maxTokens: 800,
      source: 'hh-generate-message',
    });
  }

  try {
    // Guard's primary job is feeding the generator, not just gatekeeping at send
    // time: draft, check, and if it fails on something the model can fix (placeholder,
    // repeated question/intro, template garbage), regenerate once telling it exactly
    // what was wrong. Only a still-failing second attempt reaches the recruiter as a
    // visible warning — invented_time is informational-only so it never triggers this.
const allowSpecificTime = hhInterviewConfigAllowsTime(username, effectiveVacancyId);
    // The test task is the one letter that must NOT be written by a model: the
    // vacancy promises it goes out word-for-word.
    let message = plan?.action === 'send_test'
      ? (buildTestTaskMessage(legacyTestTask(atsConfig)) || await callLlm(userMsg))
      : await callLlm(userMsg);
    let guard = await bullshitGuard(message, msgs, { username, allowSpecificTime, resumeText: fullResumeText });
    if (!guard.ok) {
      console.warn(`[hh/generate-message] draft failed guard, regenerating: user=${username} neg=${negotiation_id} reason="${guard.reason}"`);
      const retryMsg = `${userMsg}\n\n(Предыдущая попытка была отклонена автопроверкой: "${guard.reason}". Не повторяй эту ошибку — напиши новый вариант без неё.)`;
      message = await callLlm(retryMsg);
      guard = await bullshitGuard(message, msgs, { username, allowSpecificTime, resumeText: fullResumeText });
    }

    if (!history.ats_result) history.ats_result = {};
    history.ats_result.draft_message = message;
    // Stamp the thread this draft answers, so the background auto-draft knows it is
    // still current and does not overwrite a manual draft with a stale-looking one.
    history.ats_result.draft_history_sig = historySignature(msgs, vacancyInstruction, atsConfig);
    if (!guard.ok) history.ats_result.draft_warning = guard.reason;
    else delete history.ats_result.draft_warning;
    fs.mkdirSync(candDir, { recursive: true });
    fs.writeFileSync(histFile, JSON.stringify(history, null, 2), { mode: 0o600 });
    const resp = { ok: true, message };
    if (plan) { resp.funnel_action = plan.action; resp.funnel_reason = plan.reason; }
    if (!guard.ok) resp.guard_warning = guard.reason;
    // Vacancy without ATS criteria is a legitimate state (issue #126): the letter is
    // written and saved, but the background loop skips this vacancy — tell the page
    // so it can point the recruiter at the editor instead of failing silently.
    if (!atsConfig) resp.no_ats_config = true;
    return json(res, 200, resp);
  } catch (e) {
    console.error('[hh/generate-message] error:', e.message);
    return json(res, 500, { error: e.message });
  }
}

if (req.method === 'POST' && url.pathname === '/hh/reject') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const body = JSON.parse(await readBody(req));
  const { username, negotiation_ids } = body || {};
  if (!username || !Array.isArray(negotiation_ids) || negotiation_ids.length === 0) {
    return json(res, 400, { error: 'missing fields' });
  }
  if (!pageAuthOk(req, username, body?.token)) return json(res, 403, { error: 'invalid token' });
  const hhTokensBase2 = tokensRoot();
  const tokenFile2 = path.join(hhTokensBase2, String(username), 'hh');
  if (!fs.existsSync(tokenFile2)) return json(res, 403, { error: 'HH not connected for this user' });
  const tokenData2 = readHhTokenFile(tokenFile2);
  if (!tokenData2) return json(res, 403, { error: 'HH token unreadable' });
  const results = [];
  for (const negId of negotiation_ids) {
    try {
      await hhPut(`/negotiations/${REJECT_REASON_ACTION}/${negId}`, tokenData2);
      results.push({ negotiation_id: negId, ok: true });
    } catch (e) { results.push({ negotiation_id: negId, ok: false, error: e.message }); }
  }
  const failed = results.filter(r => !r.ok).length;
  console.log(`[hh/reject] user=${username} total=${negotiation_ids.length} failed=${failed}`);
  return json(res, 200, { ok: true, results });
}

if (req.method === 'POST' && url.pathname === '/hh/send-and-reject') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const body = JSON.parse(await readBody(req));
  const { username, negotiation_id, force } = body || {};
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!username || !negotiation_id || !message) return json(res, 400, { error: 'missing fields' });
  if (!pageAuthOk(req, username, body?.token)) return json(res, 403, { error: 'invalid token' });

  const hhTokensBase = tokensRoot();
  const tokenFile = path.join(hhTokensBase, String(username), 'hh');
  if (!fs.existsSync(tokenFile)) return json(res, 403, { error: 'HH not connected for this user' });
  const tokenData = readHhTokenFile(tokenFile);
  if (!tokenData) return json(res, 403, { error: 'HH token unreadable' });

  const releaseSendLock=acquireCandidateSendLock(username,negotiation_id);
  if(!releaseSendLock)return json(res,409,{ok:false,code:'SEND_IN_PROGRESS',error:'Отправка этому кандидату уже выполняется.'});
  try{
  const dataDir2 = dataRoot();
  const histDir2 = path.join(dataDir2, 'hh', String(username), 'candidates');
  fs.mkdirSync(histDir2, { recursive: true });
  const histFile2 = path.join(histDir2, `${negotiation_id}.json`);
  const history2 = fs.existsSync(histFile2) ? JSON.parse(fs.readFileSync(histFile2, 'utf8')) : { messages: [] };
  history2.messages = history2.messages || [];

  // A persisted operation resumes only the HH stage (or asks for reconciliation).
  // Rechecking its already-delivered message trips the duplicate-message guard
  // before sendRejection can perform the safe stage-only retry.
  const resumeOnly = ['message_sent', 'done', 'sending', 'unknown', 'discarding'].includes(history2.rejection_operation?.status);
  if(!resumeOnly&&communicationEnabledFor(username,body?.vacancy_id||history2.vacancy_id||history2.communication_snapshot?.context?.vacancy_id)&&contactForbidden(history2))return json(res,409,{ok:false,code:'CONTACT_FORBIDDEN',error:'Кандидат явно запретил дальнейший контакт.'});
  if(!resumeOnly&&communicationEnabledFor(username,body?.vacancy_id||history2.vacancy_id||history2.communication_snapshot?.context?.vacancy_id)&&history2.communication_steps){
    let currentResumeHash=null;
    try{const latest=await refreshCommunicationHistory(history2,negotiation_id,endpoint=>hhFetch(endpoint,tokenData));await hydrateResume(latest,tokenData);if(latest._resume_status!=='full')throw new Error('Полное резюме HH недоступно для проверки актуальности.');currentResumeHash=resumeHash(latest);}catch(e){return json(res,503,{ok:false,code:'HH_FRESHNESS_UNAVAILABLE',error:e.message});}
    const {readAtsConfig}=require('./hh-scoring');
    const vid=body?.vacancy_id||history2.vacancy_id||history2.communication_snapshot?.context?.vacancy_id;
    const config=readAtsConfig(path.join(BASE_USERS_DIR,String(username)),vid);
    if(staleCommunicationDraft(history2,config||{},currentResumeHash,readCommunicationGenerationInputs({username,workDir:path.join(BASE_USERS_DIR,String(username)),vacancyId:vid})))return json(res,409,{ok:false,code:'STALE_COMMUNICATION_DRAFT',error:'Диалог или сценарий изменился. Обновите черновик перед отправкой.'});
  }
  const guard2 = resumeOnly ? { ok: true, checks: {} } : await bullshitGuard(message, history2.messages, { username });
  if (!guard2.ok) {
    if (!force) {
      console.warn(`[hh/send-and-reject] guard blocked user=${username} neg=${negotiation_id} reason="${guard2.reason}"`);
      appendGuardBlock(username, negotiation_id, guard2.reason, guard2.checks);
      return json(res, 200, { ok: false, blocked: true, reason: guard2.reason, checks: guard2.checks });
    }
    console.warn(`[hh/send-and-reject] guard block FORCED by user=${username} neg=${negotiation_id} reason="${guard2.reason}"`);
    appendGuardBlock(username, negotiation_id, `[отправлено вручную несмотря на блок] ${guard2.reason}`, guard2.checks, false);
  }
  if (guard2.degraded) {
    console.warn(`[hh/send-and-reject] guard degraded (semantic check skipped) user=${username} neg=${negotiation_id} checks=${JSON.stringify(guard2.checks)}`);
    appendGuardBlock(username, negotiation_id, 'семантическая проверка пропущена (' + (guard2.checks.llm_skipped || 'unknown') + ')', guard2.checks, false);
  }
  if (guard2.checks.invented_time) {
    appendGuardBlock(username, negotiation_id, 'сообщение упоминает время/дату — не блокирует отправку, только для истории', guard2.checks, false);
  }

  try {
    const result = await sendRejection({
      historyFile: histFile2,
      message,
      send: text => hhPostForm(`/negotiations/${negotiation_id}/messages`, tokenData, { message: text }),
      discard: () => hhPut(`/negotiations/${REJECT_REASON_ACTION}/${negotiation_id}`, tokenData),
    });
    console.log(`[hh/send-and-reject] user=${username} neg=${negotiation_id} ok=${result.ok}`);
    return json(res, 200, result);
  } catch (e) {
    console.error('[hh/send-and-reject] error:', e.message);
    return json(res, 500, { error: e.message });
  }
  }finally{releaseSendLock();}
}

if (req.method === 'GET' && url.pathname === '/hh/style') {
  const username = url.searchParams.get('username') || '';
  const agentSecret = process.env.AGENT_SECRET || '';
  const errStylePage = (msg) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Стиль общения</title>
<style>body{font-family:system-ui;padding:48px;text-align:center;background:#f8fafc;color:#1e293b}</style>
</head><body><h2>${msg}</h2></body></html>`);
  };
  if (agentSecret) {
    const { createHmac } = require('crypto');
    const expected = createHmac('sha256', agentSecret).update(username).digest('hex').slice(0, 16);
    if ((url.searchParams.get('token') || '') !== expected) return errStylePage('Ссылка недействительна. Запроси новую у бота.');
  }
  if (!username) return errStylePage('Не указан пользователь.');
  const hhTokensBase3 = tokensRoot();
  const styleFile3 = path.join(hhTokensBase3, String(username), 'hh-message-style');
  const existingStyle = readCredentialFileSafe(styleFile3)?.trim() || '';
  const callbackBase3 = browserApiBase(process.env, PORT);
  const hmacToken3 = agentSecret ? require('crypto').createHmac('sha256', agentSecret).update(username).digest('hex').slice(0, 16) : '';
  const defaultStyle = '- Тон: профессиональный, дружелюбный, без официоза. Обращение на «вы».\n- Приветствие: «Добрый день, [Имя]!» или «Здравствуйте, [Имя]!»\n- Структура: приветствие → что понравилось в резюме → описание роли → 1-2 конкретных вопроса → призыв ответить\n- Всегда задаю конкретные вопросы по опыту из требований вакансии, не общие\n- Не использую штампы: «рассмотрели вашу кандидатуру», «вакансия открылась», «мы ищем»\n- Длина: 4-6 предложений\n- Подпись: имя рекрутера';
  const rulesValue = (existingStyle || defaultStyle).replace(/`/g, '\\`');
  const existingBase = loadBaseOverride(hhTokensBase3, username) || '';
  const hasBaseOverride = !!existingBase;
  const baseValue = (existingBase || DEFAULT_MESSAGE_BASE).replace(/`/g, '\\`');
  const instructionsOverride = loadInstructionsTemplate(hhTokensBase3, username) || '';
  const hasInstructionsOverride = !!instructionsOverride;
  const instructionsValue = (instructionsOverride || DEFAULT_MESSAGE_INSTRUCTIONS).replace(/`/g, '\\`');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  return res.end(hhStylePageHtml({ username, rulesValue, baseValue, hasBaseOverride, instructionsValue, hasInstructionsOverride, callbackBase: callbackBase3, hmacToken: hmacToken3 }));
}

if (req.method === 'POST' && url.pathname === '/hh/update-style') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const body4 = JSON.parse(await readBody(req));
  const { username, token: givenToken, examples, direct = false, save: doSave = true } = body4 || {};
  if (!username || !examples || typeof examples !== 'string') return json(res, 400, { error: 'missing fields' });
  if (!direct && examples.trim().length < 50) return json(res, 400, { error: 'examples too short' });
  const agentSecret4 = process.env.AGENT_SECRET || '';
  if (agentSecret4) {
    const { createHmac } = require('crypto');
    const expected4 = createHmac('sha256', agentSecret4).update(String(username)).digest('hex').slice(0, 16);
    if (givenToken !== expected4) return json(res, 403, { error: 'invalid token' });
  }
  const hhTokensBase4 = tokensRoot();

  // direct mode: save as-is without AI
  if (direct) {
    fs.mkdirSync(path.join(hhTokensBase4, String(username)), { recursive: true });
    const styleFile = path.join(hhTokensBase4, String(username), 'hh-message-style');
    writeCredentialFile(styleFile, examples.trim());
    console.log('[hh/update-style] direct save for', username, 'len=', examples.length);
    return json(res, 200, { ok: true, style: examples.trim() });
  }

  if (!ladderToken()) return json(res, 503, { error: 'LLM не настроен (нет llm-ladder токена)' });


  const systemPrompt4 = 'Ты — аналитик коммуникаций. Тебе могут прислать отдельные сообщения рекрутера ИЛИ полные диалоги между рекрутером и кандидатом. Если это диалог — проанализируй только сообщения рекрутера, проигнорируй ответы кандидата.\n\nСоставь краткое описание стиля общения рекрутера. Это описание будет использоваться как инструкция для нейросети при генерации новых сообщений.\n\nФормат — структурированный список на русском языке (через дефис):\n- Тон и манера (формальность, теплота)\n- Характерные обороты и приветствия (с реальными примерами из текста)\n- Структура типичного сообщения\n- Что обычно уточняет или спрашивает\n- Чего избегает\n- Длина сообщений\n\nБудь конкретным — цитируй реальные фразы из примеров.';
  const userMsg4 = 'Примеры (могут быть диалоги или отдельные сообщения рекрутера):\n\n' + examples.trim().slice(0, 4000);

  try {
    // Style analysis is a text transformation — DEFAULT ladder (src/hh-llm.js).
    const style = await hhLlm({
      messages: [{ role: 'system', content: systemPrompt4 }, { role: 'user', content: userMsg4 }],
      purpose: 'default',
      temperature: 0.3,
      maxTokens: 600,
      source: 'hh-style',
    });

    if (doSave !== false) {
      fs.mkdirSync(path.join(hhTokensBase4, String(username)), { recursive: true });
      const styleFile = path.join(hhTokensBase4, String(username), 'hh-message-style');
      writeCredentialFile(styleFile, style.trim());
      console.log('[hh/update-style] saved style for', username, 'len=', style.length);
    }
    return json(res, 200, { ok: true, style });
  } catch (e) {
    console.error('[hh/update-style] error:', e.message);
    return json(res, 500, { error: 'generation failed: ' + e.message });
  }
}

if (req.method === 'POST' && url.pathname === '/hh/update-base-prompt') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const body5 = JSON.parse(await readBody(req));
  const { username, token: givenToken5, text, reset = false } = body5 || {};
  if (!username) return json(res, 400, { error: 'missing fields' });
  const agentSecret5 = process.env.AGENT_SECRET || '';
  if (agentSecret5) {
    const { createHmac } = require('crypto');
    const expected5 = createHmac('sha256', agentSecret5).update(String(username)).digest('hex').slice(0, 16);
    if (givenToken5 !== expected5) return json(res, 403, { error: 'invalid token' });
  }
  const hhTokensBase5 = tokensRoot();
  const baseFile5 = path.join(hhTokensBase5, String(username), BASE_PROMPT_FILENAME);

  if (reset) {
    // file + .meta sidecar + .index.json entry — a stale sidecar would make the
    // next read throw instead of falling back to the default prompt.
    try { deleteCredential(username, BASE_PROMPT_FILENAME); } catch { /* already absent */ }
    console.log('[hh/update-base-prompt] reset to default for', username);
    return json(res, 200, { ok: true, text: DEFAULT_MESSAGE_BASE });
  }

  if (!text || typeof text !== 'string' || text.trim().length < 50) {
    return json(res, 400, { error: 'text too short' });
  }
  fs.mkdirSync(path.join(hhTokensBase5, String(username)), { recursive: true });
  writeCredentialFile(baseFile5, text.trim());
  console.log('[hh/update-base-prompt] saved override for', username, 'len=', text.length);
  return json(res, 200, { ok: true });
}

// Epic #112: the global «Инструкция для сообщений кандидатам» template — the per-
// vacancy instruction's starting point on /hh/style and the ATS editor's
// «Вернуть общий шаблон». Read by the editor at click time (no re-render needed).
if (req.method === 'GET' && url.pathname === '/hh/message-instructions-template') {
  // The editor page runs on the recruiter's publish domain while CALLBACK_BASE points at
  // AGENT_PUBLIC_URL, so this GET is cross-origin — and it was the only /hh/* route
  // without Access-Control-Allow-Origin. The browser dropped the (correct) 200 body and
  // «Вернуть общий шаблон» failed with "Failed to fetch" instead of filling the field.
  res.setHeader('Access-Control-Allow-Origin', '*');
  const username = url.searchParams.get('username') || '';
  const agentSecret6 = process.env.AGENT_SECRET || '';
  if (agentSecret6) {
    const { createHmac } = require('crypto');
    const expected6 = createHmac('sha256', agentSecret6).update(String(username)).digest('hex').slice(0, 16);
    if ((url.searchParams.get('token') || '') !== expected6) return json(res, 403, { error: 'invalid token' });
  }
  if (!username) return json(res, 400, { error: 'username required' });
  const template = loadInstructionsTemplate(tokensRoot(), username) || DEFAULT_MESSAGE_INSTRUCTIONS;
  return json(res, 200, { ok: true, text: template });
}

if (req.method === 'POST' && url.pathname === '/hh/update-instructions-template') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const body6 = JSON.parse(await readBody(req));
  const { username, token: givenToken6, text, reset = false } = body6 || {};
  if (!username) return json(res, 400, { error: 'missing fields' });
  const agentSecret6b = process.env.AGENT_SECRET || '';
  if (agentSecret6b) {
    const { createHmac } = require('crypto');
    const expected6b = createHmac('sha256', agentSecret6b).update(String(username)).digest('hex').slice(0, 16);
    if (givenToken6 !== expected6b) return json(res, 403, { error: 'invalid token' });
  }
  const hhTokensBase6 = tokensRoot();
  const templateFile6 = path.join(hhTokensBase6, String(username), INSTRUCTIONS_TEMPLATE_FILENAME);

  if (reset) {
    try { deleteCredential(username, INSTRUCTIONS_TEMPLATE_FILENAME); } catch { /* already absent */ }
    console.log('[hh/update-instructions-template] reset to default for', username);
    return json(res, 200, { ok: true, text: DEFAULT_MESSAGE_INSTRUCTIONS });
  }

  if (!text || typeof text !== 'string' || text.trim().length < 10) {
    return json(res, 400, { error: 'text too short' });
  }
  fs.mkdirSync(path.join(hhTokensBase6, String(username)), { recursive: true });
  writeCredentialFile(templateFile6, text.trim());
  console.log('[hh/update-instructions-template] saved override for', username, 'len=', text.length);
  return json(res, 200, { ok: true });
}

if (req.method === 'POST' && url.pathname === '/hh/sync-negotiations') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const body = JSON.parse(await readBody(req));
  const { username: syncUser, vacancy_id: syncVacancyId, token: syncAuth } = body || {};
  if (process.env.AGENT_SECRET && syncAuth !== proactiveHmac(syncUser) && req.headers.authorization !== `Bearer ${process.env.AGENT_SECRET}`) return json(res, 403, { error: 'Invalid token' });
  if (![syncUser, syncVacancyId].every(x => /^[a-zA-Z0-9_-]+$/.test(String(x || '')))) return json(res, 400, { error: 'Invalid scope' });
  const hhTokensBase = tokensRoot();
  const syncTokenFile = path.join(hhTokensBase, String(syncUser), 'hh');
  if (!fs.existsSync(syncTokenFile)) return json(res, 403, { error: 'HH not connected' });
  if (!readActiveVacancies(path.join(BASE_USERS_DIR, syncUser)).some(v => String(v.id) === String(syncVacancyId))) return json(res, 403, { error: 'Unknown vacancy' });
  const syncTokenData = readHhTokenFile(syncTokenFile);
  if (!syncTokenData) return json(res, 403, { error: 'HH token unreadable' });
  const syncDataDir = dataRoot();
  try {
    const { negotiations, synced_at } = await getHhNegotiationsWithCache(syncDataDir, syncUser, syncVacancyId, syncTokenData.access_token, { force: true });
    console.log(`[hh/sync] user=${syncUser} vacancy=${syncVacancyId} count=${negotiations.length}`);
    return json(res, 200, { ok: true, count: negotiations.length, synced_at });
  } catch (e) {
    console.error('[hh/sync] error:', e.message);
    if (isHhAuthError(e)) return json(res, 401, hhAuthErrorResponse(e));
    return json(res, 502, { error: e.message, code: 'HH_SYNC_FAILED' });
  }
}

if (req.method === 'GET' && url.pathname === '/hh/proactive') {
  const username = url.searchParams.get('username') || '';
  const given = url.searchParams.get('token') || '';
  if (process.env.AGENT_SECRET && given !== proactiveHmac(username)) {
    return proactiveErrPage('Ссылка недействительна. Запроси новую у бота.');
  }
  const workDir = path.join(BASE_USERS_DIR, username);
  const activeVacancies = readActiveVacancies(workDir);
  const requestedVacancyId = url.searchParams.get('vacancy_id') || '';
  const vacancyId = requestedVacancyId || activeVacancies[0]?.id || '';
  const file = latestProactiveFile(username, vacancyId);
  let results = { vacancy_id: vacancyId, vacancy_title: activeVacancies.find(v => String(v.id) === String(vacancyId))?.title || 'Вакансия', candidates: [], search_queries: [], total_collected: 0, total_after_knockout: 0 };
  if (file) {
    try { results = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return proactiveErrPage('Ошибка чтения данных.'); }
  }
  const callbackBase = publicPageBase(username, COLD_SEARCH_ENV, 'https://recruiter-assistant.ru');
  const { loadCandidateComments, loadAllCandidates, candidateMatchesVacancy, candidateStatusOf } = require('./hh-proactive-search');
  const pageComments = loadCandidateComments(username, vacancyId);
  // Render from the unified all-candidates store (search + manual, accumulated
  // across runs) rather than only the latest search-results snapshot — keeps the
  // rest of `results` (vacancy_title, stats, searched_at) from the snapshot.
  // Records with no vacancy_ids (pre-step-7 data, or manually added with no active
  // vacancy resolvable) are a wildcard and show up under every tab.
  const byVacancy = Object.values(loadAllCandidates(username, vacancyId)).filter(c => candidateMatchesVacancy(c, vacancyId));
  // Triage state tabs: a candidate lives in exactly one of active/starred/archived
  // (see hh-proactive-search.js candidateStatusOf) — starring or archiving moves it
  // out of the other tabs entirely instead of just dimming it in place.
  const requestedList = url.searchParams.get('list') || 'active';
  const listView = ['active', 'starred', 'archived'].includes(requestedList) ? requestedList : 'active';
  const stateCounts = { active: 0, starred: 0, archived: 0 };
  for (const c of byVacancy) stateCounts[candidateStatusOf(c)]++;
  let unified = byVacancy.filter(c => candidateStatusOf(c) === listView);
  if (listView === 'active') {
    // Main feed: rank by the ATS-funnel score, not by recency; not-yet-scored last.
    unified.sort(require('./hh-proactive-search').compareByAtsScore);
    // Fallback for the very first run, before anything has been merged into the
    // unified store yet — show the freshly-computed (already score-sorted) results.
    if (!byVacancy.length) unified = results.candidates || [];
  } else {
    // Starred/archived: most recently moved into this tab first.
    unified.sort((a, b) => new Date(b.status_changed_at || 0) - new Date(a.status_changed_at || 0));
  }
  results.candidates = unified;
  const monitoring = await coldSearchMonitoring(username, workDir, vacancyId);
  let searchSettings = null;
  if (vacancyId) {
    try { searchSettings = require('./hh-proactive-search').searchSettingsView(username, vacancyId); }
    catch (e) { console.error('[hh/proactive] search settings read failed:', e.message); }
  }
  const searchJob = vacancyId ? require('./hh-proactive-search-job').active(username, vacancyId) : null;
  let atsProgress = null;
  if (vacancyId) {
    try { atsProgress = require('./hh-proactive-search').getAtsRefreshProgress(username, vacancyId); }
    catch (e) { console.error('[hh/proactive] ATS progress read failed:', e.message); }
  }
  // A pre-existing backlog may have been created before this page learned to
  // trigger rescoring on ATS save. Opening the vacancy page is also a natural
  // recovery point: start one bounded background pass whenever work is queued.
  if (atsProgress?.pending > 0 && atsProgress.status === 'queued') {
    setImmediate(() => scoreUnscoredProactiveCandidates(username, { vacancyId: String(vacancyId) }).catch(error => {
      console.error(`[hh/proactive] cold-search rescore failed for vacancy=${vacancyId}:`, error.message);
    }));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  return res.end(generateProactivePageHtml(results, username, callbackBase, given, pageComments, { activeVacancies, vacancyId, listView, stateCounts, monitoring, searchSettings, searchJob, atsProgress }));
}

// ── Recruiting hub v1 (#1742, UX spec docs/specs/recruiting-web-hub-and-playbook-launch-ux.md) ──

if (req.method === 'GET' && url.pathname === '/hh/vacancies') {
  const username = url.searchParams.get('username') || '';
  const given = url.searchParams.get('token') || '';
  const errPage = (msg) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Вакансии</title>
<style>body{font-family:system-ui;padding:48px;text-align:center;background:#f1f5f9;color:#1e293b}</style>
</head><body><h2>${msg}</h2></body></html>`);
  };
  if (!hhHub.SAFE_ID.test(username)) return errPage('Не указан пользователь.');
  if (process.env.AGENT_SECRET && given !== proactiveHmac(username)) return errPage('Ссылка недействительна. Запроси новую у бота.');
  const { cards, lastScoredAt, hhConnected } = hhHub.collectVacancyCards({ workDir: path.join(BASE_USERS_DIR, username), username });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  return res.end(vacanciesPageHtml({ username, token: given, cards, lastScoredAt, hhConnected }));
}

// «▶ Собрать»: compile + activate the launch playbook as a durable plan (no engine
// session) and push the status link to the profile's Telegram chat.
if (req.method === 'POST' && url.pathname === '/hh/playbook-run') {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  const { username, token, vacancy_id, goal, playbook_id } = body || {};
  if (![username, vacancy_id].every(x => hhHub.SAFE_ID.test(String(x || '')))) return json(res, 400, { error: 'Invalid scope' });
  if (process.env.AGENT_SECRET && token !== proactiveHmac(username)) return json(res, 403, { error: 'Invalid token' });
  if (playbook_id && playbook_id !== hhHub.LAUNCH_PLAYBOOK_ID) return json(res, 400, { error: 'Unknown playbook' });
  if (!hhHub.hhConnected(username)) return json(res, 409, { error: 'HH не подключён. Скажи боту «подключи HH».' });
  const workDir = path.join(BASE_USERS_DIR, username);
  const draft = hhHub.findLaunchableDraft(workDir, vacancy_id);
  if (!draft) return json(res, 409, { error: 'Черновик не готов — доскажи драфт боту, /new_job_post' });
  const goalText = (typeof goal === 'string' && goal.trim() ? goal.trim() : hhHub.launchGoal(draft.vacancy_title)).slice(0, 300);
  let result;
  try {
    result = await hhHub.runLaunchPlaybook({ runMcpTool: hostRunMcpTool, username, workDir, draft, goal: goalText });
  } catch (e) {
    console.error(`[hh/playbook-run] user=${username} vacancy=${vacancy_id}:`, e.message);
    return json(res, e.status || 500, { error: e.message });
  }
  const taskId = result.task.id;
  const statusPath = hhHub.planStatusPath(username, token, taskId);
  // Telegram push runs alongside the answer; it never fails the launch.
  hhHub.notifyLaunch({ notifyProfile: ctx.notifyProfile, username, goal: goalText, statusUrl: hhHub.publicBase(username) + statusPath })
    .catch(e => console.warn('[hh/playbook-run] notify error:', e.message));
  console.log(`[hh/playbook-run] user=${username} vacancy=${vacancy_id} task=${taskId}`);
  return json(res, 200, { task_id: taskId, status: result.task.status, status_url: statusPath });
}

if (req.method === 'GET' && url.pathname === '/hh/plan') {
  const username = url.searchParams.get('username') || '';
  const given = url.searchParams.get('token') || '';
  const taskId = url.searchParams.get('task_id') || '';
  const wantJson = url.searchParams.get('format') === 'json';
  const fail = (status, msg) => {
    if (wantJson) return json(res, status, { error: msg });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(planPageHtml({ username, token: given, taskId, error: msg }));
  };
  if (![username, taskId].every(x => hhHub.SAFE_ID.test(x))) return fail(400, 'Не указан процесс.');
  if (process.env.AGENT_SECRET && given !== proactiveHmac(username)) return fail(403, 'Ссылка недействительна. Запроси новую у бота.');
  let data;
  try {
    if (!hostRunMcpTool) throw new Error('host runMcpTool not provided');
    data = JSON.parse(await hostRunMcpTool({ tool: 'task_get', params: { task_id: taskId }, username, workDir: path.join(BASE_USERS_DIR, username), timeoutMs: 20000 }) || '{}');
  } catch (e) {
    console.error(`[hh/plan] user=${username} task=${taskId}:`, e.message);
    return fail(502, 'Не удалось получить статус процесса.');
  }
  if (data.error || !data.task) return fail(404, 'Процесс не найден.');
  res.setHeader('Cache-Control', 'no-store');
  if (wantJson) return json(res, 200, { task: data.task, items: data.items || [] });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  return res.end(planPageHtml({ username, token: given, taskId, data }));
}

// ── Портрет вакансии (#85, эпик #83): страница «положить информацию по вакансии»,
// donut-полнота и «Сгенерировать АТС». Вся логика — те же MCP-тулы hh_portrait_*,
// что и у агента/бота (#84/#86): веб дёргает host runMcpTool, не дублируя домен.
if (req.method === 'GET' && url.pathname === '/hh/vacancy-new') {
  const username = url.searchParams.get('username') || '';
  const given = url.searchParams.get('token') || '';
  const requested = url.searchParams.get('vacancy_id') || '';
  const errPage = (msg) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Портрет вакансии</title>
<style>body{font-family:system-ui;padding:48px;text-align:center;background:#f1f5f9;color:#1e293b}</style>
</head><body><h2>${msg}</h2></body></html>`);
  };
  if (!hhHub.SAFE_ID.test(username)) return errPage('Не указан пользователь.');
  if (requested && !hhHub.SAFE_ID.test(requested)) return errPage('Не указана вакансия.');
  if (process.env.AGENT_SECRET && given !== proactiveHmac(username)) return errPage('Ссылка недействительна. Запроси новую у бота.');
  const workDir = path.join(BASE_USERS_DIR, username);
  const vacancyId = requested || (readActiveVacancies(workDir)[0] && readActiveVacancies(workDir)[0].id) || '';
  let portrait = null;
  let error = null;
  try {
    portrait = hhPortrait.readPortrait(workDir, vacancyId || 'draft');
  } catch (e) {
    error = 'Портрет не читается: ' + e.message;
  }
  const completeness = portrait ? hhPortrait.computeCompleteness(portrait) : null;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  return res.end(vacancyNewPageHtml({ username, token: given, vacancyId, portrait, completeness, error }));
}

if (req.method === 'POST' && url.pathname === '/hh/portrait') {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  const { username, token, vacancy_id: vid, action, sources, patch, force } = body || {};
  if (!hhHub.SAFE_ID.test(String(username || ''))) return json(res, 400, { error: 'Invalid scope' });
  if (vid && !hhHub.SAFE_ID.test(String(vid))) return json(res, 400, { error: 'Invalid scope' });
  if (process.env.AGENT_SECRET && token !== proactiveHmac(username)) return json(res, 403, { error: 'Invalid token' });
  if (typeof hostRunMcpTool !== 'function') return json(res, 503, { error: 'host runMcpTool not provided' });

  const TOOL = { extract: 'hh_portrait_extract', update: 'hh_portrait_update', to_ats: 'hh_portrait_to_ats' }[action];
  if (!TOOL) return json(res, 400, { error: 'Unknown action' });
  const params = {};
  if (vid) params.vacancy_id = vid;
  if (action === 'extract') {
    const list = (Array.isArray(sources) ? sources : [])
      .map(x => ({ type: String((x && x.type) || 'text').slice(0, 30), text: String((x && x.text) || '').slice(0, 400000) }))
      .filter(x => x.text.trim())
      .slice(0, 20);
    if (!list.length) return json(res, 400, { error: 'Нет материалов: вставь текст вакансии, переписку или файлы.' });
    params.sources = list;
    params.force = !!force;
  } else if (action === 'update') {
    if (!patch || typeof patch !== 'object') return json(res, 400, { error: 'Нет patch' });
    params.patch = patch;
  } else {
    params.save = true;
    params.mode = 'draft';
  }
  let out;
  try {
    const text = await hostRunMcpTool({ tool: TOOL, params, username, workDir: path.join(BASE_USERS_DIR, username), timeoutMs: 120_000 });
    out = JSON.parse(text || '{}');
  } catch (e) {
    console.error(`[hh/portrait] user=${username} action=${action}:`, e.message);
    return json(res, 500, { error: e.message });
  }
  if (out && out.error) return json(res, 422, { error: out.error });
  return json(res, 200, out);
}

if (req.method === 'POST' && url.pathname === '/hh/portrait-file') {
  let body;
  try {
    body = JSON.parse(await readBody(req, 24 * 1024 * 1024));
  } catch (e) {
    const tooLarge = e && e.message === 'body too large';
    return json(res, tooLarge ? 413 : 400, { error: tooLarge ? 'Файл слишком большой (лимит 15 МБ).' : 'bad json' });
  }
  const { username, token, filename, data_base64 } = body || {};
  if (!hhHub.SAFE_ID.test(String(username || ''))) return json(res, 400, { error: 'Invalid scope' });
  if (process.env.AGENT_SECRET && token !== proactiveHmac(username)) return json(res, 403, { error: 'Invalid token' });
  if (typeof data_base64 !== 'string' || !data_base64) return json(res, 400, { error: 'Нет файла.' });
  const out = extractTextFromBuffer(Buffer.from(data_base64, 'base64'), filename);
  if (!out.ok) return json(res, 422, { error: out.error });
  return json(res, 200, { ok: true, text: out.text });
}

// ── Новый кандидат (#87): окно загрузки материалов, классификация типов, профиль.
if (req.method === 'GET' && url.pathname === '/hh/candidate-new') {
  const username = url.searchParams.get('username') || '';
  const given = url.searchParams.get('token') || '';
  const candidateId = url.searchParams.get('candidate_id') || '';
  const errPage = (msg) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Новый кандидат</title>
<style>body{font-family:system-ui;padding:48px;text-align:center;background:#f1f5f9;color:#1e293b}</style>
</head><body><h2>${msg}</h2></body></html>`);
  };
  if (!hhHub.SAFE_ID.test(username)) return errPage('Не указан пользователь.');
  if (candidateId && !hhHub.SAFE_ID.test(candidateId)) return errPage('Не указан кандидат.');
  if (process.env.AGENT_SECRET && given !== proactiveHmac(username)) return errPage('Ссылка недействительна. Запроси новую у бота.');
  let manifest = null;
  let error = null;
  if (candidateId) {
    manifest = hhCandidateDocs.readManifest(username, candidateId);
    if (!manifest) error = `Кандидат «${candidateId}» не найден.`;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  return res.end(candidateNewPageHtml({ username, token: given, candidateId, manifest, error }));
}

if (req.method === 'POST' && url.pathname === '/hh/candidate-doc') {
  let body;
  try {
    body = JSON.parse(await readBody(req, 45 * 1024 * 1024));
  } catch (e) {
    const tooLarge = e && e.message === 'body too large';
    return json(res, tooLarge ? 413 : 400, { error: tooLarge ? 'Файл слишком большой — добавь ссылкой.' : 'bad json' });
  }
  const { username, token, candidate_id: candId, candidate_name: candName, filename, data_base64, source_url: srcUrl, text: pasteText, type } = body || {};
  if (!hhHub.SAFE_ID.test(String(username || ''))) return json(res, 400, { error: 'Invalid scope' });
  if (candId && !hhHub.SAFE_ID.test(String(candId))) return json(res, 400, { error: 'Invalid scope' });
  if (process.env.AGENT_SECRET && token !== proactiveHmac(username)) return json(res, 403, { error: 'Invalid token' });
  if (type && !CANDIDATE_DOC_TYPES.includes(type)) return json(res, 400, { error: 'Неизвестный тип документа.' });
  let buffer = Buffer.alloc(0);
  let finalName = String(filename || srcUrl || '').slice(0, 200);
  if (typeof pasteText === 'string' && pasteText.trim()) {
    // Ручная вставка текста (резюме-картинка, письмо): валидный путь, когда файла с текстом нет
    buffer = Buffer.from(pasteText, 'utf8');
    finalName = finalName || 'вставлено-вручную.txt';
    if (!/\.[a-z0-9]+$/i.test(finalName)) finalName += '.txt';
  } else if (!srcUrl) {
    if (typeof data_base64 !== 'string' || !data_base64) return json(res, 400, { error: 'Нет файла.' });
    buffer = Buffer.from(data_base64, 'base64');
    if (buffer.length > 30 * 1024 * 1024) return json(res, 413, { error: 'Файл больше 30 МБ — добавь ссылкой.' });
  }
  try {
    const out = await hhCandidateDocs.addDocument({
      username,
      candidateId: candId || null,
      candidateName: candName || null,
      filename: finalName || 'файл',
      buffer,
      manualType: type || null,
      sourceUrl: srcUrl || null,
    });
    if (out.doc && out.doc.type === 'other') {
      try { await hhCandidateDocs.llmClassifyFallback({ username, candidateId: out.candidate_id, docId: out.doc.id }); } catch { /* best effort */ }
    }
    const fresh = hhCandidateDocs.readManifest(username, out.candidate_id);
    const doc = fresh?.docs.find(d => d.id === out.doc.id) || out.doc;
    return json(res, 200, { ok: true, candidate_id: out.candidate_id, doc });
  } catch (e) {
    console.error(`[hh/candidate-doc] user=${username}:`, e.message);
    return json(res, 500, { error: e.message });
  }
}

if (req.method === 'POST' && url.pathname === '/hh/candidate-docs') {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  const { username, token, candidate_id: candId, action, doc_id: docIdArg, type } = body || {};
  if (!hhHub.SAFE_ID.test(String(username || ''))) return json(res, 400, { error: 'Invalid scope' });
  if (!hhHub.SAFE_ID.test(String(candId || ''))) return json(res, 400, { error: 'Invalid scope' });
  if (process.env.AGENT_SECRET && token !== proactiveHmac(username)) return json(res, 403, { error: 'Invalid token' });
  try {
    if (action === 'set_type') {
      if (!CANDIDATE_DOC_TYPES.includes(type)) return json(res, 400, { error: 'Неизвестный тип документа.' });
      const out = hhCandidateDocs.setDocType({ username, candidateId: candId, docId: docIdArg, type });
      if (out.error) return json(res, 404, out);
      return json(res, 200, out);
    }
    if (action === 'extract_profile') {
      const out = await hhCandidateDocs.extractProfile({ username, candidateId: candId });
      if (out.error) return json(res, 422, out);
      return json(res, 200, { ok: true, profile: out.profile });
    }
    return json(res, 400, { error: 'Unknown action' });
  } catch (e) {
    console.error(`[hh/candidate-docs] user=${username} action=${action}:`, e.message);
    return json(res, 500, { error: e.message });
  }
}

// ── Два документа кандидата (#91): HTML-просмотр, скачивание MD и PDF по кнопке.
if (req.method === 'GET' && url.pathname === '/hh/candidate-report') {
  const username = url.searchParams.get('username') || '';
  const given = url.searchParams.get('token') || '';
  const candidateId = url.searchParams.get('candidate_id') || '';
  const which = url.searchParams.get('which') || 'profile';
  const format = url.searchParams.get('format') || 'html';
  const fail = (status, msg) => json(res, status, { error: msg });
  if (!hhHub.SAFE_ID.test(username) || !hhHub.SAFE_ID.test(candidateId)) return fail(400, 'Invalid scope');
  if (process.env.AGENT_SECRET && given !== proactiveHmac(username)) return fail(403, 'Invalid token');
  const data = evalDocs.buildReportData({ username, candidateId, vacancyId: url.searchParams.get('vacancy_id') || null, evalSlug: url.searchParams.get('eval_slug') || null, negId: url.searchParams.get('neg_id') || null });
  if (data.error) return fail(404, data.error);
  const md = which === 'eval' ? evalDocs.renderCleanEvalMd(data) : evalDocs.renderProfileMd(data);
  if (format === 'md') {
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${which}-${candidateId}.md"` });
    return res.end(md);
  }
  const toolbar = `<div class="no-print" style="margin:0 0 14px;display:flex;gap:8px;font-family:system-ui;font-size:13px">
<a href="candidate-report?username=${encodeURIComponent(username)}&token=${given}&candidate_id=${encodeURIComponent(candidateId)}&which=${which}&format=md">⬇ Скачать MD</a>
<a href="candidate-report.pdf?username=${encodeURIComponent(username)}&token=${given}&candidate_id=${encodeURIComponent(candidateId)}&which=${which}">⬇ Скачать PDF</a>
<a href="candidate-new?username=${encodeURIComponent(username)}&token=${given}&candidate_id=${encodeURIComponent(candidateId)}">← К кандидату</a>
</div>`;
  const html = evalDocs.wrapHtml(`${which === 'eval' ? 'Оценка' : 'Профиль'} — ${data.candidate.name}`, toolbar + evalDocs.mdToHtml(md), { photoDataUri: which === 'profile' ? evalDocs.photoDataUri(username, candidateId) : null });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  return res.end(html);
}

if (req.method === 'GET' && url.pathname === '/hh/candidate-report.pdf') {
  const username = url.searchParams.get('username') || '';
  const given = url.searchParams.get('token') || '';
  const candidateId = url.searchParams.get('candidate_id') || '';
  const which = url.searchParams.get('which') || 'profile';
  if (!hhHub.SAFE_ID.test(username) || !hhHub.SAFE_ID.test(candidateId)) return json(res, 400, { error: 'Invalid scope' });
  if (process.env.AGENT_SECRET && given !== proactiveHmac(username)) return json(res, 403, { error: 'Invalid token' });
  const data = evalDocs.buildReportData({ username, candidateId, vacancyId: url.searchParams.get('vacancy_id') || null, evalSlug: url.searchParams.get('eval_slug') || null, negId: url.searchParams.get('neg_id') || null });
  if (data.error) return json(res, 404, data.error);
  const md = which === 'eval' ? evalDocs.renderCleanEvalMd(data) : evalDocs.renderProfileMd(data);
  const html = evalDocs.wrapHtml(`${which === 'eval' ? 'Оценка' : 'Профиль'} — ${data.candidate.name}`, evalDocs.mdToHtml(md), { photoDataUri: which === 'profile' ? evalDocs.photoDataUri(username, candidateId) : null });
  const out = reportPdf.htmlToPdf(html);
  if (!out.ok) return json(res, 422, { error: out.error, hint: 'Открой HTML-версию и используй печать браузера — колонтитулов не будет.' });
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${which}-${candidateId}.pdf"` });
  return res.end(out.pdf);
}

// ── Канон v2 (#120): два документа из канонической оценки ───────────────────────
// Внутренняя оценка — всё (баллы 1–5, evidence, экспертная проверка, риски).
// Клиентский профиль — только одобренные поля, брендированный HTML, фото.
// Оба формата — из одного канонического объекта, поэтому данные не расходятся.
if (req.method === 'GET' && url.pathname === '/hh/candidate-report-v2') {
  const username = url.searchParams.get('username') || '';
  const given = url.searchParams.get('token') || '';
  const candidateId = url.searchParams.get('candidate_id') || '';
  const which = url.searchParams.get('which') || 'profile';
  const format = url.searchParams.get('format') || 'html';
  const fail = (status, msg) => json(res, status, { error: msg });
  if (!hhHub.SAFE_ID.test(username) || !hhHub.SAFE_ID.test(candidateId)) return fail(400, 'Invalid scope');
  if (process.env.AGENT_SECRET && given !== proactiveHmac(username)) return fail(403, 'Invalid token');

  const built = evalDocs.buildReportDataV2FromFiles({
    username, candidateId,
    vacancyId: url.searchParams.get('vacancy_id') || null,
    evalSlug: url.searchParams.get('eval_slug') || null,
    negId: url.searchParams.get('neg_id') || null,
    prefer: url.searchParams.get('prefer') || 'interview',
  });
  if (built.error) return fail(404, built.error);

  const { evaluation, draft } = built;
  const name = draft?.candidate_name || candidateId;

  if (format === 'md') {
    const md = which === 'eval'
      ? evalDocs.renderCleanEvalMdV2(evaluation, { candidateName: name })
      : evalDocs.renderClientProfileMdV2(draft);
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="v2-${which}-${candidateId}.md"` });
    return res.end(md);
  }

  const toolbar = `<div class="no-print" style="margin:0 0 14px;display:flex;gap:8px;font-family:system-ui;font-size:13px">
<a href="candidate-report-v2?username=${encodeURIComponent(username)}&token=${given}&candidate_id=${encodeURIComponent(candidateId)}&which=${which}&format=md">⬇ Скачать MD</a>
<a href="candidate-report-v2.pdf?username=${encodeURIComponent(username)}&token=${given}&candidate_id=${encodeURIComponent(candidateId)}&which=${which}">⬇ Скачать PDF</a>
<a href="candidate-new?username=${encodeURIComponent(username)}&token=${given}&candidate_id=${encodeURIComponent(candidateId)}">← К кандидату</a>
</div>`;

  // Внутренняя оценка — MD → HTML через общий конвертер (print-CSS уже внутри).
  // Клиентский профиль — брендированный HTML из того же draft (R3: одна версия данных).
  const html = which === 'eval'
    ? evalDocs.wrapHtml(`Внутренняя оценка — ${name}`, toolbar + evalDocs.mdToHtml(evalDocs.renderCleanEvalMdV2(evaluation, { candidateName: name })))
    : evalDocs.renderClientHtmlV2(draft, {
        branding: evalDocs.loadBranding ? evalDocs.loadBranding(path.join(usersRoot(), username)) : undefined,
        photoDataUri: evalDocs.photoDataUri(username, candidateId),
      });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  return res.end(html);
}

if (req.method === 'GET' && url.pathname === '/hh/candidate-report-v2.pdf') {
  const username = url.searchParams.get('username') || '';
  const given = url.searchParams.get('token') || '';
  const candidateId = url.searchParams.get('candidate_id') || '';
  const which = url.searchParams.get('which') || 'profile';
  if (!hhHub.SAFE_ID.test(username) || !hhHub.SAFE_ID.test(candidateId)) return json(res, 400, { error: 'Invalid scope' });
  if (process.env.AGENT_SECRET && given !== proactiveHmac(username)) return json(res, 403, { error: 'Invalid token' });

  const built = evalDocs.buildReportDataV2FromFiles({
    username, candidateId,
    vacancyId: url.searchParams.get('vacancy_id') || null,
    evalSlug: url.searchParams.get('eval_slug') || null,
    negId: url.searchParams.get('neg_id') || null,
    prefer: url.searchParams.get('prefer') || 'interview',
  });
  if (built.error) return json(res, 404, built.error);

  const { evaluation, draft } = built;
  const name = draft?.candidate_name || candidateId;
  const html = which === 'eval'
    ? evalDocs.wrapHtml(`Внутренняя оценка — ${name}`, evalDocs.mdToHtml(evalDocs.renderCleanEvalMdV2(evaluation, { candidateName: name })))
    : evalDocs.renderClientHtmlV2(draft, {
        branding: evalDocs.loadBranding ? evalDocs.loadBranding(path.join(usersRoot(), username)) : undefined,
        photoDataUri: evalDocs.photoDataUri(username, candidateId),
      });
  const out = reportPdf.htmlToPdf(html);
  if (!out.ok) return json(res, 422, { error: out.error, hint: 'Открой HTML-версию и используй печать браузера — колонтитулов не будет.' });
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="v2-${which}-${candidateId}.pdf"` });
  return res.end(out.pdf);
}

// ── Фото кандидата (#91): загрузка в манифест + отдача для страницы/PDF ────────
if (req.method === 'POST' && url.pathname === '/hh/candidate-photo') {
  let body;
  try {
    body = JSON.parse(await readBody(req, 8 * 1024 * 1024));
  } catch (e) {
    const tooLarge = e && e.message === 'body too large';
    return json(res, tooLarge ? 413 : 400, { error: tooLarge ? 'Фото больше 5 МБ.' : 'bad json' });
  }
  const { username, token, candidate_id: candId, data_base64, mime } = body || {};
  if (!hhHub.SAFE_ID.test(String(username || '')) || !hhHub.SAFE_ID.test(String(candId || ''))) return json(res, 400, { error: 'Invalid scope' });
  if (process.env.AGENT_SECRET && token !== proactiveHmac(username)) return json(res, 403, { error: 'Invalid token' });
  if (typeof data_base64 !== 'string' || !data_base64) return json(res, 400, { error: 'Нет файла.' });
  const buf = Buffer.from(data_base64, 'base64');
  if (buf.length > 5 * 1024 * 1024) return json(res, 413, { error: 'Фото больше 5 МБ.' });
  const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[mime] || '.jpg';
  try {
    const manifest = hhCandidateDocs.ensureCandidate(username, candId, null);
    const fs2 = require('fs');
    const path2 = require('path');
    const root = hhCandidateDocs.candRoot(username, manifest.candidate_id);
    fs2.mkdirSync(root, { recursive: true });
    fs2.writeFileSync(path2.join(root, `photo${ext}`), buf);
    manifest.photo = { file: `photo${ext}`, mime: mime || 'image/jpeg', size: buf.length, added_at: new Date().toISOString() };
    hhCandidateDocs.writeManifest(username, manifest.candidate_id, manifest);
    return json(res, 200, { ok: true, candidate_id: manifest.candidate_id });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}

if (req.method === 'GET' && url.pathname === '/hh/candidate-photo') {
  const username = url.searchParams.get('username') || '';
  const given = url.searchParams.get('token') || '';
  const candidateId = url.searchParams.get('candidate_id') || '';
  if (!hhHub.SAFE_ID.test(username) || !hhHub.SAFE_ID.test(candidateId)) return json(res, 400, { error: 'Invalid scope' });
  if (process.env.AGENT_SECRET && given !== proactiveHmac(username)) return json(res, 403, { error: 'Invalid token' });
  try {
    const manifest = hhCandidateDocs.readManifest(username, candidateId);
    if (!manifest?.photo?.file) return json(res, 404, { error: 'Фото не загружено.' });
    const f = require('path').join(hhCandidateDocs.candRoot(username, candidateId), manifest.photo.file);
    const buf = require('fs').readFileSync(f);
    res.writeHead(200, { 'Content-Type': manifest.photo.mime || 'image/jpeg', 'Cache-Control': 'private, max-age=300' });
    return res.end(buf);
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}

// ── Тяжёлая загрузка сырыми байтами (#105): JSON-base64 давал лимит 30 МБ и
// дублирование ×1.33 — файл >1 МБ уходит через /hh/candidate-doc-raw в GCS ядра
// (без GCS-SDK в скилле); ядро недоступно/старое → клиент падает на base64-путь.
if (req.method === 'POST' && url.pathname === '/hh/candidate-doc-raw') {
  const username = url.searchParams.get('username') || '';
  const given = url.searchParams.get('token') || '';
  const candId = url.searchParams.get('candidate_id') || '';
  const candName = url.searchParams.get('candidate_name') || '';
  const filename = url.searchParams.get('filename') || '';
  const type = url.searchParams.get('type') || '';
  const fail = (status, msg) => json(res, status, { error: msg });
  if (!hhHub.SAFE_ID.test(username)) return fail(400, 'Invalid scope');
  if (candId && !hhHub.SAFE_ID.test(candId)) return fail(400, 'Invalid scope');
  if (process.env.AGENT_SECRET && given !== proactiveHmac(username)) return fail(403, 'Invalid token');
  if (type && !CANDIDATE_DOC_TYPES.includes(type)) return fail(400, 'Неизвестный тип документа.');

  const BLOB_MAX = 256 * 1024 * 1024;
  let buffer;
  try {
    buffer = await new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      req.on('data', c => { total += c.length; if (total > BLOB_MAX) { req.destroy(); return reject(new Error('too large')); } chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  } catch (e) {
    return fail(e.message === 'too large' ? 413 : 400, e.message === 'too large' ? 'Файл больше 256 МБ — отдай ссылкой на Google Drive.' : `чтение тела: ${e.message}`);
  }
  if (!buffer.length) return fail(400, 'Пустой файл.');

  try {
    const out = await hhCandidateDocs.addDocument({
      username,
      candidateId: candId || null,
      candidateName: candName || null,
      filename: String(filename || 'файл').slice(0, 200),
      buffer,
      manualType: type || null,
      externalStore: async ({ candidateId, docId, ext, buffer: buf, contentType }) => {
        const up = await require('./hh-blob-client').uploadDocBytes({
          username, candidateId, docId, ext, buffer: buf, contentType,
        }, { env: { ...process.env, PORT: PORT ?? process.env.PORT } });
        if (up.error) throw new Error(up.error);
        return { backend: 'gcs', key: up.key, doc_id: docId, ext, sha256: up.sha256, generation: up.generation ?? null };
      },
    });
    if (out.doc && out.doc.type === 'other') {
      try { await hhCandidateDocs.llmClassifyFallback({ username, candidateId: out.candidate_id, docId: out.doc.id }); } catch { /* best effort */ }
    }
    const fresh = hhCandidateDocs.readManifest(username, out.candidate_id);
    const doc = fresh?.docs.find(d => d.id === out.doc.id) || out.doc;
    return json(res, 200, { ok: true, candidate_id: out.candidate_id, doc, storage: doc.storage || null });
  } catch (e) {
    console.error(`[hh/candidate-doc-raw] user=${username}:`, e.message);
    return fail(502, e.message);
  }
}

// ── Переименование кандидата: имя необязательно при загрузке, правится потом ──
if (req.method === 'POST' && url.pathname === '/hh/candidate-rename') {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  const { username, token, candidate_id: candId, name } = body || {};
  if (!hhHub.SAFE_ID.test(String(username || '')) || !hhHub.SAFE_ID.test(String(candId || ''))) return json(res, 400, { error: 'Invalid scope' });
  if (process.env.AGENT_SECRET && token !== proactiveHmac(username)) return json(res, 403, { error: 'Invalid token' });
  const out = hhCandidateDocs.renameCandidate({ username, candidateId: candId, name });
  if (out.error) return json(res, out.error.includes('не найден') ? 404 : 400, out);
  return json(res, 200, out);
}

// ── Удаление документа кандидата (#107): GCS (если там) → локальные байты/.txt → манифест ──
if (req.method === 'POST' && url.pathname === '/hh/candidate-doc-delete') {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  const { username, token, candidate_id: candId, doc_id: docId } = body || {};
  if (!hhHub.SAFE_ID.test(String(username || '')) || !hhHub.SAFE_ID.test(String(candId || '')) || !hhHub.SAFE_ID.test(String(docId || ''))) {
    return json(res, 400, { error: 'Invalid scope' });
  }
  if (process.env.AGENT_SECRET && token !== proactiveHmac(username)) return json(res, 403, { error: 'Invalid token' });
  try {
    const out = await hhCandidateDocs.deleteDocument({ username, candidateId: candId, docId });
    if (out.error) return json(res, out.error.includes('не найден') ? 404 : 502, out);
    console.log(`[hh/candidate-doc-delete] user=${username} cand=${candId} doc=${docId}`);
    return json(res, 200, { ok: true, doc_id: docId });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}

// ── Расшифровка загруженного аудио/видео кандидата (#87 → #88): файл уже на
// сервере, тул читает его из candidate-docs, Deepgram без URL.
if (req.method === 'POST' && url.pathname === '/hh/interview-transcribe') {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  const { username, token, candidate_id: candId, doc_id: docId, slug, force } = body || {};
  if (!hhHub.SAFE_ID.test(String(username || '')) || !hhHub.SAFE_ID.test(String(candId || '')) || !hhHub.SAFE_ID.test(String(docId || ''))) {
    return json(res, 400, { error: 'Invalid scope' });
  }
  if (slug && !hhHub.SAFE_ID.test(String(slug))) return json(res, 400, { error: 'Invalid scope' });
  if (process.env.AGENT_SECRET && token !== proactiveHmac(username)) return json(res, 403, { error: 'Invalid token' });
  if (typeof hostRunMcpTool !== 'function') return json(res, 503, { error: 'host runMcpTool not provided' });
  try {
    const text = await hostRunMcpTool({
      tool: 'hh_interview_transcribe',
      params: { candidate_id: candId, doc_id: docId, slug: slug || candId, force: !!force },
      username, workDir: path.join(BASE_USERS_DIR, username), timeoutMs: 300_000,
    });
    let out;
    try { out = JSON.parse(text || '{}'); } catch { return json(res, 502, { error: 'bad tool response' }); }
    if (out.error) return json(res, 422, { error: out.error });
    // Транскрипт становится документом кандидата — профиль/оценки видят его сразу
    try {
      if (out.transcript_path && fs.existsSync(out.transcript_path)) {
        const manifest = hhCandidateDocs.readManifest(username, candId);
        const tName = `${out.slug || candId}-transcript.txt`;
        if (manifest && !manifest.docs.some(d => d.filename === tName)) {
          await hhCandidateDocs.addDocument({
            username, candidateId: candId, filename: tName,
            buffer: fs.readFileSync(out.transcript_path), manualType: 'interview',
          });
        }
      }
    } catch (e) {
      console.warn('[hh/interview-transcribe] transcript doc append failed:', e.message);
    }
    return json(res, 200, { ok: true, ...out });
  } catch (e) {
    console.error(`[hh/interview-transcribe] user=${username} cand=${candId}:`, e.message);
    return json(res, 500, { error: e.message });
  }
}

// ── «Запустить оценку» (#90): async-джоб с прогрессом, не блокирует HTTP ──────
if (req.method === 'POST' && url.pathname === '/hh/eval-run') {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  const { username, token, candidate_id: candId, vacancy_id: vacId } = body || {};
  if (!hhHub.SAFE_ID.test(String(username || '')) || !hhHub.SAFE_ID.test(String(candId || ''))) return json(res, 400, { error: 'Invalid scope' });
  if (vacId && !hhHub.SAFE_ID.test(String(vacId))) return json(res, 400, { error: 'Invalid scope' });
  if (process.env.AGENT_SECRET && token !== proactiveHmac(username)) return json(res, 403, { error: 'Invalid token' });
  const out = evalJob.startEvalJob({ username, candidateId: candId, vacancyId: vacId || null });
  if (out.error) return json(res, 422, { error: out.error });
  console.log(`[hh/eval-run] user=${username} candidate=${candId} vacancy=${out.job.vacancy_id} started`);
  return json(res, 200, { ok: true, job_id: out.job.id, state: out.job.state });
}

if (req.method === 'GET' && url.pathname === '/hh/eval-run') {
  const username = url.searchParams.get('username') || '';
  const given = url.searchParams.get('token') || '';
  const candidateId = url.searchParams.get('candidate_id') || '';
  if (!hhHub.SAFE_ID.test(username) || !hhHub.SAFE_ID.test(candidateId)) return json(res, 400, { error: 'Invalid scope' });
  if (process.env.AGENT_SECRET && given !== proactiveHmac(username)) return json(res, 403, { error: 'Invalid token' });
  const job = evalJob.readJob(username, candidateId);
  if (!job) return json(res, 404, { error: 'Оценка ещё не запускалась.' });
  return json(res, 200, { job });
}

if (req.method === 'GET' && url.pathname === '/api/hh/proactive/candidates') {
  const username = url.searchParams.get('username') || '';
  const given = url.searchParams.get('token') || '';
  if (process.env.AGENT_SECRET && given !== proactiveHmac(username)) return json(res, 403, { error: 'invalid token' });
  const { loadAllCandidates } = require('./hh-proactive-search');
  const all = Object.values(loadAllCandidates(username, url.searchParams.get('vacancy_id')))
    .sort((a, b) => new Date(b.found_at || b.added_at || 0) - new Date(a.found_at || a.added_at || 0));
  return json(res, 200, { total: all.length, candidates: all });
}

if (req.method === 'GET' && url.pathname === '/api/hh/proactive/ats-progress') {
  const username = url.searchParams.get('username') || '';
  const vacancyId = url.searchParams.get('vacancy_id') || '';
  const given = url.searchParams.get('token') || '';
  if (!hhHub.SAFE_ID.test(username) || !hhHub.SAFE_ID.test(vacancyId)) return json(res, 400, { error: 'Invalid scope' });
  if (process.env.AGENT_SECRET && given !== proactiveHmac(username)) return json(res, 403, { error: 'invalid token' });
  try {
    const progress = require('./hh-proactive-search').getAtsRefreshProgress(username, vacancyId);
    return json(res, 200, { progress });
  } catch (error) {
    return json(res, 500, { error: 'Не удалось прочитать прогресс ATS: ' + error.message });
  }
}

if (req.method === 'POST' && url.pathname === '/api/hh/proactive/ai-score') {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  const { username = '', candidate_id = '', token: givenToken = '' } = body || {};
  if (process.env.AGENT_SECRET && givenToken !== proactiveHmac(username)) return json(res, 403, { error: 'invalid token' });
  const vacancyId = body.vacancy_id || require('./hh-cold-search-context').readSearchContext(path.join(BASE_USERS_DIR, username), 'active_vacancy')?.id;
  if (!vacancyId) return json(res, 400, { error: 'vacancy_id required' });
  const file = latestProactiveFile(username, vacancyId);
  if (!file) return json(res, 404, { error: 'no results yet' });
  let results;
  try { results = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return json(res, 500, { error: 'read error' }); }
  const candidate = require('./hh-proactive-search').loadAllCandidates(username, vacancyId)[candidate_id]
    || (results.candidates || []).find(c => c.id === candidate_id);
  if (!candidate) return json(res, 404, { error: 'candidate not found' });
  const cfg = results.ats_config || {};
  const knockoutList = (cfg.knockout || []).map(k => `- ${k}`).join('\n');
  const requiredList = (cfg.required || []).map(r => `- ${r.name} (вес ${r.weight})`).join('\n');
  const preferredList = (cfg.preferred || []).map(r => `- ${r.name} (вес ${r.weight})`).join('\n');
  const expLines = (candidate.experience || []).map(e => `  ${e.position} — ${e.company} (${e.start || '?'} – ${e.end || 'н.в.'})`).join('\n');
  const prompt = `Оцени кандидата для вакансии "${cfg.vacancy_title || 'Вакансия'}".

Критерии knockout (если отсутствует — отклонить):
${knockoutList || '—'}

Обязательные критерии (с весами):
${requiredList || '—'}

Желательные критерии:
${preferredList || '—'}

Данные кандидата:
Должность: ${candidate.title}
Опыт: ${candidate.total_exp_years} лет
Регион: ${candidate.area}
Компании: ${(candidate.recent_companies || []).join(', ')}
Опыт (должности):
${expLines || '—'}
Текущий score (эвристика): ${candidate.score} (${candidate.tag})

Дай развёрнутую оценку (3-5 предложений): соответствует ли кандидат? Какие сигналы "за" и "против"?
Предложи уточнённый score (число от 0 до 12) и тег (PASS/REVIEW/WEAK).

Ответ строго в JSON: {"evaluation": "...", "score": N, "tag": "PASS|REVIEW|WEAK"}`;

  if (!ladderToken()) return json(res, 500, { error: 'llm-ladder токен не найден — оценка кандидата недоступна.' });

  try {
    // Candidate assessment from search results = evaluation → free ladder
    // (src/hh-llm.js purpose 'score').
    const text = await hhLlm({
      messages: [{ role: 'user', content: prompt }],
      purpose: 'score',
      temperature: 0.1,
      maxTokens: 1024,
      timeoutMs: 30_000,
      source: 'hh-candidate-eval',
    }) || '{}';
    let parsed;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { evaluation: text, score: candidate.score, tag: candidate.tag };
    } catch {
      parsed = { evaluation: text, score: candidate.score, tag: candidate.tag };
    }
    return json(res, 200, parsed);
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}

if (req.method === 'GET' && url.pathname === '/api/hh/proactive/search') {
  const username = url.searchParams.get('username') || '';
  const vacancyId = url.searchParams.get('vacancy_id') || '';
  const givenToken = url.searchParams.get('token') || '';
  const jobId = url.searchParams.get('job_id') || '';
  if (!hhHub.SAFE_ID.test(username) || !hhHub.SAFE_ID.test(vacancyId) || (jobId && !/^[0-9a-f-]{36}$/i.test(jobId))) return json(res, 400, { error: 'Invalid scope' });
  if (process.env.AGENT_SECRET && givenToken !== proactiveHmac(username)) return json(res, 403, { error: 'invalid token' });
  const jobs = require('./hh-proactive-search-job');
  const job = jobs.read(username, vacancyId);
  if (!job || (jobId && job.id !== jobId)) return json(res, 404, { error: 'Поиск не найден или уже заменён новым запуском.' });
  return json(res, 200, { job: jobs.publicJob(job) });
}

if (req.method === 'POST' && url.pathname === '/api/hh/proactive/search') {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  const { username = '', token: givenToken = '' } = body || {};
  const vacancyId = String(body.vacancy_id || '');
  if (!hhHub.SAFE_ID.test(String(username)) || !hhHub.SAFE_ID.test(vacancyId)) return json(res, 400, { error: 'Invalid scope' });
  if (process.env.AGENT_SECRET && givenToken !== proactiveHmac(username)) return json(res, 403, { error: 'invalid token' });
  const workDir = path.join(BASE_USERS_DIR, username);
  try {
    const started = require('./hh-proactive-search-job').start({
      username, vacancyId,
      runSearch: onProgress => runProactiveSearch(username, workDir, {
        vacancyId,
        ...(Object.prototype.hasOwnProperty.call(body, 'area') ? { area: body.area } : {}),
        refreshAccessToken: (u) => refreshHhToken(u, _secretsCache),
        onProgress,
      }),
    });
    return json(res, started.existing ? 200 : 202, { ok: true, job: started.job });
  } catch (error) {
    return json(res, 500, { error: `Не удалось запустить поиск: ${error.message}` });
  }
}

// Recruiter-editable search queries per vacancy — lets a web-only user see how the
// search is set up, change the queries and relaunch without going through Telegram.
// Who counts as a good candidate is edited in the ATS editor, not here.
if (url.pathname === '/api/hh/proactive/prompt' && (req.method === 'GET' || req.method === 'POST')) {
  let body = {};
  if (req.method === 'POST') {
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  }
  const pick = k => (req.method === 'POST' ? body?.[k] : url.searchParams.get(k)) || '';
  const username = String(pick('username'));
  const vacancyId = String(pick('vacancy_id'));
  if (![username, vacancyId].every(x => hhHub.SAFE_ID.test(x))) return json(res, 400, { error: 'Invalid scope' });
  if (process.env.AGENT_SECRET && String(pick('token')) !== proactiveHmac(username)) return json(res, 403, { error: 'invalid token' });
  const search = require('./hh-proactive-search');
  try {
    if (req.method === 'POST') {
      const queries = typeof body.queries === 'string' ? body.queries.split('\n')
        : (Array.isArray(body.queries) ? body.queries : undefined);
      const saved = search.saveSearchSettings(username, vacancyId, { queries });
      console.log(`[hh/proactive-prompt] saved user=${username} vacancy=${vacancyId} queries=${saved.queries_state}`);
      return json(res, 200, { ok: true, ...saved, ...search.searchSettingsView(username, vacancyId) });
    }
    return json(res, 200, { ok: true, ...search.searchSettingsView(username, vacancyId) });
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
}

if (req.method === 'POST' && url.pathname === '/api/hh/proactive/comment') {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  const { username = '', token: givenToken = '', candidate_id = '', text = '' } = body || {};
  if (process.env.AGENT_SECRET && givenToken !== proactiveHmac(username)) return json(res, 403, { error: 'invalid token' });
  if (!candidate_id) return json(res, 400, { error: 'candidate_id required' });
  try {
    const { saveCandidateComment } = require('./hh-proactive-search');
    saveCandidateComment(username, candidate_id, { text: String(text).slice(0, 1000) }, body.vacancy_id);
    return json(res, 200, { ok: true });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}

if (req.method === 'POST' && url.pathname === '/api/hh/proactive/vacancy-state') {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  const { username = '', token = '', vacancy_id, action } = body || {};
  if (process.env.AGENT_SECRET && token !== proactiveHmac(username)) return json(res, 403, { error: 'invalid token' });
  const workDir = path.join(BASE_USERS_DIR, username);
  if (!readActiveVacancies(workDir).some(v => String(v.id) === String(vacancy_id))) return json(res, 404, { error: 'vacancy not tracked' });
  // Page flags (starred/archived) stay in the legacy per-vacancy file; the schedule
  // itself is a cron job owned by hh_proactive_schedule (#1489 S7.1).
  const patches = { enable: { archived: false }, disable: {},
    star: { starred: true }, unstar: { starred: false }, archive: { archived: true }, restore: { archived: false } };
  const cronOp = { enable: 'enable', disable: 'disable', archive: 'disable' }[action];
  if (!patches[action]) return json(res, 400, { error: 'invalid action' });
  try {
    if (action === 'enable') require('./hh-cold-search-context').resolveSearchContext(workDir, vacancy_id);
    if (cronOp) {
      const out = await coldSearchSchedule(username, workDir, { action: cronOp, vacancy_id: String(vacancy_id) });
      if (out.error) return json(res, 502, { error: out.error });
    }
    const state = require('./hh-cold-search-schedule').updateSchedule(username, workDir, vacancy_id, patches[action]);
    return json(res, 200, { ok: true, state: { ...state, ...(await coldSearchMonitoring(username, workDir, vacancy_id)) } });
  } catch (e) { return json(res, 400, { error: e.message }); }
}

if (req.method === 'POST' && url.pathname === '/api/hh/proactive/set-status') {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  const { username = '', token: givenToken = '', candidate_id = '', status = '' } = body || {};
  if (process.env.AGENT_SECRET && givenToken !== proactiveHmac(username)) return json(res, 403, { error: 'invalid token' });
  if (!candidate_id) return json(res, 400, { error: 'candidate_id required' });
  try {
    const { setCandidateStatus } = require('./hh-proactive-search');
    const rec = setCandidateStatus(username, candidate_id, status, body.vacancy_id);
    return json(res, 200, { ok: true, status: rec.status, status_changed_at: rec.status_changed_at });
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
}

if (req.method === 'POST' && url.pathname === '/api/hh/proactive/import-seen') {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  const { username = '', token: givenToken = '', ids = [] } = body || {};
  if (process.env.AGENT_SECRET && givenToken !== proactiveHmac(username)) return json(res, 403, { error: 'invalid token' });
  if (!Array.isArray(ids) || !ids.length) return json(res, 400, { error: 'ids array required' });
  try {
    const { loadSeenIds, saveSeenIds } = require('./hh-proactive-search');
    // Resolve vacancy key the same way runProactiveSearch does — from the ATS
    // config / active vacancy, NOT from the latest results file. Results files
    // don't exist before the first search run, and the recruiter legitimately
    // imports "old 100 candidates" BEFORE enabling the search (so those 100 are
    // never re-notified). Falling back to 'unknown' would put the imports in a
    // bucket the search never reads — the old candidates would be re-notified.
    let vacancyKey = 'unknown';
    // Epic #112: the legacy ats_config.json is dead — the vacancy key comes from the
    // active vacancy (the same context runProactiveSearch resolves), never from a
    // stale shared config that used to leak another vacancy's id here.
    try {
      const avRaw = JSON.parse(fs.readFileSync(path.join(BASE_USERS_DIR, String(username), 'contexts', 'hh', 'active_vacancy.json'), 'utf8'));
      if (avRaw?.value?.id) vacancyKey = String(avRaw.value.id);
    } catch { /* no active vacancy — fall through */ }
    if (vacancyKey === 'unknown') {
      const latestFile = latestProactiveFile(username);
      if (latestFile) {
        try {
          const r = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
          vacancyKey = r.vacancy_id || r.vacancy_title || 'unknown';
        } catch {}
      }
    }
    const seen = loadSeenIds(username);
    const today = new Date().toISOString().slice(0, 10);
    const bucket = seen[vacancyKey] || {};
    let imported = 0;
    for (const id of ids) {
      const cleanId = String(id).replace(/[^a-zA-Z0-9]/g, '');
      if (cleanId && !bucket[cleanId]) { bucket[cleanId] = today; imported++; }
    }
    seen[vacancyKey] = bucket;
    saveSeenIds(username, seen);
    return json(res, 200, { ok: true, imported, total: Object.keys(bucket).length });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}

if (req.method === 'POST' && url.pathname === '/api/hh/proactive/add-manual') {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  const { username = '', token: givenToken = '', resume_url_or_id = '', vacancy_id: requestedVacancyId = '' } = body || {};
  if (process.env.AGENT_SECRET && givenToken !== proactiveHmac(username)) return json(res, 403, { error: 'invalid token' });
  if (!resume_url_or_id) return json(res, 400, { error: 'resume_url_or_id required' });
  try {
    const { parseResumeId, addManualCandidate } = require('./hh-proactive-search');
    const resumeId = parseResumeId(resume_url_or_id);
    if (!resumeId) return json(res, 400, { error: 'could not parse resume id from input' });
    const hhToken = readHhToken(username);
    if (!hhToken) return json(res, 403, { error: 'HH токен не найден' });
    let resumeData;
    try {
      resumeData = await hhFetch(`/resumes/${encodeURIComponent(resumeId)}`, hhToken);
    } catch (e) {
      // One-shot refresh + retry on expired token, same pattern as proactive-search.
      if (/40[13]/.test(String(e.message || ''))) {
        const fresh = await refreshHhToken(username, _secretsCache);
        if (fresh) resumeData = await hhFetch(`/resumes/${encodeURIComponent(resumeId)}`, { access_token: fresh });
        else throw e;
      } else {
        throw e;
      }
    }
    // Tag with whichever vacancy is active for this profile — prefer the tab the
    // recruiter was on (requestedVacancyId, sent by the page) and fall back to the
    // profile's first active vacancy. If neither resolves, vacancy_ids stays []
    // (wildcard — addManualCandidate's documented behavior for that case).
    const activeVacancies = readActiveVacancies(path.join(BASE_USERS_DIR, username));
    const vacancyId = (requestedVacancyId && activeVacancies.find(v => String(v.id) === String(requestedVacancyId)))
      ? requestedVacancyId
      : (activeVacancies[0]?.id || '');
    const record = addManualCandidate(username, resumeData, vacancyId);
    return json(res, 200, { ok: true, candidate: record });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}
// ── Call Tips desktop app endpoints (moved from core server.js, agent#1470) ──
// Scoped token for the Call Tips desktop app: bound to one profile, not the
// master AGENT_SECRET. Minted via the calltips_get_login MCP tool.
function calltipsHmac(profile) {
  const { createHmac } = require('crypto');
  const secret = process.env.AGENT_SECRET || '';
  return createHmac('sha256', secret).update(`calltips:${profile}`).digest('hex').slice(0, 24);
}

// GET /calltips-session?profile=xxx&token=yyy — latest Call Tips session written by agent
// Call Tips app polls this to prefill candidate name, resume, job, and interview plan
// Auth: per-profile scoped token (calltipsHmac), NOT the master AGENT_SECRET — see calltips_get_login
if (req.method === 'GET' && url.pathname === '/calltips-session') {
  const profile = url.searchParams.get('profile');
  if (!profile || !/^[a-zA-Z0-9_-]+$/.test(profile))
    return json(res, 400, { error: 'invalid profile' });
  const calltipsToken = url.searchParams.get('token');
  if (!calltipsToken || calltipsToken !== calltipsHmac(profile))
    return json(res, 403, { error: 'invalid or missing token for this profile' });
  // Call Tips session is written into the profile workspace (USERS_ROOT), not
  // the legacy SYSTEM_ROOT/sessions tree — resolve via the canonical helper.
  const filePath = path.join(userWorkDir(profile), 'calltips-latest.json');
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return json(res, 200, data);
  } catch {
    return json(res, 404, { error: 'No Call Tips session prepared. Ask the agent: "подготовь план для звонка с [имя]"' });
  }
}

// POST /calltips-tips — real-time coaching tip from transcript
// Body: { profile, token, transcript:[{speaker:'me'|'them',text}], candidateName, jobText, lang, plan }
// Returns: { dig, next, why }
// Auth: per-profile scoped token (calltipsHmac), NOT the master AGENT_SECRET — see calltips_get_login
if (req.method === 'POST' && url.pathname === '/calltips-tips') {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { return json(res, 400, { error: 'bad json' }); }

  const { transcript = [], candidateName = '', jobText = '', lang = 'ru', plan, profile, token: calltipsToken } = body;
  if (!profile || !/^[a-zA-Z0-9_-]+$/.test(profile) || !calltipsToken || calltipsToken !== calltipsHmac(profile))
    return json(res, 403, { error: 'invalid or missing token for this profile' });

  const recent = transcript.slice(-20).map(l =>
    `${l.speaker === 'me' ? 'Я' : 'Они'}: ${l.text}`
  ).join('\n');

  // Build plan context (unasked questions only)
  const askedSet = new Set(body.askedQuestions || []);
  const planCtx = plan?.sections?.flatMap(s =>
    s.questions.map((q, i) => {
      const id = `${s.category}-${i}`;
      const mark = askedSet.has(id) ? '[✓]' : '[ ]';
      return `${mark} ${q.text}`;
    })
  ).join('\n') || '';

  const promptText = `Ты — помощник интервьюера в реальном времени. Слушаешь разговор и даёшь ОДИН острый уточняющий вопрос.

ПРАВИЛО: зацепись за конкретное слово или деталь из последней реплики собеседника. Не оценивай — уточняй.
Пример: собеседник сказал "делал лапароскопию" → "А когда вы выбираете открытую операцию вместо лапароскопии?"
Пример: сказал "работал с PostgreSQL" → "Расскажите о самой сложной проблеме с индексами в PostgreSQL."

Собеседник: ${candidateName || 'собеседник'}
Тема: ${(jobText || '').slice(0, 300) || '(не указана)'}

ПЛАН (незаданные вопросы):
${planCtx || '(без плана)'}

ПОСЛЕДНИЕ РЕПЛИКИ:
${recent || '(пока нет)'}

Верни ТОЛЬКО JSON:
{"next":"Если в плане есть незаданный важный вопрос — задай его. Иначе пустая строка.","dig":"ГЛАВНОЕ: один острый уточняющий вопрос к последней реплике — зацепись за конкретную деталь. Всегда заполняй если есть реплики.","why":"Если ответ размытый — попроси конкретный пример. Иначе пустая строка."}
Язык: ${lang === 'en' ? 'English' : 'русский'}.`;

  if (!ladderToken()) return json(res, 503, { error: 'llm-ladder токен не найден' });

  // Interview tip generation — DEFAULT ladder (src/hh-llm.js purpose 'default').
  const tip = await hhLlm({
    messages: [{ role: 'user', content: promptText }],
    purpose: 'default',
    maxTokens: 300,
    timeoutMs: 15_000,
    source: 'hh-interview-tip',
  }).then((text) => {
    const clean = String(text || '{}').replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    return JSON.parse(clean);
  }).catch(() => ({ dig: '', next: '', why: '' }));

  return json(res, 200, tip);
}

  return false;
}

/**
 * Post-gate HH routes (BEHIND the Bearer gate — require Authorization: Bearer).
 * Returns true if the request was handled.
 */
async function handleHhAuthed(req, url, res, ctx) {
  if (ctx.runMcpTool) hostRunMcpTool = ctx.runMcpTool;
  const { BASE_USERS_DIR } = ctx;

if (req.method === 'GET' && url.pathname === '/hh/ats-config') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const username = url.searchParams.get('username') || '';
  const vacancyId = url.searchParams.get('vacancy_id') || null;
  // Must match BASE_USERS_DIR so runHhScoringForUser can find the file
  const workDir = username ? path.join(BASE_USERS_DIR, username) : process.cwd();
  const stagesFile = path.join(workDir, 'contexts', 'hh', `ats_stages:${vacancyId || ''}.json`);
  const { readAtsConfig } = require('./hh-scoring');
  const config = readAtsConfig(workDir, vacancyId);
  let stages = null;
  try {
    if (fs.existsSync(stagesFile)) stages = JSON.parse(fs.readFileSync(stagesFile, 'utf8')).value;
  } catch {}
  let revision = null; try {revision = JSON.parse(fs.readFileSync(path.join(workDir,'contexts','hh',`ats_config:${vacancyId}.json`),'utf8')).updated_at || null;} catch {}
  return json(res, 200, { ok: true, config, stages:config?.communication_plan?.stages || stages, revision });
}


  return false;
}

module.exports = { handleHhPublic, handleHhAuthed, generateCandidateProfileHtml };
