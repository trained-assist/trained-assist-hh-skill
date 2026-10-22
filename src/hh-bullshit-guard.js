'use strict';

// Checks outgoing HH messages for 5 classes of errors before sending.
// Regex checks run first (free). The semantic LLM check is one cheap call covering the
// rest — through the single ladder entry point (src/hh-llm.js, purpose 'score' →
// free-ladder). This module no longer resolves or reads any API key.

const { hhLlm, ladderToken } = require('./hh-llm');
const { asksKnownFact } = require('./hh-known-facts');
const { findInventedRequirements } = require('./hh-letter-checks');

// ─── Regex checks ─────────────────────────────────────────────────────────────

const PLACEHOLDER_RE = [
  /\{\{[^}]+\}\}/,                     // {{имя}}, {{name}}
  /\{[A-Za-zА-Яа-яёЁ_][^}]{0,29}\}/,  // {имя}, {name}
  /\[[A-Za-zА-Яа-яёЁ][^\]]{0,49}\]/,  // [имя], [ваше имя], [название компании]
];

function hasPlaceholder(text) {
  return PLACEHOLDER_RE.some(p => p.test(text));
}

// Plain \b doesn't detect word boundaries around Cyrillic letters (JS \w is ASCII-only),
// so Cyrillic alternatives use explicit lookaround instead of \b.
const CYR_BOUND_BEFORE = '(?<![а-яёА-ЯЁ])';
const CYR_BOUND_AFTER = '(?![а-яёА-ЯЁ])';
const cyrWord = (w) => `${CYR_BOUND_BEFORE}${w}${CYR_BOUND_AFTER}`;
const TIME_EXPR_RE = new RegExp([
  '\\d{1,2}[:.]\\d{2}\\b',
  `${CYR_BOUND_BEFORE}в\\s*\\d{1,2}\\s*(?:час|ч\\.)`,
  cyrWord('утром'), cyrWord('днём'), cyrWord('днем'), cyrWord('вечером'),
  cyrWord('сегодня'), cyrWord('завтра'), cyrWord('послезавтра'),
  cyrWord('понедельник'), cyrWord('вторник'), cyrWord('сред[ау]'), cyrWord('четверг'),
  cyrWord('пятниц[ау]'), cyrWord('суббот[ау]'), cyrWord('воскресень[ея]'),
].join('|'), 'gi');

// Detects a recruiter message naming a specific call time/date that wasn't echoed
// from the candidate's own messages — i.e. the model invented it rather than
// reflecting real availability configured for the vacancy.
function hasInventedTime(messageText, conversationHistory) {
  const found = messageText.match(TIME_EXPR_RE);
  if (!found) return false;
  const candidateText = conversationHistory
    .filter(m => m.role !== 'employer')
    .map(m => m.text || '')
    .join(' ')
    .toLowerCase();
  return !found.every(t => candidateText.includes(t.toLowerCase()));
}

// ─── LLM ──────────────────────────────────────────────────────────────────────

// Kept as a named export because call sites and tests monkey-patch it. The apiKey
// argument stays for signature compatibility but is ignored — the ladder owns the
// credential now (src/hh-llm.js).
function llmCall(_apiKey, messages) {
  return hhLlm({ messages, purpose: 'score', temperature: 0, maxTokens: 300, source: 'hh-guard' });
}

// Probe used by callers to decide "is a semantic check possible?". The ladder token is
// the only credential; the per-user OpenRouter key path is gone.
function getApiKey() {
  return ladderToken() ? 'llm-ladder' : null;
}

async function llmCheck(messageText, rawHistory, apiKey, llmFn) {
  // Judge the dialogue the recruiter actually had. A history that carries the same
  // outbound message twice (an old file written before hh-history dedupe) made every
  // intro look repeated and blocked legitimate sends — see src/hh-history.js.
  const history = require('./hh-history').dedupeMessages(rawHistory);
  const ctx = history.slice(-6).map(m => {
    const who = m.role === 'employer' ? 'Рекрутер' : 'Кандидат';
    return `${who}: ${m.text.slice(0, 300)}`;
  }).join('\n');

  const prompt = `Проверь новое сообщение рекрутера. Ответь ТОЛЬКО JSON, без пояснений.
${ctx ? `\nИстория переписки:\n${ctx}\n` : ''}
Новое сообщение: "${messageText}"

{"repeated_question": true/false, "repeated_intro": true/false, "template_garbage": true/false, "reason": "причина если хоть одно true, иначе null"}

repeated_question = тот же вопрос уже задавался в истории
repeated_intro = рекрутер снова пишет "Меня зовут X" или "Я — X из Y" хотя уже представлялся
template_garbage = текст явно является незаполненным шаблоном или бессмысленным набором фраз`;

  const raw = await (llmFn || module.exports.llmCall)(apiKey, [{ role: 'user', content: prompt }]);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('guard: no json in llm response');
  return JSON.parse(match[0]);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * @param {string} messageText
 * @param {Array<{role:string, text:string}>} conversationHistory
 * @param {{ username?: string, apiKey?: string, mode?: 'generate'|'send',
 *           requirementSources?: string[] }} [options]
 *   mode — 'generate' (письмо пишет модель: выдуманное требование блокирует и
 *   письмо переписывается) или 'send' (письмо набрал рекрутер: только предупреждение).
 *   requirementSources — источники правды о требованиях (критерии ATS, описание
 *   вакансии, прежние письма рекрутера). Без них проверка не выполняется.
 * @returns {Promise<{ ok: boolean, reason?: string, checks: object }>}
 */
async function bullshitGuard(messageText, conversationHistory = [], options = {}) {
  const checks = { empty: false, placeholder: false, exact_duplicate: false, invented_time: false, known_fact: false, repeated_question: false, repeated_intro: false, template_garbage: false, invented_requirement: false };

  if (!messageText || messageText.trim().length === 0) {
    checks.empty = true;
    return { ok: false, reason: 'пустое сообщение', checks };
  }

  if (hasPlaceholder(messageText)) {
    checks.placeholder = true;
    return { ok: false, reason: 'незаполненный placeholder в тексте', checks };
  }

  // Exact repeats are deterministic and must not depend on the semantic LLM
  // guard being available or noticing that an entire prior message was copied.
  // The single-message UI still offers an explicit force-send path when a recruiter
  // intentionally wants to resend it.
  const normalizeForDuplicate = value => String(value || '').toLocaleLowerCase('ru').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const normalizedMessage = normalizeForDuplicate(messageText);
  if (normalizedMessage && conversationHistory.some(m => m?.role === 'employer' && normalizeForDuplicate(m.text) === normalizedMessage)) {
    checks.exact_duplicate = true;
    return { ok: false, reason: 'это сообщение уже отправляли кандидату', checks };
  }

  // «Не переспрашивай то, что уже есть в резюме» (живой дефект 02.10.2026: письмо
  // попросило уточнить имя, хотя имя было в резюме первой строкой). Regex-гейт, идёт
  // до LLM-проверки — он бесплатный и не может пропустить отправку. Работает только
  // когда у вызывающего пути есть текст резюме (иначе сравнивать не с чем).
  if (options.resumeText) {
    const known = asksKnownFact(messageText, options.resumeText);
    if (known) {
      checks.known_fact = known.key;
      return { ok: false, reason: `переспрашиваем уже известное (${known.label}: ${known.value})`, checks };
    }
  }

  // Informational only, not blocking: a recruiter typing their own real availability
  // ("завтра в 15:00") is a legitimate message, not an AI hallucination — this check
  // can't tell the two apart, so it flags for the guard log but lets the send through.
  if (options.allowSpecificTime !== true && hasInventedTime(messageText, conversationHistory)) {
    checks.invented_time = true;
  }

  // Требования в письме должны быть взяты из данных вакансии (критерии ATS,
  // описание вакансии, прежние письма рекрутера). Модель иногда называет
  // требование, которого нигде нет (issue #198) — и кандидат отвечает «Вы о
  // чем??». Источники приходят от вызывающего пути: без них сравнивать не с чем.
  //
  // В режиме генерации ('generate') — блокирует: письмо можно переписать, и
  // существующий цикл «гвард → перегенерация с причиной» это чинит. В режиме
  // отправки ('send', по умолчанию) — только предупреждает: письмо мог написать
  // сам рекрутер, и это его требование, а не выдумка модели.
  const invented = findInventedRequirements(messageText, options.requirementSources || []);
  if (invented.length) {
    checks.invented_requirement = invented.map(x => x.sentence);
    if (options.mode === 'generate') {
      const first = invented[0];
      return {
        ok: false,
        reason: `в письме требование, которого нет в данных вакансии: «${first.sentence.replace(/\s+/g, ' ').slice(0, 120)}»`,
        checks,
      };
    }
  }

  const apiKey = options.apiKey || getApiKey(options.username);
  let llmChecked = false;
  if (conversationHistory.length > 0) {
    if (!apiKey) {
      checks.llm_skipped = 'no_api_key';
    } else {
      try {
        const r = await llmCheck(messageText, conversationHistory, apiKey, options.llmCall);
        llmChecked = true;
        checks.repeated_question = !!r.repeated_question;
        checks.repeated_intro = !!r.repeated_intro;
        checks.template_garbage = !!r.template_garbage;

        if (checks.repeated_question || checks.repeated_intro || checks.template_garbage) {
          return { ok: false, reason: r.reason || 'обнаружена проблема в сообщении', checks };
        }
      } catch (e) {
        console.warn('[bullshit-guard] llm check skipped:', e.message);
        checks.llm_skipped = `error: ${e.message}`;
      }
    }
  }

  // degraded = semantic (LLM) check never ran even though there was history to check against —
  // the message passed only on the free regex checks. Callers should log this so a run of
  // API failures doesn't silently defeat the guard.
  return { ok: true, checks, degraded: conversationHistory.length > 0 && !llmChecked };
}

// ─── Quick check (deterministic only, no LLM) ─────────────────────────────────
//
// The web send path runs bullshitGuard() before POSTing; the MCP path
// (hh_send_message, src/mcp-skills/tools/90-hh.js) did NOT — so a message that
// carried no content at all went to the candidate. Live 22.10.2026 (vacancy
// 138336566): "." (neg 5665252424, 5665911042), "отправил" (neg 5651089991) and a
// completely empty message (neg 5670741266, 5670778186) were delivered, and the
// recruiter's send log counted them as delivered.
//
// quickMessageCheck() is the deterministic part of the guard, extracted so the
// MCP path can use it without an LLM round-trip: empty text, unresolved
// placeholder, exact repeat of an earlier letter, and a message that is nothing
// but a service word. No network, no credentials — safe to call on every send.
//
// Service words are matched on the WHOLE message (after normalisation), so a
// legitimate letter that merely contains "написал" is not blocked.
//
// The list holds operational leftovers — the words a model writes when it thinks
// it has already done something ("написал", "отправил") or when it is checking
// the channel ("ок", "тест"). Greetings and answers ("Здравствуйте", "да", "нет")
// are NOT here: a recruiter may deliberately send them, and the tool contract in
// fixtures/tools.json expects hh_send_message("Здравствуйте!") to succeed.
const SERVICE_WORD_MESSAGES = new Set([
  'написал', 'написано', 'написали', 'отправил', 'отправлено', 'отправили',
  'ок', 'окей', 'ok', 'тест', 'test', 'проверка',
]);

function normalizeMessage(value) {
  return String(value || '')
    .toLocaleLowerCase('ru')
    .replace(/\u00a0/g, ' ')
    .replace(/[.,!?;:"'`«»()\[\]…—–-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Deterministic gate for an outgoing message. Returns the same shape as
 * bullshitGuard() so callers can treat both the same way.
 * @param {string} messageText
 * @param {Array<{role:string, text:string}>} [conversationHistory]
 * @returns {{ ok: boolean, reason?: string, checks: object }}
 */
function quickMessageCheck(messageText, conversationHistory = []) {
  const checks = { empty: false, placeholder: false, exact_duplicate: false, service_word: false };
  const raw = String(messageText || '');
  if (!raw.trim()) {
    checks.empty = true;
    return { ok: false, reason: 'пустое сообщение', checks };
  }
  if (hasPlaceholder(raw)) {
    checks.placeholder = true;
    return { ok: false, reason: 'незаполненный placeholder в тексте', checks };
  }
  const normalized = normalizeMessage(raw);
  // A message made of punctuation only (".", "…", "—") normalises to nothing: there
  // is no letter in it, so there is nothing for the candidate to read. Live 22.10.2026:
  // "." was delivered to neg 5665252424 and 5665911042.
  if (!/[a-zа-яё]/i.test(normalized)) {
    checks.service_word = true;
    return { ok: false, reason: 'в сообщении нет ни одного слова — кандидату нечего прочитать', checks };
  }
  if (normalized && SERVICE_WORD_MESSAGES.has(normalized)) {
    checks.service_word = true;
    return { ok: false, reason: 'сообщение состоит только из служебного слова — кандидату нечего прочитать', checks };
  }
  if (normalized && (conversationHistory || []).some(m => m?.role === 'employer' && normalizeMessage(m.text) === normalized)) {
    checks.exact_duplicate = true;
    return { ok: false, reason: 'это сообщение уже отправляли кандидату', checks };
  }
  return { ok: true, checks };
}

module.exports = { bullshitGuard, quickMessageCheck, hasPlaceholder, hasInventedTime, getApiKey, llmCall, SERVICE_WORD_MESSAGES };
