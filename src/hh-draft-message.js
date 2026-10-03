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

const { createHash } = require('crypto');
const { FUNNEL_LOGIC_VERSION, buildActionInstruction, ACTION_INSTRUCTION } = require('./hh-funnel');
const { factsLine, extractKnownFacts } = require('./hh-known-facts');

const HISTORY_WINDOW = 8;

// The candidate's name is a CONFIRMED PROFILE FACT, not a decorative header.
// It used to ride into the prompt as the implicit line `Кандидат: ${firstName}` with
// firstName defaulting to the placeholder 'Кандидат': when HH returned no first_name
// the name silently vanished, and the writer was left to decide on its own whether
// to greet by name or ask for it — live 02.10–03.10: a letter that skipped the
// greeting by name, and the mirror defect (issue #126) of re-asking a name already
// in the resume. One line `имя: …` makes the fact explicit either way.
function resolveCandidateName(firstName, resumeText = '') {
  const given = String(firstName || '').trim();
  if (given && given !== 'Кандидат') return given;
  // The prompt parameter can be missing while the resume carries the name
  // (buildResumeText prints `# Кандидат: ФИО`) — the fact wins over the placeholder.
  const fromResume = extractKnownFacts(resumeText).find(f => f.key === 'name');
  return fromResume ? fromResume.value : '';
}

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
  // Funnel step decided by src/hh-funnel.js. When present it REPLACES the legacy
  // TYPE_INSTRUCTION: deciding and writing are separate steps, and the writer must
  // not re-derive the state from prose.
  action = null,
  missingSkills = [],
  testTask = '',
  vacancyInstruction = '',
} = {}) {
  const name = resolveCandidateName(firstName, resumeText) || resolveCandidateName(firstName, candidateContext);
  const parts = [];
  if (name) {
    parts.push(`имя: ${name}`);
    parts.push('');
    parts.push('Имя кандидата известно — письмо обращается по имени в приветствии и не спрашивает имя у кандидата.');
  } else {
    parts.push('имя: неизвестно');
    parts.push('');
    parts.push('Имя кандидата неизвестно — не выдумывай его и не обращайся по имени: нейтральное приветствие. '
      + 'Имя не переспрашивай, если оно есть в блоке «Факты из резюме» — там оно уже известно.');
  }
  parts.push('');
  const intro = messageType === 'initial';
  if (intro) parts.push(`Резюме:\n${resumeText || '(резюме недоступно — напиши общее приглашение)'}\n\n`);
  else {
    // For everything but the first letter the resume used to be dropped entirely, so
    // the writer could not know the candidate's name, city or salary expectations and
    // asked for them — «уточните, пожалуйста, имя» (02.10.2026). A compact facts line
    // costs a few tokens and closes that hole without re-sending the whole resume.
    const facts = factsLine(resumeText) || factsLine(candidateContext);
    if (facts) parts.push(`Факты из резюме (уже известны):\n${facts}\n\n`);
  }
  if (candidateContext) parts.push(`Контекст:\n${candidateContext}\n\n`);
  const atsLine = buildAtsLine(atsResult);
  if (atsLine) parts.push(atsLine);
  parts.push(`История переписки:\n${renderHistory(history) || '(переписки ещё не было — это первое сообщение)'}`);
  const instruction = action
    ? buildActionInstruction(action, { missingSkills, testTask })
    : (TYPE_INSTRUCTION[messageType] || TYPE_INSTRUCTION.reply);
  if (instruction) parts.push(`\n\n${instruction}`);
  // The per-recruiter style (hh-message-style) and base prompt (hh-message-base-prompt)
  // are system-level prose that can hardcode questions — live: «ОБЯЗАТЕЛЬНО спрашивай
  // в первом сообщении все три вопроса». The funnel already decided what this letter is
  // for; without this line the writer let that mandate re-add questions to a
  // propose_test letter to a candidate who already matches (owner's rule 02.10.2026:
  // we ask only about missing must-haves, otherwise — the next process step).
  if (action && action !== 'wait') {
    parts.push('\n\nДействие воронки («' + action + '») приоритетно над наборами правил стиля и сценария: '
      + 'вопросы кандидату задаются только действиями ask_skills/clarify_answer и только по списку выше. '
      + 'Если стиль или сценарий требуют спросить что-то ещё в этом письме — не спрашивай.');
  }
  // The per-vacancy process instructions (ATS editor, epic #112), resolved per-vacancy
  // by the caller (resolveMessageInstructions). Same priority rule as the style layers:
  // the funnel action above decides, this text only shapes the recruiter's voice.
  if (vacancyInstruction) {
    parts.push('\n\nИнструкция для этой вакансии:\n' + vacancyInstruction);
  }
  // The writer-side twin of the guard in src/hh-bullshit-guard.js (checks.known_fact):
  // письмо не должно спрашивать ответы, которые уже лежат в резюме.
  if (factsLine(resumeText) || factsLine(candidateContext)) {
    parts.push('\n\nНе переспрашивай у кандидата то, что уже названо в резюме или в блоке «Факты из резюме» — '
      + 'имя, город, зарплата, график, контакты. Это данные для письма, а не вопросы кандидату.');
  }
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
// The version prefix is the fix for issue #71: the signature used to describe the
// THREAD only, so a draft written by a broken prompt stayed cached forever — the
// thread had not changed, therefore nothing looked stale. Now a change to the
// funnel logic invalidates every draft it produced, on the next background pass.
// The instruction hash (epic #112) does the same for a recruiter editing the
// per-vacancy message instructions: drafts written under the old wording would
// otherwise stay cached until the candidate wrote something new.
// The must-haves of the vacancy are the third input that shapes a letter: the writer
// is told to ask only about them and (since #122) is handed their list in the system
// prompt. A draft written before the recruiter filled them in — or before a criterion
// was renamed — was composed against a different question set, so it must be treated as
// stale. Only NAMES are hashed: a weight change moves the ATS score, not the wording of
// the letter, and must not churn every cached draft.
// readAtsConfig() returns null when the vacancy has no criteria file at all — a real
// state (issue #126), not a coding mistake. The default parameter only covers
// `undefined`, so `null` reached `atsConfig.required` and threw AFTER the letter was
// written, losing it. Normalise here, at the single entry point, so every caller
// (routes, scoring, staleness) is safe without repeating the guard.
function criteriaSignature(atsConfig = {}) {
  if (atsConfig == null) atsConfig = {};
  const names = list => (Array.isArray(list) ? list : [])
    .map(c => String((c && (c.name ?? c)) || '').trim()).filter(Boolean);
  const req = names(atsConfig.required);
  const pref = names(atsConfig.preferred);
  if (!req.length && !pref.length) return '';
  return createHash('sha256').update(JSON.stringify({ required: req, preferred: pref })).digest('hex').slice(0, 16);
}

function historySignature(history = [], vacancyInstruction = '', atsConfig = {}) {
  const msgs = (history || []).filter(m => m && String(m.text || '').trim());
  const base = msgs.length
    ? `${FUNNEL_LOGIC_VERSION}:${msgs.length}:${msgs[msgs.length - 1].hh_id || msgs[msgs.length - 1].timestamp || ''}`
    : `${FUNNEL_LOGIC_VERSION}:empty`;
  const text = String(vacancyInstruction || '').trim();
  // Keep both optional segments byte-identical to their pre-#122 shape when they are
  // absent, so a vacancy with no criteria / no instructions is not invalidated by a
  // re-deploy.
  let sig = text ? `${base}:i${createHash('sha256').update(text).digest('hex').slice(0, 16)}` : base;
  const crit = criteriaSignature(atsConfig);
  if (crit) sig += `:c${crit}`;
  return sig;
}

// Actions that legitimately produce NO letter. Without the skip signature the
// background loop would re-plan (and pay for a planner call) every cycle for every
// silent candidate — 'no draft' is a decision, not missing work.
const NO_LETTER_ACTIONS = ['wait', 'reject'];

function isDraftStale(history = {}, vacancyInstruction = '', atsConfig = {}) {
  const ats = history?.ats_result || {};
  const sig = historySignature(history.messages || [], vacancyInstruction, atsConfig);
  if (NO_LETTER_ACTIONS.includes(ats.funnel_action)) {
    return ats.draft_skip_sig !== sig;
  }
  if (!ats.draft_message) return true;
  if (!ats.draft_history_sig) return true;
  return ats.draft_history_sig !== sig;
}

// draftMeta() used to live here and was never called by any call site — draft_history_sig is
// written directly instead. Dead code, removed in #68 so nobody hunts for a use for it.

module.exports = {
  HISTORY_WINDOW,
  TYPE_INSTRUCTION,
  ACTION_INSTRUCTION,
  NO_LETTER_ACTIONS,
  FUNNEL_LOGIC_VERSION,
  detectMessageType,
  buildDraftUserMessage,
  buildAtsLine,
  renderHistory,
  historySignature,
  criteriaSignature,
  isDraftStale,
};
