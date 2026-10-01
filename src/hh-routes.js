'use strict';
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
const userWorkDir = (username) => path.join(usersRoot(), String(username));

const { sendRejection, REJECT_REASON_ACTION } = require('./hh-rejection');
const { hydrateResume, buildResumeText, resumeNotice } = require('./hh-resume');
const { hhFetch, hhPut, hhPostForm, readHhToken, readHhTokenFile, readCredentialFileSafe, refreshHhToken, readActiveVacancies } = require('./hh-utils');
// Credential store (trained-assist-agent#1939): every credential file this
// module touches (`hh`, `openrouter`, `hh-message-style`, `hh-message-base-prompt`)
// passes through it — legacy plaintext transparent, a v2 envelope decrypted,
// a base64 stub never returned, a missing CRED_ENCRYPTION_KEY → plaintext with a
// warning (never a hard failure).
const { writeCredentialFile, deleteCredential } = require('./credential-store');
const { bullshitGuard } = require('./hh-bullshit-guard');
const { buildAvailabilityBlock, buildRecruiterIdentity, buildMessageSystemPrompt, buildRejectionSystemPrompt, loadBaseOverride, DEFAULT_MESSAGE_BASE, BASE_PROMPT_FILENAME } = require('./hh-message-prompts');
const { buildDraftUserMessage, historySignature } = require('./hh-draft-message');
const { planNextStep, buildTestTaskMessage } = require('./hh-funnel');
const { generateConversation } = require('./conversation-generation');
const { hhLlm } = require('./hh-llm');
const { ladderToken } = require('./llm-ladder');
const { hhInterviewConfigAllowsTime } = require('./hh-negotiations');
const { appendLocalMessage } = require('./hh-history');

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
  const base = (process.env.HH_COLD_SEARCH_PUBLIC_URL || 'https://recruiter-assistant.ru').replace(/\/$/, '');
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

if (req.method === 'OPTIONS' && (url.pathname === '/hh/send' || url.pathname === '/hh/reject' || url.pathname === '/hh/send-and-reject' || url.pathname === '/hh/ats-config' || url.pathname === '/hh/review' || url.pathname === '/hh/candidate' || url.pathname === '/hh/reset-ats-results' || url.pathname === '/hh/generate-message' || url.pathname === '/hh/update-style' || url.pathname === '/hh/update-base-prompt' || url.pathname === '/hh/sync-negotiations')) {
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
  } catch (e) {
    console.error('[hh/review] fetch error:', e.message);
    syncError = 'Не удалось обновить отклики из HH. Показаны последние сохранённые данные.';
    try {
      const cached = JSON.parse(fs.readFileSync(hhCacheFile(dataDir, username, vacancy.id), 'utf8'));
      negotiations = cached.negotiations; syncedAt = cached.synced_at;
    } catch { syncError = 'Не удалось загрузить отклики из HH. Нажмите «Обновить» для повтора.'; }
  }

  // Sync HH thread messages into local history before rendering
  // (capped at 15 negs, ~2-3s max; errors are non-fatal)
  await syncHhMessagesToHistory(dataDir, username, negotiations, tokenData.access_token).catch(e => {
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
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f1f5f9;color:#1e293b;padding:24px}h1{font-size:20px;font-weight:700;margin-bottom:4px}.sub{font-size:13px;color:#64748b;margin-bottom:20px}h2{font-size:16px;font-weight:600;margin:24px 0 8px}table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);margin-bottom:8px}th{background:#f8fafc;font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.04em;padding:10px 16px;text-align:left;border-bottom:1px solid #e2e8f0}td{padding:10px 16px;font-size:14px;border-bottom:1px solid #f1f5f9}tr:last-child td{border-bottom:none}</style>
</head><body>
<h1>История скоринга и Guard</h1>
<p class="sub">Последние запуски · ${username}</p>
<h2>Фоновый скоринг</h2>
<table><thead><tr><th>Время (МСК)</th><th>Проверено</th><th>Новых сообщ.</th><th>Скоринг</th><th>С активностью</th><th>API ошибки</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Bullshit Guard — последние блокировки и пропуски проверки</h2>
<table><thead><tr><th>Время</th><th>neg_id</th><th>Статус</th><th>Причина</th></tr></thead><tbody>${guardRows}</tbody></table>
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
  // Must match BASE_USERS_DIR so runHhScoringForUser can find the file
  const contextBase = username
    ? path.join(BASE_USERS_DIR, username, 'contexts')
    : path.join(process.cwd(), 'contexts');
  const hhContextDir = path.join(contextBase, 'hh');
  fs.mkdirSync(hhContextDir, { recursive: true });
  const now = new Date().toISOString();
  // Once the editor knows which vacancy it's editing (multi-vacancy tabs), save under
  // the per-vacancy key only — writing to the legacy singleton too would let whichever
  // vacancy tab saves last silently clobber the others' config (same class of bug
  // step 2/6 fixed for the background scoring read path; see hh-scoring.js readAtsConfig).
  const configName = vacancyId ? `ats_config:${vacancyId}` : 'ats_config';
  // The editor form only knows some fields (no filters.area, search queries, …).
  // Keep whatever it doesn't send instead of silently dropping it on every save.
  const configFile = path.join(hhContextDir, `${configName}.json`);
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(configFile, 'utf8')).value || {}; } catch { /* first save */ }
  if (typeof prev === 'string') { try { prev = JSON.parse(prev); } catch { prev = {}; } }
  const merged = { ...prev, ...config, vacancy_id: vacancyId || config.vacancy_id || prev.vacancy_id };
  if (prev.filters && typeof prev.filters === 'object') merged.filters = { ...prev.filters, ...(config.filters || {}) };
  fs.writeFileSync(configFile, JSON.stringify({ value: merged, updated_at: now }, null, 2));
  // Funnel stages stay a single global blob for now (deliberately deferred, like
  // hh_generate_message tone context in PR #1067 — different vacancies commonly share
  // the same interview stages; per-vacancy stages can follow if that stops being true).
  if (Array.isArray(stages)) {
    fs.writeFileSync(
      path.join(hhContextDir, 'ats_stages.json'),
      JSON.stringify({ value: stages, updated_at: now }, null, 2),
    );
  }
  console.log(`[hh/ats-config] saved vacancy="${config.vacancy_title}" vacancy_id=${vacancyId || 'legacy'} stages=${stages?.length || 0} user=${username || 'default'}`);
  return json(res, 200, { ok: true });
}

if (req.method === 'POST' && url.pathname === '/hh/reset-ats-results') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // NOTE (multi-vacancy step 3/6, deliberately deferred): candidate history files
  // (candidates/{neg_id}.json) don't record which vacancy they belong to, so this
  // still resets ALL of a user's candidates across every tracked vacancy — "Re-run
  // Funnel" on one vacancy's tab wipes another vacancy's scores too. Scoping this
  // properly needs either stamping vacancy_id onto candidate history on write, or
  // fetching the vacancy's negotiation ID set here before filtering. Out of scope for
  // the tabs-only pass; flagging so it isn't mistaken for "already handled".
  const body = JSON.parse(await readBody(req));
  const { username } = body || {};
  if (!username) return json(res, 400, { error: 'username required' });
  if (!pageAuthOk(req, username, body?.token)) return json(res, 403, { error: 'invalid token' });
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
  const stagesFile = path.join(contextBase, 'hh', 'ats_stages.json');
  const activeVacancies = readActiveVacancies(workDir);
  const requestedVacancyId = url.searchParams.get('vacancy_id') || '';
  const activeVacancy = activeVacancies.find(v => String(v.id) === requestedVacancyId) || activeVacancies[0] || null;
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
  const callbackBase = (process.env.AGENT_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
  const html = atsEditorHtml(currentConfig, currentStages, {
    callbackBase,
    username,
    pageToken: agentSecret ? proactiveHmac(username) : '',
    vacancies: activeVacancies,
    activeVacancyId: activeVacancy?.id || '',
    isDraft,
  });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  return res.end(html);
}

if (req.method === 'POST' && url.pathname === '/hh/send') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  const { username, negotiation_id, message, force } = body || {};
  if (!username || !negotiation_id || !message) return json(res, 400, { error: 'missing fields' });
  if (!pageAuthOk(req, username, body?.token)) return json(res, 403, { error: 'invalid token' });

  const hhTokensBase = tokensRoot();
  const tokenFile = path.join(hhTokensBase, String(username), 'hh');
  if (!fs.existsSync(tokenFile)) return json(res, 403, { error: 'HH not connected for this user' });
  const tokenData = readHhTokenFile(tokenFile);
  if (!tokenData) return json(res, 403, { error: 'HH token unreadable' });

  const dataDir = dataRoot();
  const histDir = path.join(dataDir, 'hh', String(username), 'candidates');
  fs.mkdirSync(histDir, { recursive: true });
  const histFile = path.join(histDir, `${negotiation_id}.json`);
  const history = fs.existsSync(histFile) ? JSON.parse(fs.readFileSync(histFile, 'utf8')) : { messages: [] };
  history.messages = history.messages || [];

  const allowSpecificTime = hhInterviewConfigAllowsTime(username);
  const guard = await bullshitGuard(message, history.messages, { username, allowSpecificTime });
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
    const sent = await hhPostForm(`/negotiations/${negotiation_id}/messages`, tokenData, { message });
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
    json(res, 200, { ok: true });
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
    return json(res, 500, { error: e.message });
  }
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
  if (!ladderToken()) return json(res, 503, { error: 'llm-ladder token not configured' });

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
  const history = fs.existsSync(histFile) ? JSON.parse(fs.readFileSync(histFile, 'utf8')) : { messages: [] };
  const msgs = history.messages || [];
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

  let fullResumeText = (resume_text || '').trim();
  if (hhToken) {
    try {
      const neg = await hhFetch(`/negotiations/${negotiation_id}`, hhToken);
      await hydrateResume(neg, hhToken);
      if (neg._resume_status === 'full') fullResumeText = buildResumeText(neg);
    } catch { /* use page text if HH is temporarily unavailable */ }
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

  const recruiterCtx = buildRecruiterIdentity(msgCfg);
  const systemPrompt = msgType === 'rejection'
    ? buildRejectionSystemPrompt({ recruiterCtx, commStyle })
    : buildMessageSystemPrompt({ vacancyContext, recruiterCtx, commStyle, baseOverride });

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
      testTask: atsConfig?.test_task || '',
    });

  function callLlm(userContent) {
    // One abstraction for every candidate-message write: ladder 'conversations'
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
    const allowSpecificTime = hhInterviewConfigAllowsTime(username);
    // The test task is the one letter that must NOT be written by a model: the
    // vacancy promises it goes out word-for-word.
    let message = plan?.action === 'send_test'
      ? (buildTestTaskMessage(atsConfig?.test_task) || await callLlm(userMsg))
      : await callLlm(userMsg);
    let guard = await bullshitGuard(message, msgs, { username, allowSpecificTime });
    if (!guard.ok) {
      console.warn(`[hh/generate-message] draft failed guard, regenerating: user=${username} neg=${negotiation_id} reason="${guard.reason}"`);
      const retryMsg = `${userMsg}\n\n(Предыдущая попытка была отклонена автопроверкой: "${guard.reason}". Не повторяй эту ошибку — напиши новый вариант без неё.)`;
      message = await callLlm(retryMsg);
      guard = await bullshitGuard(message, msgs, { username, allowSpecificTime });
    }

    if (!history.ats_result) history.ats_result = {};
    history.ats_result.draft_message = message;
    // Stamp the thread this draft answers, so the background auto-draft knows it is
    // still current and does not overwrite a manual draft with a stale-looking one.
    history.ats_result.draft_history_sig = historySignature(msgs);
    if (!guard.ok) history.ats_result.draft_warning = guard.reason;
    else delete history.ats_result.draft_warning;
    fs.mkdirSync(candDir, { recursive: true });
    fs.writeFileSync(histFile, JSON.stringify(history, null, 2), { mode: 0o600 });
    const resp = { ok: true, message };
    if (plan) { resp.funnel_action = plan.action; resp.funnel_reason = plan.reason; }
    if (!guard.ok) resp.guard_warning = guard.reason;
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
  const callbackBase3 = (process.env.AGENT_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
  const hmacToken3 = agentSecret ? require('crypto').createHmac('sha256', agentSecret).update(username).digest('hex').slice(0, 16) : '';
  const defaultStyle = '- Тон: профессиональный, дружелюбный, без официоза. Обращение на «вы».\n- Приветствие: «Добрый день, [Имя]!» или «Здравствуйте, [Имя]!»\n- Структура: приветствие → что понравилось в резюме → описание роли → 1-2 конкретных вопроса → призыв ответить\n- Всегда задаю конкретные вопросы по опыту из требований вакансии, не общие\n- Не использую штампы: «рассмотрели вашу кандидатуру», «вакансия открылась», «мы ищем»\n- Длина: 4-6 предложений\n- Подпись: имя рекрутера';
  const rulesValue = (existingStyle || defaultStyle).replace(/`/g, '\\`');
  const existingBase = loadBaseOverride(hhTokensBase3, username) || '';
  const hasBaseOverride = !!existingBase;
  const baseValue = (existingBase || DEFAULT_MESSAGE_BASE).replace(/`/g, '\\`');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  return res.end(hhStylePageHtml({ username, rulesValue, baseValue, hasBaseOverride, callbackBase: callbackBase3, hmacToken: hmacToken3 }));
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
    return json(res, 500, { error: e.message });
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
  const callbackBase = (process.env.HH_COLD_SEARCH_PUBLIC_URL || 'https://recruiter-assistant.ru').replace(/\/$/, '');
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
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  return res.end(generateProactivePageHtml(results, username, callbackBase, given, pageComments, { activeVacancies, vacancyId, listView, stateCounts, monitoring, searchSettings }));
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
  hhHub.notifyLaunch({ notifyProfile: ctx.notifyProfile, username, goal: goalText, statusUrl: hhHub.publicBase() + statusPath })
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

if (req.method === 'GET' && url.pathname === '/api/hh/proactive/candidates') {
  const username = url.searchParams.get('username') || '';
  const given = url.searchParams.get('token') || '';
  if (process.env.AGENT_SECRET && given !== proactiveHmac(username)) return json(res, 403, { error: 'invalid token' });
  const { loadAllCandidates } = require('./hh-proactive-search');
  const all = Object.values(loadAllCandidates(username, url.searchParams.get('vacancy_id')))
    .sort((a, b) => new Date(b.found_at || b.added_at || 0) - new Date(a.found_at || a.added_at || 0));
  return json(res, 200, { total: all.length, candidates: all });
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

if (req.method === 'POST' && url.pathname === '/api/hh/proactive/search') {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  const { username = '', token: givenToken = '' } = body || {};
  if (process.env.AGENT_SECRET && givenToken !== proactiveHmac(username)) return json(res, 403, { error: 'invalid token' });
  const workDir = path.join(BASE_USERS_DIR, username);
  try {
    const result = await runProactiveSearch(username, workDir, {
      vacancyId: body.vacancy_id,
      ...(Object.prototype.hasOwnProperty.call(body, 'area') ? { area: body.area } : {}),
      refreshAccessToken: (u) => refreshHhToken(u, _secretsCache),

    });
    return json(res, 200, result);
  } catch (e) {
    return json(res, 500, { error: e.message });
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
    const ctxAts = path.join(BASE_USERS_DIR, String(username), 'contexts', 'hh', 'ats_config.json');
    try {
      const raw = JSON.parse(fs.readFileSync(ctxAts, 'utf8'));
      let v = raw?.value;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
      if (v?.vacancy_id) vacancyKey = String(v.vacancy_id);
    } catch { /* no ats config — fall through */ }
    if (vacancyKey === 'unknown') {
      try {
        const avRaw = JSON.parse(fs.readFileSync(path.join(BASE_USERS_DIR, String(username), 'contexts', 'hh', 'active_vacancy.json'), 'utf8'));
        if (avRaw?.value?.id) vacancyKey = String(avRaw.value.id);
      } catch { /* no active vacancy — fall through */ }
    }
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
  const stagesFile = path.join(workDir, 'contexts', 'hh', 'ats_stages.json');
  const { readAtsConfig } = require('./hh-scoring');
  const config = readAtsConfig(workDir, vacancyId);
  let stages = null;
  try {
    if (fs.existsSync(stagesFile)) stages = JSON.parse(fs.readFileSync(stagesFile, 'utf8')).value;
  } catch {}
  return json(res, 200, { ok: true, config, stages });
}


  return false;
}

module.exports = { handleHhPublic, handleHhAuthed, generateCandidateProfileHtml };
