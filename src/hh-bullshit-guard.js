'use strict';

// Checks outgoing HH messages for 5 classes of errors before sending.
// Regex checks run first (free). The semantic LLM check is one cheap call covering the
// rest — through the single ladder entry point (src/hh-llm.js, purpose 'score' →
// free-ladder). This module no longer resolves or reads any API key.

const { hhLlm, ladderToken } = require('./hh-llm');
const { asksKnownFact } = require('./hh-known-facts');

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
 * @param {{ username?: string, apiKey?: string }} [options]
 * @returns {Promise<{ ok: boolean, reason?: string, checks: object }>}
 */
async function bullshitGuard(messageText, conversationHistory = [], options = {}) {
  const checks = { empty: false, placeholder: false, exact_duplicate: false, invented_time: false, known_fact: false, repeated_question: false, repeated_intro: false, template_garbage: false };

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

module.exports = { bullshitGuard, hasPlaceholder, hasInventedTime, getApiKey, llmCall };
