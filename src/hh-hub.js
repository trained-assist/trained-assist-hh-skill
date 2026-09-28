'use strict';
// Recruiting hub v1 (trained-assist-agent#1742, UX spec §2.1/§3): data for the
// «Вакансии» screen and the programmatic playbook launch behind «▶ Собрать».
// Everything is read from the same FS files the rest of hh-skill uses; the launch
// goes through the host's runMcpTool('playbook_run') — no engine session, so the
// HTTP answer is immediate.
const fs = require('fs');
const path = require('path');
const { dataRoot, tokensRoot } = require('./data-paths.js');
const { readActiveVacancies } = require('./hh-utils');
const { readVacancyState } = require('./hh-vacancy');

const LAUNCH_PLAYBOOK_ID = 'recruiting-vacancy-launch';
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

const DRAFT_STATUS_LABEL = {
  collecting: 'черновик собирается',
  draft_ready: 'черновик готов',
  hh_draft: 'черновик на HH',
};

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function negotiationsCacheFile(dataDir, username, vacancyId) {
  // Same layout as hh-negotiations.js hhCacheFile.
  return path.join(dataDir, 'hh', String(username), `negotiations-cache:${vacancyId}.json`);
}

function atsConfigured(workDir, vacancyId) {
  try { return !!require('./hh-scoring').readAtsConfig(workDir, vacancyId); } catch { return false; }
}

function hhConnected(username) {
  return fs.existsSync(path.join(tokensRoot(), String(username), 'hh'));
}

// Cards for the «Вакансии» screen: HH-tracked vacancies (active_vacancies.json) plus
// the current draft (vacancy_draft.json). A draft already pushed to HH as a tracked
// vacancy is merged into that vacancy's card instead of showing twice.
function collectVacancyCards({ workDir, username, dataDir = dataRoot() }) {
  const cards = readActiveVacancies(workDir).map(v => {
    const cache = readJson(negotiationsCacheFile(dataDir, username, v.id));
    return {
      id: String(v.id),
      title: v.title || 'Вакансия',
      status: 'tracked',
      status_label: 'отслеживается HH',
      tracked: true,
      responses: Array.isArray(cache?.negotiations) ? cache.negotiations.length : null,
      synced_at: cache?.synced_at || null,
      ats_configured: atsConfigured(workDir, v.id),
      draft: null,
    };
  });
  const state = readVacancyState(workDir);
  if (state && DRAFT_STATUS_LABEL[state.status]) {
    const draft = {
      vacancy_id: state.vacancy_id || null,
      status: state.status,
      status_label: DRAFT_STATUS_LABEL[state.status],
      landing_url: state.landing_url || null,
      launchable: state.status === 'draft_ready',
    };
    const title = state.draft?.name || null;
    const tracked = state.hh_vacancy_id && cards.find(c => c.id === String(state.hh_vacancy_id));
    if (tracked) {
      tracked.draft = draft;
    } else {
      cards.unshift({
        id: String(state.vacancy_id || ''),
        title: title || 'Новая вакансия',
        status: state.status,
        status_label: draft.status_label,
        tracked: false,
        responses: null,
        synced_at: null,
        ats_configured: false,
        draft,
      });
    }
  }
  const lastScoring = readJson(path.join(dataDir, 'hh', String(username), 'last-scoring.json'));
  return { cards, lastScoredAt: lastScoring?.at || null, hhConnected: hhConnected(username) };
}

// The one card «▶ Собрать» may launch: the current draft in draft_ready, addressed
// either by its own draft id or by the HH vacancy it was pushed to.
function findLaunchableDraft(workDir, vacancyId) {
  const state = readVacancyState(workDir);
  if (!state || state.status !== 'draft_ready') return null;
  const ids = [state.vacancy_id, state.hh_vacancy_id].filter(Boolean).map(String);
  if (!ids.includes(String(vacancyId))) return null;
  return {
    vacancy_id: String(vacancyId),
    vacancy_title: state.draft?.name || 'Вакансия',
    landing_url: state.landing_url || null,
  };
}

function launchGoal(vacancyTitle) {
  return `Запустить подбор по вакансии «${vacancyTitle}»`;
}

function planStatusPath(username, token, taskId) {
  const q = new URLSearchParams({ username, token: token || '', task_id: taskId });
  return `/hh/plan?${q.toString()}`;
}

function publicBase() {
  // Same host as the /hh/review and /hh/proactive links the bot mints (spec §7).
  return (process.env.HH_COLD_SEARCH_PUBLIC_URL || 'https://recruiter-assistant.ru').replace(/\/$/, '');
}

// Compile + activate the launch playbook through the host MCP tool runner.
// Returns { task, playbook } or throws an Error carrying .status for the HTTP answer.
async function runLaunchPlaybook({ runMcpTool, username, workDir, draft, goal }) {
  if (typeof runMcpTool !== 'function') {
    throw Object.assign(new Error('host runMcpTool not provided'), { status: 503 });
  }
  const text = await runMcpTool({
    tool: 'playbook_run',
    params: {
      playbook_id: LAUNCH_PLAYBOOK_ID,
      goal,
      activate: true,
      // The recruiter pressed «▶ Собрать»: that click is the consent for the plan's
      // notify hooks too (playbook_run contract: an action button = agreement).
      approve_hooks: true,
      vars: {
        vacancy_id: draft.vacancy_id,
        vacancy_title: draft.vacancy_title,
        landing_url: draft.landing_url || '',
      },
    },
    username,
    workDir,
    timeoutMs: 30000,
  });
  let result;
  try { result = JSON.parse(text || '{}'); } catch { throw Object.assign(new Error('bad playbook_run response'), { status: 502 }); }
  if (result.error) {
    const status = result.code === 'PLAYBOOK_NOT_FOUND' ? 404 : 422;
    throw Object.assign(new Error(result.error), { status, code: result.code });
  }
  if (!result.task?.id) throw Object.assign(new Error('playbook_run returned no task'), { status: 502 });
  return result;
}

// Telegram push with the status link. Best effort: a missing bot token / chat id or a
// Telegram failure is logged and never fails the launch request.
async function notifyLaunch({ secrets, readChatId, username, goal, statusUrl, fetchImpl = globalThis.fetch }) {
  const botToken = secrets?.TELEGRAM_BOT_TOKEN;
  let chatId = null;
  try { chatId = typeof readChatId === 'function' ? readChatId(username) : null; } catch { chatId = null; }
  if (!chatId) {
    try { chatId = fs.readFileSync(path.join(tokensRoot(), String(username), '.chatid'), 'utf8').trim() || null; } catch { chatId = null; }
  }
  if (!botToken || !chatId) {
    console.warn(`[hh/playbook-run] telegram notify skipped for ${username}: ${!botToken ? 'no TELEGRAM_BOT_TOKEN' : 'no .chatid'}`);
    return { sent: false, reason: !botToken ? 'no_bot_token' : 'no_chat_id' };
  }
  try {
    const r = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `▶ Процесс «${goal}» запущен.\nСтатус: ${statusUrl}`,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      console.warn(`[hh/playbook-run] telegram notify failed for ${username}: HTTP ${r.status}`);
      return { sent: false, reason: `http_${r.status}` };
    }
    return { sent: true };
  } catch (e) {
    console.warn(`[hh/playbook-run] telegram notify failed for ${username}: ${e.message}`);
    return { sent: false, reason: 'error' };
  }
}

module.exports = {
  LAUNCH_PLAYBOOK_ID, SAFE_ID, DRAFT_STATUS_LABEL,
  collectVacancyCards, findLaunchableDraft, launchGoal, planStatusPath, publicBase,
  runLaunchPlaybook, notifyLaunch, hhConnected,
};
