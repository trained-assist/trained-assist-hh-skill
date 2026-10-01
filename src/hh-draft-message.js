'use strict';

// Single source of truth for building a candidate message out of the live dialogue.
//
// The prompt text already lived in one place (hh-message-prompts.js). The DECISION of
// what kind of message to write, and the guard that backs it, did not: three call sites
// each had their own rule, and the background auto-draft had none at all — it always
// asked the model for "Напиши первое сообщение кандидату" and never passed the thread,
// so it re-introduced the recruiter to candidates who had already been introduced.
// Live case 30.09 (vacancy 137012564, negotiation 5610867713): we asked Леван Бахтадзе
// three qualification questions at 11:49, he replied "здравствуйте, да" at 12:03, and
// the auto-draft produced at 12:15 opened with "Добрый день, Леван! Меня зовут
// Владимир, я рекрутер…" as if we had never written. The draft was then cached in
// ats_result and never refreshed.
//
// The prompt builders below are pure (no fs, no network, no credentials) so the three
// paths (background auto-draft, review-page button, hh_regenerate_messages) cannot
// drift again and stay testable without stubs.

const fs = require('fs');
const path = require('path');
const { usersRoot } = require('./data-paths');
const { hasRealAvailability } = require('./hh-message-prompts');

const HISTORY_WINDOW = 8;

// One axis: where the conversation stands. The ATS verdict is NOT part of it — verdict
// decides what we offer (a call / a question about the gap), the thread decides how we
// open. Keeping them apart is what stopped "ПРОПУСТИТЬ + vague reply" from silently
// skipping the acknowledgement branch.
function detectMessageType({ history = [], forceType = null } = {}) {
  if (forceType === 'rejection') return 'rejection';
  if (forceType === 'invite_call') return 'invite_call';
  // `history` is an array by contract — every 90-hh.js call site passes `history.messages`.
  // One background call site passed the whole record `{ messages: thread }` instead, and
  // `(history || []).filter` then threw "(history || []).filter is not a function" on every
  // cycle, silently killing ALL background auto-drafts on prod (negotiation 5610867713,
  // 01.10.2026). That call site is fixed in hh-scoring.js; this guard keeps the next shape
  // drift from taking the whole drafting loop down — a wrong shape degrades to 'initial'.
  const list = Array.isArray(history) ? history : (history?.messages || []);
  const msgs = list.filter(m => m && String(m.text || '').trim());
  if (!msgs.length) return 'initial';
  const last = msgs[msgs.length - 1];
  // We spoke last and got nothing back → nudge. Never re-introduce, never re-ask.
  if (last.role === 'employer') return 'followup';
  // The candidate spoke last → this is an answer to something we wrote.
  return 'reply';
}

const TYPE_INSTRUCTION = {
  initial:
    'Это первое сообщение — переписки ещё не было. Структура: 1) приветствие с именем ' +
    '2) 1-2 предложения о том, что зацепило в резюме 3) кратко о роли 4) ОДИН самый важный ' +
    'вопрос для квалификации 5) призыв к действию.',
  followup:
    'Кандидат НЕ ответил на наше последнее сообщение. Короткий вежливый follow-up без давления, ' +
    '2-3 предложения. НЕ представляйся заново — мы уже представились. Не переспрашивай то, что уже спрашивали.',
  // Step 2 used to be phrased as a description OF THE CANDIDATE — «спроси, к какому из
  // вопросов он относится» — and the model copied that description straight into the letter
  // instead of turning it into recruiter speech: "К какому из моих вопросов вы относитесь?"
  // (prod, negotiation 5610867713, issue #68). Describing the INTENT and showing the phrasing
  // in the recruiter's own voice is what fixes it: the model has a speakable line to adapt
  // rather than a third-person stub to echo. Same wording in hh-message-prompts.js.
  reply:
    'Кандидат только что ответил — это ПРОДОЛЖЕНИЕ переписки, а не новое письмо.\n' +
    'НЕ представляйся заново (мы уже представились в первом сообщении) и не начинай с нуля.\n' +
    'НЕ повторяй вопросы, на которые в истории уже есть ответ.\n' +
    'Сначала пойми, сообщает ли последняя реплика кандидата что-то конкретное по нашим вопросам.\n' +
    'Если конкретики нет («да», «ок», «хорошо», «согласен», «давайте», не по теме или ответ только ' +
    'на один вопрос из трёх), выполни три шага:\n' +
    '1) коротко поблагодари за ответ;\n' +
    '2) спроси у кандидата, что именно он имел в виду, своими словами и как живой человек — ' +
    'например: «Ваше «да» — это про все вопросы сразу или про какой-то один?»;\n' +
    '3) перечисли вопросы заново списком — каждый с новой строки.\n' +
    'Обязательно все три шага.',
  invite_call:
    'Кандидат ответил, и мы его зовём. Предложи короткий созвон следующим шагом. ' +
    'НЕ представляйся заново. Одно-два предложения о том, что обсудим, и вопрос об удобном времени.',
  rejection:
    'Напиши вежливый отказ: уважительно, тепло, без объяснения причин, пожелай удачи в поиске.',
};

function renderHistory(history = []) {
  return history
    .filter(m => m && String(m.text || '').trim())
    .slice(-HISTORY_WINDOW)
    .map(m => {
      const who = m.role === 'employer' ? 'Рекрутер' : 'Кандидат';
      return `${who}: ${String(m.text).slice(0, 500)}`;
    })
    .join('\n');
}

function buildAtsLine(atsResult) {
  if (!atsResult || atsResult.score == null) return '';
  const gaps = (atsResult.gaps || []).slice(0, 2).join(', ') || 'нет критических пробелов';
  const matched = (atsResult.matched || []).slice(0, 3).join(', ') || 'нет';
  return `ATS-оценка: ${atsResult.score}/10, вердикт: ${atsResult.verdict || 'n/a'}. Совпадения: ${matched}. Уточнить: ${gaps}.\n\n`;
}

function buildDraftUserMessage({
  messageType = 'initial',
  firstName = 'Кандидат',
  resumeText = '',
  atsResult = null,
  history = [],
  availabilityBlock = '',
  candidateContext = '',
} = {}) {
  const parts = [`Кандидат: ${firstName}`, ''];
  const intro = messageType === 'initial';
  if (intro) parts.push(`Резюме:\n${resumeText || '(резюме недоступно — напиши общее приглашение)'}\n\n`);
  if (candidateContext) parts.push(`Контекст:\n${candidateContext}\n\n`);
  const atsLine = buildAtsLine(atsResult);
  if (atsLine) parts.push(atsLine);
  parts.push(`История переписки:\n${renderHistory(history) || '(переписки ещё не было — это первое сообщение)'}`);
  parts.push(`\n\n${TYPE_INSTRUCTION[messageType] || TYPE_INSTRUCTION.reply}`);
  if (messageType !== 'rejection') {
    parts.push('\n\nЕсли предлагаешь созвон — называй дату И время («в четверг в 15:00»). '
      + 'Дата без времени предложением не считается: кандидат не поймёт, во сколько звонить. '
      + 'Если конкретных слотов с временем нет в блоке «Доступность» — не называй дату, спроси удобное время.');
  }
  if (availabilityBlock) parts.push(availabilityBlock);
  parts.push('\n\nНапиши следующее сообщение кандидату.');
  return parts.join('\n');
}

// The draft lives in ats_result and is reused as-is by /hh/review. Without a signature
// of the thread it was written against, a candidate answering afterwards kept seeing a
// draft composed for a conversation that had not happened yet.
function historySignature(history = []) {
  const msgs = (history || []).filter(m => m && String(m.text || '').trim());
  const last = msgs[msgs.length - 1];
  if (!last) return 'empty';
  return `${msgs.length}:${last.hh_id || last.timestamp || ''}`;
}

function isDraftStale(history = {}) {
  const ats = history?.ats_result || {};
  if (!ats.draft_message) return true;
  if (!ats.draft_history_sig) return true;
  return ats.draft_history_sig !== historySignature(history.messages || []);
}

// draftMeta() used to live here and was never called by any call site — draft_history_sig is
// written directly instead. Dead code, removed in #68 so nobody hunts for a use for it.

// Whether the recruiter configured real call slots (ATS editor → interview_config).
// Only then may a message name a specific time; the send guard uses it to stop
// flagging a real slot as a hallucination (#606).
function interviewConfigAllowsTime(username) {
  try {
    const file = path.join(usersRoot(), String(username), 'contexts', 'hh', 'ats_config.json');
    if (!fs.existsSync(file)) return false;
    let config = JSON.parse(fs.readFileSync(file, 'utf8')).value || {};
    if (typeof config === 'string') config = JSON.parse(config);
    return hasRealAvailability(config.interview_config);
  } catch {
    return false;
  }
}

module.exports = {
  HISTORY_WINDOW,
  TYPE_INSTRUCTION,
  detectMessageType,
  buildDraftUserMessage,
  buildAtsLine,
  renderHistory,
  historySignature,
  isDraftStale,
  interviewConfigAllowsTime,
};
