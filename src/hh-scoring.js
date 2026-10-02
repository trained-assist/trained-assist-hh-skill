'use strict';
const { dataRoot, tokensRoot } = require('./data-paths.js');
const { buildResumeText, resumeHash, RESUME_VERSION } = require('./hh-resume');

// Pure scoring utilities — no global state, no USER_ID dependency.
// Used by both 90-hh.js MCP tool and server.js /hh/review endpoint.

const fs = require('fs');
const path = require('path');
const { buildAvailabilityBlock, buildRecruiterIdentity, buildMessageSystemPrompt, loadBaseOverride, resolveMessageInstructions, hasRealAvailability } = require('./hh-message-prompts');
const { buildDraftUserMessage, historySignature, isDraftStale } = require('./hh-draft-message');
const { planNextStep, buildTestTaskMessage } = require('./hh-funnel');
const { bullshitGuard } = require('./hh-bullshit-guard');
const { generateConversation } = require('./conversation-generation');
const { ladderChat, ladderToken } = require('./llm-ladder');
// Credential store (trained-assist-agent#1939) via hh-utils' safe reader — the
// per-profile LLM keys and `hh-message-style` live under agent-tokens.
const { readCredentialFileSafe } = require('./hh-utils');

// Backoff for a candidate whose scoring failed: don't burn a ladder call on the same
// broken candidate every 5-minute cycle. 15 min, doubling per consecutive failure, cap 6h.
const SCORING_BACKOFF_BASE_MS = 15 * 60 * 1000;
const SCORING_BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;

const CHINESE_RE = /[一-鿿㐀-䶿豈-﫿぀-ヿ]/;

function hasGarbage(text) {
  if (!text) return false;
  return CHINESE_RE.test(text) || text.includes('�');
}

// All LLM calls (scoring, drafts, guards, planner) go through the ladder — see
// src/llm-ladder.js and src/hh-llm.js. The former per-file provider transports
// (OpenRouter / Sber GigaChat) were removed with the dead personal-key chains.


// ─── Shared helpers ───────────────────────────────────────────────────────────

function parseLlmJson(content) {
  if (!content) throw new Error('LLM returned empty content');
  content = content.trim();
  const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) content = fenceMatch[1].trim();
  return JSON.parse(content);
}

function buildAtsPrompt(config) {
  // Support all config shapes: must_have/nice_to_have, required/preferred, knockout/required_skills/preferred_skills
  const mustHave = config.must_have?.length ? config.must_have
    : config.required?.length ? config.required.map(c => c.name || c.criterion || c)
    : [
        ...(config.knockout || []).map(k => k.criterion || k),
        ...(config.required_skills || []).map(s => s.skill || s),
      ];
  const niceToHave = config.nice_to_have?.length ? config.nice_to_have
    : config.preferred?.length ? config.preferred.map(c => c.name || c)
    : (config.preferred_skills || []).map(s => s.skill || s);

  const mustList = mustHave.map(r => `  - ${r}`).join('\n') || '  (не указано)';
  const niceList = niceToHave.map(r => `  - ${r}`).join('\n') || '  (не указано)';

  const expNote = config.experience_min_years
    ? `\nМинимальный опыт: ${config.experience_min_years} лет — снижай балл если меньше, но не обнуляй за одно это.`
    : '';

  const ctx = config.vacancy_context || config.profile || '';
  return `Ты — опытный рекрутер. Оцени кандидата для позиции: ${config.vacancy_title || config.title}.
Контекст: ${ctx}${expNote}

ОБЯЗАТЕЛЬНЫЕ требования (отсутствие каждого снижает оценку):
${mustList}

ЖЕЛАТЕЛЬНЫЕ навыки (наличие повышает оценку):
${niceList}

ШКАЛА ОЦЕНКИ (1–10, абсолютная — не подгоняй под пул):
  9–10: Идеальное совпадение — все обязательные + большинство желательных, сильные примеры
  7–8:  Хорошее совпадение — большинство обязательных подтверждены, есть желательные
  5–6:  Частичное совпадение — часть обязательных есть, остальное неясно из резюме
  3–4:  Слабое совпадение — мало обязательных, или опыт не релевантен роли
  1–2:  Не подходит — явное несоответствие ключевым требованиям

ВАЖНО: Данные HH-резюме могут быть краткими. Если навык не упомянут — ставь низкий балл, но не 0 за одно только отсутствие упоминания. 0 — только явное несоответствие.

Отвечай ТОЛЬКО JSON без markdown. Пиши человекочитаемые фразы, не названия полей:
{
  "score": 7.5,
  "strong": ["3 года в private banking БКС", "Собственная база 20+ HNWI-клиентов", "AUM 800 млн ₽"],
  "missing": ["Опыт 3.5 года — требуется от 6", "Не подтверждён средний чек клиента"],
  "reasoning": "2–3 предложения: общее впечатление и главный аргумент за/против"
}`;
}

function computeScore(llmResult, config) {
  const score = Math.round(Math.max(0, Math.min(10, llmResult.score || 0)) * 2) / 2;
  const passThreshold = config.pass_threshold || config.thresholds?.strong || 7;
  const reviewThreshold = config.review_threshold || config.thresholds?.consider || 5;
  let verdict;
  if (score >= passThreshold) verdict = 'ПРОПУСТИТЬ';
  else if (score >= reviewThreshold) verdict = 'УТОЧНИТЬ';
  else verdict = 'ОТКЛОНИТЬ';

  return {
    score,
    verdict,
    matched: llmResult.strong || [],
    gaps: llmResult.missing || [],
    reasoning: llmResult.reasoning || '',
  };
}

// ─── evaluateCandidate: free ladder (owner decision, A/B 2026-09-30) ─────────

async function evaluateCandidate(candidateText, atsConfig, _unusedKey, _unusedKey2) {
  // ATS scoring runs on the ladder's free tier (docs/evals/ladder-enrichment-ab-
  // 2026-09-30.md: free-ladder, temp 0.1). The old direct-provider fallbacks are gone —
  // the ladder owns failover; the credential args stay in the signature for call-site
  // compatibility only.
  const { content } = await ladderChat({
    messages: [
      { role: 'system', content: buildAtsPrompt(atsConfig) },
      { role: 'user', content: `Оцени кандидата:\n\n${candidateText}` },
    ],
    ladder: 'free-ladder',
    temperature: 0.1,
    maxTokens: 2000,
    source: 'hh-evaluate',
  });
  const llmResult = parseLlmJson(content);
  return computeScore(llmResult, atsConfig);
}

// ─── Read tokens ──────────────────────────────────────────────────────────────

function readAtsConfigFile(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    let value = data?.value || null;
    // Guard: context_set sometimes stores value as JSON string instead of object
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
    return value;
  } catch { return null; }
}

function readAtsConfig(workDir, expectedVacancyId = null) {
  // Per-vacancy config (ats_config:{vacancy_id}.json) is the only config the pipeline
  // reads (epic #112). The legacy singleton ats_config.json was a leak between
  // vacancies — it held one vacancy's criteria (in an older schema) and two code
  // paths read it directly; the file may stay on disk for history, nothing reads it
  // for scoring or letters anymore.
  if (!expectedVacancyId) return null;
  return readAtsConfigFile(path.join(workDir, 'contexts', 'hh', `ats_config:${expectedVacancyId}.json`));
}

// Draft extracted by hh_extract_ats_config, pending recruiter review in /hh/ats-editor.
// Kept separate from the live ats_config:{id} file so an LLM-generated first pass never
// goes live for background scoring before a human has looked at it in the editor.
function readAtsDraft(workDir, vacancyId) {
  const file = vacancyId
    ? path.join(workDir, 'contexts', 'hh', `ats_config_draft:${vacancyId}.json`)
    : path.join(workDir, 'contexts', 'hh', 'ats_config_draft.json');
  return readAtsConfigFile(file);
}


// ─── Candidate history ────────────────────────────────────────────────────────

function candidateHistoryPath(username, negotiationId) {
  const dataDir = dataRoot();
  return path.join(dataDir, 'hh', String(username), 'candidates', `${negotiationId}.json`);
}

function readCandidateHistory(username, negotiationId) {
  const file = candidateHistoryPath(username, negotiationId);
  if (!fs.existsSync(file)) return { messages: [], ats_result: null };
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { messages: [], ats_result: null }; }
}

function saveCandidateHistory(username, negotiationId, data) {
  const file = candidateHistoryPath(username, negotiationId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// ─── Batch scoring: free ladder ──────────────────────────────────────────────

// Exponential backoff window for a candidate whose scoring failed: 15 min, 30, 60 …
// capped at 6h. `attempts` is the number of consecutive failures recorded on the
// candidate history (reset on the next success).
function scoringBackoffMs(attempts = 1) {
  const n = Math.max(1, Number(attempts) || 1);
  return Math.min(SCORING_BACKOFF_BASE_MS * 2 ** (n - 1), SCORING_BACKOFF_CAP_MS);
}

function inScoringBackoff(history, now = Date.now()) {
  const err = history?.scoring_error;
  if (!err || !err.at) return false;
  return now - err.at < scoringBackoffMs(err.attempts);
}

async function scoreUnscoredCandidates(negotiations, username, workDir, { maxConcurrent = 5, msgSyncStats = null, vacancyId = null, onStats = null } = {}) {
  const atsConfig = readAtsConfig(workDir, vacancyId);
  if (!atsConfig) return 0;

  // ATS scoring rides the free ladder — the ladder token is the only credential here.
  if (!ladderToken()) return 0;

  const now = Date.now();
  const unscored = negotiations.filter(neg => {
    if (neg._resume_status !== 'full') return false;
    const history = readCandidateHistory(username, neg.id);
    // A changed resume is new input — always (re)score it, backoff or not. Only
    // meaningful once there IS a result to compare against; a candidate that was
    // never scored has no previous version, and must fall through to the backoff below
    // instead of being retried every cycle.
    const hadResult = !!history.ats_result;
    if (hadResult && (history.ats_result.resume_version !== RESUME_VERSION || history.ats_result.resume_hash !== resumeHash(neg))) return true;
    if (history.ats_result?.score == null) {
      // Not scored yet — unless the last attempt failed and is still in backoff.
      // Without this, one broken candidate burned a ladder call every 5-minute
      // cycle forever while the log reported success.
      return !inScoringBackoff(history, now);
    }
    // re-score if candidate replied after last scoring
    const scoredAt = history.ats_result.scored_at || 0;
    const lastCandMsg = [...(history.messages || [])].reverse().find(m => m.role === 'applicant');
    if (!lastCandMsg) return false;
    return new Date(lastCandMsg.timestamp || 0).getTime() > scoredAt;
  });

  const writeLog = (checked, scored, failed = 0) => {
    try {
      const dataDir = dataRoot();
      const dir = path.join(dataDir, 'hh', String(username));
      fs.mkdirSync(dir, { recursive: true });
      const entry = {
        at: Date.now(),
        checked,
        scored,
        // Honest degradation: how many candidates were attempted and NOT scored.
        // The old log only carried `scored`, so a run where every call failed still
        // looked like a healthy "checked N, scored 0".
        failed,
        // message sync stats from background loop (null when called from tests/manual)
        ...(msgSyncStats ? {
          with_new_messages: msgSyncStats.synced,
          new_messages_loaded: msgSyncStats.newMessages,
        } : {}),
      };
      // last-scoring.json — single entry for quick read
      fs.writeFileSync(path.join(dir, 'last-scoring.json'), JSON.stringify(entry), { mode: 0o600 });
      // sync-log.json — rolling last 50 entries
      const logPath = path.join(dir, 'sync-log.json');
      let entries = [];
      try { entries = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch { /* first run */ }
      entries.unshift(entry);
      if (entries.length > 50) entries.length = 50;
      fs.writeFileSync(logPath, JSON.stringify(entries), { mode: 0o600 });
    } catch { /* non-critical */ }
  };

  if (!unscored.length) {
    writeLog(negotiations.length, 0);
    return 0;
  }

  let scored = 0;
  let failed = 0;
  for (let i = 0; i < unscored.length; i += maxConcurrent) {
    const batch = unscored.slice(i, i + maxConcurrent);
    await Promise.all(batch.map(async (neg) => {
      try {
        const history = readCandidateHistory(username, neg.id);
        const candMsgs = (history.messages || []).filter(m => m.role === 'applicant');
        const resumeText = buildResumeText(neg, candMsgs);
        const result = await module.exports.evaluateCandidate(resumeText, atsConfig);
        if (result.score == null) throw new Error('scoring returned no score');
        result.scored_at = Date.now();
        result.resume_version = RESUME_VERSION;
        result.resume_hash = resumeHash(neg);
        history.ats_result = result;
        delete history.scoring_error;
        saveCandidateHistory(username, neg.id, history);
        scored++;
      } catch (e) {
        // Record the failure ON the candidate and back off: the review page can show
        // "оценка не получена" instead of a silent "не оценён", and the next cycles
        // skip this candidate until the backoff window passes.
        failed++;
        try {
          const history = readCandidateHistory(username, neg.id);
          const attempts = (history.scoring_error?.attempts || 0) + 1;
          history.scoring_error = { message: String(e.message || e).slice(0, 300), at: Date.now(), attempts };
          saveCandidateHistory(username, neg.id, history);
        } catch { /* failure to record must not mask the original failure */ }
        console.error(`[hh-scoring] failed to score ${neg.id}:`, e.message);
      }
    }));
  }

  writeLog(unscored.length, scored, failed);
  if (onStats) { try { onStats({ checked: unscored.length, scored, failed }); } catch { /* logging must not break scoring */ } }
  return scored;
}

// ─── Draft generation: conversation generation (ladder 'conversations') ───────

async function generateDraftMessages(negotiations, username, workDir, { maxConcurrent = 3, vacancyId = null } = {}) {
  const atsConfig = readAtsConfig(workDir, vacancyId);
  if (!atsConfig) return 0;

  // Every write goes through src/conversation-generation.js (model pick + Q/A history
  // for the bench) — the ladder token is the only credential; the old per-user
  // credential paths left this path with the switch to the 'conversations' ladder.
  if (!ladderToken()) return 0;

  const tokensBase = tokensRoot();
  const styleFile = path.join(tokensBase, String(username), 'hh-message-style');
  const commStyle = readCredentialFileSafe(styleFile)?.trim() || null;
  const baseOverride = loadBaseOverride(tokensBase, username);

  // Read recruiter identity config (agency, name, signature, rules)
  let msgCfg = null;
  try {
    const msgCfgFile = path.join(workDir, 'contexts', 'hh', 'message_config.json');
    if (fs.existsSync(msgCfgFile)) {
      const raw = JSON.parse(fs.readFileSync(msgCfgFile, 'utf8'));
      let val = raw?.value;
      if (typeof val === 'string') val = JSON.parse(val);
      if (val && typeof val === 'object') msgCfg = val;
    }
  } catch { /* ignore */ }
  const recruiterCtx = buildRecruiterIdentity(msgCfg);
  const availabilityBlock = buildAvailabilityBlock(atsConfig.interview_config);
  // Per-vacancy process instructions (epic #112): own field → recruiter template → default.
  const vacancyInstruction = resolveMessageInstructions({ username, tokensBase, atsConfig });

  const vacancyCtx = atsConfig.vacancy_title && atsConfig.vacancy_context
    ? `Вакансия: ${atsConfig.vacancy_title}\n\n${atsConfig.vacancy_context}`
    : '';

  const needDraft = negotiations.filter(neg => {
    if (neg._resume_status !== 'full') return false;
    const h = readCandidateHistory(username, neg.id);
    // Rejections use the fixed standard text rendered on the review page — never an
    // LLM draft. Generated "rejections" produced invitations, "[Имя]" placeholders
    // and wrong-name greetings that a single click could send to a candidate.
    if (h.ats_result?.verdict === 'ОТКЛОНИТЬ') return false;
    if (h.ats_result?.score == null) return false;
    // A draft written against an older thread is worse than no draft: /hh/review shows
    // it as-is and the recruiter can send one click away. Regenerate whenever the
    // candidate said something new (live case: neg 5610867713, drafted at 12:15 against
    // a thread that had already changed at 12:03 and was cached from then on).
    return isDraftStale(h, vacancyInstruction);
  });

  if (!needDraft.length) return 0;

  const baseSystem = buildMessageSystemPrompt({ vacancyContext: vacancyCtx, recruiterCtx, commStyle, baseOverride, vacancyInstruction, atsConfig });

  let generated = 0;

  for (let i = 0; i < needDraft.length; i += maxConcurrent) {
    const batch = needDraft.slice(i, i + maxConcurrent);
    await Promise.all(batch.map(async (neg) => {
      try {
        const history = readCandidateHistory(username, neg.id);
        const thread = history.messages || [];

        const r = neg.resume || {};
        const firstName = r.first_name || r.last_name || 'Кандидат';

        // The thread decides the shape of the message (see src/hh-draft-message.js).
        // This used to be hardcoded to "Напиши первое сообщение" with the resume only,
        // so a candidate who had already been written to and answered got a second
        // intro on the review page — re-introducing the recruiter and re-asking
        // questions he had just been asked.
        // history is an ARRAY by contract (see hh-draft-message.js). This line wrapped it
        // as { messages: thread }, so (history || []).filter threw and every background
        // auto-draft failed on every cycle with "(history || []).filter is not a function".
        // The funnel decides WHAT to do; the writer only renders it (01.10.2026).
        // 'wait' and 'reject' produce no draft at all — a candidate we already
        // wrote to and who did not answer must not get a second letter from the
        // background loop.
        const plan = await planNextStep({
          history: thread,
          atsResult: history.ats_result,
          atsConfig: atsConfig || {},
          resumeText: buildResumeText(neg),
          username,
        });
        history.ats_result.funnel_action = plan.action;
        history.ats_result.funnel_reason = plan.reason;
        if (plan.action === 'wait' || plan.action === 'reject') {
          // Record WHY there is no draft, against the same thread signature — so the
          // next cycle knows this was decided, not forgotten.
          history.ats_result.draft_skip_sig = historySignature(thread, vacancyInstruction);
          if (plan.action === 'reject') delete history.ats_result.draft_message;
          saveCandidateHistory(username, neg.id, history);
          return;
        }
        delete history.ats_result.draft_skip_sig;
        // The test task goes out word-for-word, assembled in code — a model
        // paraphrase would break the promise the vacancy text makes.
        if (plan.action === 'send_test') {
          const verbatim = buildTestTaskMessage(atsConfig?.test_task);
          if (verbatim) {
            history.ats_result.draft_message = verbatim;
            history.ats_result.draft_history_sig = historySignature(thread, vacancyInstruction);
            delete history.ats_result.draft_warning;
            saveCandidateHistory(username, neg.id, history);
            generated++;
            return;
          }
        }

        const systemPrompt = baseSystem;

        const resumeText = buildResumeText(neg);
        const userMsg = buildDraftUserMessage({
          messageType: 'reply',
          firstName,
          resumeText,
          atsResult: history.ats_result,
          history: thread,
          availabilityBlock,
          action: plan.action,
          missingSkills: plan.missing_skills,
          testTask: atsConfig?.test_task || '',
          vacancyInstruction,
        });

        const messages = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMsg },
        ];

        // The write itself: ladder 'conversations' via conversation generation —
        // the serving rung lands in the Q/A history for the bench.
        let message = await generateConversation({ messages, temperature: 0.7, maxTokens: 600, source: 'hh-drafts' });
        if (hasGarbage(message)) throw new Error('conversation generation returned garbage');
        message = message.trim();

        // An auto-draft reaches the recruiter pre-filled and one click from being sent,
        // so it gets the same guard as a manually generated one — including one retry
        // that tells the model what was wrong. Without it, a repeated intro landed on
        // the review page undetected (this path never ran the guard at all).
        const allowSpecificTime = hasRealAvailability(atsConfig?.interview_config);
        let guard = await bullshitGuard(message, thread, { username, allowSpecificTime, resumeText });
        if (!guard.ok) {
          console.warn(`[hh-drafts] neg=${neg.id} failed guard (${guard.reason}), regenerating once`);
          const retryMessages = [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: `${userMsg}\n\n(Предыдущая попытка была отклонена автопроверкой: "${guard.reason}". `
                + 'Не повторяй эту ошибку — напиши новый вариант без неё.)',
            },
          ];
          try {
            const retried = await generateConversation({ messages: retryMessages, temperature: 0.7, maxTokens: 600, source: 'hh-drafts' });
            if (retried && !hasGarbage(retried)) {
              message = retried.trim();
              guard = await bullshitGuard(message, thread, { username, allowSpecificTime, resumeText });
            }
          } catch (e) {
            console.warn(`[hh-drafts] retry failed for ${neg.id}: ${e.message}`);
          }
        }

        history.ats_result.draft_message = message;
        // Stamp the thread this draft was written against — without it the next scoring
        // pass cannot tell a fresh draft from one that predates the candidate's answer.
        history.ats_result.draft_history_sig = historySignature(thread, vacancyInstruction);
        if (!guard.ok) history.ats_result.draft_warning = guard.reason;
        else delete history.ats_result.draft_warning;
        saveCandidateHistory(username, neg.id, history);
        generated++;
      } catch (e) {
        console.error(`[hh-drafts] failed to generate draft for ${neg.id}:`, e.message);
      }
    }));
  }

  return generated;
}

module.exports = {
  parseLlmJson,
  buildAtsPrompt,
  computeScore,
  evaluateCandidate,
  readAtsConfig,
  readAtsDraft,
  readCandidateHistory,
  saveCandidateHistory,
  buildResumeText,
  scoreUnscoredCandidates,
  generateDraftMessages,
};
