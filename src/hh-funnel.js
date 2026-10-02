'use strict';

// Recruitment funnel state machine — the "what do we do next" half of candidate
// messaging, deliberately separated from the "how do we write it" half.
//
// Until 01.10.2026 there was no state machine at all: src/hh-draft-message.js had
// detectMessageType() (initial / followup / reply / invite_call / rejection) and one
// large prompt that asked the model to both decide what to do and write the letter.
// The owner asked for the opposite shape: "генерация следующего шага задачи … и
// следующего шага — написания сообщения — это 2 разных момента. Надо их делать
// отдельно", with a fixed set of steps and a JSON action.
//
// Why the split matters more than the extra LLM call: the decision is a small,
// auditable JSON that can be checked against deterministic rules and shown to the
// recruiter ("next action: ask about missing skills"). The writing stays a separate,
// freely-formulated step that cannot quietly re-decide the funnel. One prompt doing
// both is how "Меня зовут Владимир, мы вам уже писали" (#68) and the second intro
// (#66, #70) happened — the model re-derived the state from prose every time.
//
// OWNER'S PROCESS, verbatim (01.10.2026, WB vacancy):
//   спросить про обязательные и желательные навыки, которых нет в резюме
//   → после подтверждения обновить скоринг
//   → если скоринг высокий, предложить тестовое задание
//   → после отправки тестового предложить созвон
// The steps below are that process, expressed as a closed set.

const { hhLlm, ladderToken } = require('./hh-llm');


// Bump when the decision rules or the action set change: drafts are cached per
// candidate and a stale draft written by older logic would otherwise live forever
// (issue #71 — isDraftStale only compared the thread, not the logic version).
// funnel-v2 (02.10.2026): the owner reviewed a letter sent to a 9.5/ПРОПУСТИТЬ
// candidate (vacancy 138004863, negotiation 5620089198) that asked three
// clarification questions "просто так" — «у кандидата всё есть, а мы его
// гоняем». The rule changed: we ask ONLY about must-haves missing from the
// candidate's data, and a passing verdict means no questions at all — the next
// step of the process (propose_test → send_test → invite_call).
const FUNNEL_LOGIC_VERSION = 'funnel-v2';

// The fixed step set. `wait` is a first-class outcome on purpose: a candidate who
// has not answered needs silence, not a second letter.
const ACTIONS = {
  ask_skills:
    'Спросить про ОБЯЗАТЕЛЬНЫЕ требования (мастхевы), которых нет в резюме и ответах кандидата. Желательные навыки и «стоит уточнить» — не уточняем.',
  clarify_answer:
    'Ответ кандидата невнятный («да», «ок», «согласен», ответ не по теме или на один вопрос из нескольких) — уточнить, что именно он имел в виду.',
  propose_test:
    'Кандидат проходит отбор (мастхевы закрыты) — предложить следующий шаг процесса: короткое тестовое задание, спросить, готов ли его выполнить.',
  send_test:
    'Кандидат согласился на тестовое задание — отправить его текст.',
  invite_call:
    'Тестовое задание отправлено и сдано (или вакансия без тестового) — предложить созвон.',
  confirm_conditions:
    'Условия вакансии (зарплата, формат, график) не подтверждены кандидатом — коротко уточнить, подходит ли.',
  followup:
    'Мы писали, кандидат не ответил — короткое напоминание без давления.',
  reject:
    'Кандидат не подходит — вежливый отказ.',
  wait:
    'Ничего не делать: ждём ответа кандидата.',
};

const VALID_ACTIONS = Object.keys(ACTIONS);

const PLANNER_SYSTEM = `Ты — планировщик шага переписки с кандидатом. Ты НЕ пишешь письмо — ты решаешь только, какое действие должно произойти сейчас. Отвечай ТОЛЬКО JSON, без markdown.

Действия (выбери ровно одно):
${VALID_ACTIONS.map(a => `- ${a}: ${ACTIONS[a]}`).join('\n')}

Правила (правило «что уточняем»):
- Уточнять можно ТОЛЬКО обязательные требования (мастхевы) из блока «Обязательные требования», которых НЕТ в резюме и в ответах кандидата. Желательные, «стоит уточнить» и прочие детали — не повод задавать вопрос.
- Не переспрашивай то, что видно в резюме/профиле HH или уже подтверждено в переписке (включая имя, опыт и цифры).
- Если вердикт «ПРОПУСТИТЬ» — вопросов НЕТ вообще: обязательные закрыты, идём дальше по процессу: сначала propose_test (тестовое есть и ещё не предлагалось), после согласия — send_test, затем invite_call. Не «уточним ещё пару деталей».
- Если кандидат ещё ничего не получал от нас: при вердикте «ПРОПУСТИТЬ» — propose_test (или invite_call, если тестового нет); иначе — ask_skills строго по нехваткам обязательных.
- Если мы уже задавали вопросы про навыки, а он не ответил или ответил ерундой — clarify_answer.
- Если он подтвердил навыки/условия и готов — propose_test.
- Если он сказал, что готов выполнить тестовое, а само задание ещё не отправлялось — send_test.
- Если тестовое уже отправлено и сдано (или вакансия без тестового задания) и вердикт «ПРОПУСТИТЬ» — invite_call.
- Если последнее сообщение наше и кандидат не отвечает долго (больше 2 дней) — followup. Если прошло меньше — wait.
- Если вердикт «ОТКЛОНИТЬ» и пробелы критичные — reject.
- Никогда не выбирай действие, которое уже было выполнено ранее в этой переписке.
- Никогда не предлагай тестовое задание, если в вакансии его нет.

Формат ответа:
{"action":"<одно из действий>","reason":"<одно предложение почему>","missing_skills":["<навык, которого не хватает>"]}
Поле missing_skills заполняй только для ask_skills — и ТОЛЬКО из обязательных требований, иначе пустой массив.`;


const DAY_MS = 86400000;

function lastMessage(messages) {
  const list = (messages || []).filter(m => m && String(m.text || '').trim());
  return list.length ? list[list.length - 1] : null;
}

function hasEmployerMessage(messages) {
  return (messages || []).some(m => m && m.role === 'employer' && String(m.text || '').trim());
}

function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]+/gi, ' ').replace(/\s+/g, ' ').trim();
}

// The recruiter's own promise to send the assignment. Live check 01.10.2026 on
// vacancy 138004863: the thread ended with «Супер, пришлю задание» and the funnel
// answered `wait` — because we spoke last and the candidate was silent. That is the
// one case where waiting is exactly wrong: the next letter IS the test task, and
// the candidate is waiting for it. Two days of silence later it becomes a followup
// instead, and the assignment is never sent.
const PROMISED_TASK_RE = /(пришл|отправлю|высылаю|скину|перешл)[^.!?\n]{0,40}(задани|тестов)/i;

function promisedTestTask(messages) {
  const last = lastMessage(messages);
  if (!last || last.role !== 'employer') return false;
  return PROMISED_TASK_RE.test(String(last.text || ''));
}

// The test task is sent verbatim from the config, so "was it sent?" has to be
// answered by looking for the actual text in the thread — a flag can be lost, the
// letter cannot.
function testTaskWasSent(messages, testTask) {
  const probe = normalizeText(testTask).slice(0, 60);
  if (!probe) return false;
  return (messages || [])
    .filter(m => m && m.role === 'employer')
    .some(m => normalizeText(m.text).includes(probe));
}

/**
 * Deterministic gate. Runs BEFORE the planner LLM and can only make the funnel
 * safer, never looser: a rejected candidate gets no letter, a candidate we already
 * wrote to does not get a second intro, a test task is not offered twice, and a
 * fresh unanswered message means silence.
 *
 * @returns {{ action: string, reason: string, missing_skills?: string[], by: 'rule' } | null}
 */
function deterministicStep({ history = [], atsResult = null, atsConfig = {}, now = Date.now() } = {}) {
  const verdict = atsResult?.verdict;
  if (verdict === 'ОТКЛОНИТЬ' && atsResult?.score != null && atsResult.score < (atsConfig.review_threshold ?? 4)) {
    return { action: 'reject', reason: 'Скор ниже порога отсева — письмо с отказом, не приглашение.', by: 'rule' };
  }

  const testTask = String(atsConfig.test_task || '').trim();
  // Promised but not sent: the letter that is due is the assignment itself, so
  // this must be decided BEFORE the "we spoke last → wait" branch below.
  if (testTask && !testTaskWasSent(history, testTask) && promisedTestTask(history)) {
    return { action: 'send_test', reason: 'Рекрутер обещал прислать задание, а оно ещё не отправлено — отправляем.', by: 'rule' };
  }
  if (testTask && testTaskWasSent(history, testTask)) {
    const answered = (history || []).some(m => m && m.role === 'applicant'
      && new Date(m.timestamp || 0).getTime() > new Date((history.filter(h => h.role === 'employer').pop() || {}).timestamp || 0).getTime());
    if (answered && (atsResult?.score ?? 0) >= (atsConfig.pass_threshold ?? 6.5)) {
      return { action: 'invite_call', reason: 'Тестовое задание отправлено и сдано, скор высокий — предложить созвон.', by: 'rule' };
    }
  }

  const last = lastMessage(history);
  if (last?.role === 'employer') {
    const waited = now - new Date(last.timestamp || now).getTime();
    if (waited < 2 * DAY_MS) {
      return { action: 'wait', reason: 'Мы отправили сообщение меньше двух дней назад, кандидат не ответил — ждём.', by: 'rule' };
    }
    return { action: 'followup', reason: 'Кандидат не ответил больше двух дней — короткое напоминание.', by: 'rule' };
  }

  // First contact: we have never written to this candidate (empty thread, or only
  // their response to the vacancy). Whether there is anything to ask is decided by
  // the ATS verdict, not by habit — the owner's rule (02.10.2026, WB vacancy):
  // «спрашиваем просто так — у кандидата всё есть, а мы его гоняем».
  // A passing candidate gets the next step of the process with no questions;
  // an unpassed one gets questions, and the planner asks only about must-haves.
  if (!hasEmployerMessage(history)) {
    if (atsResult?.verdict === 'ПРОПУСТИТЬ') {
      if (testTask && !testTaskWasSent(history, testTask)) {
        return { action: 'propose_test', reason: 'Кандидат проходит отбор, мы ещё не писали и тестовое не предлагалось — предлагаем следующий шаг процесса.', by: 'rule' };
      }
      // Pass without a test task (or one already sent in a thread we never wrote
      // in): invite_call vs conditions is the planner's call, not a guess here.
      return null;
    }
    if (atsResult?.score == null) {
      return { action: 'ask_skills', reason: 'Мы ещё не писали и кандидат не оценён — первое письмо с вопросами по обязательным требованиям.', by: 'rule' };
    }
    return null; // scored but did not pass → the planner asks about missing must-haves
  }

  return null;
}

function renderThread(history = [], limit = 8) {
  const list = (history || []).filter(m => m && String(m.text || '').trim()).slice(-limit);
  return list.map(m => {
    const who = m.role === 'employer' ? 'Рекрутер' : 'Кандидат';
    return `${who}: ${String(m.text).slice(0, 400)}`;
  }).join('\n') || '(переписки ещё не было)';
}

// required/preferred come in several shapes across configs (plain array, legacy
// required_skills, portrait {item:[…]}) — the planner only needs the names.
function criteriaNames(list) {
  const arr = Array.isArray(list) ? list : (Array.isArray(list?.item) ? list.item : []);
  return arr
    .map(c => (typeof c === 'string' ? c : (c?.name || c?.skill || c?.criterion)))
    .filter(Boolean);
}

function buildPlannerMessage({ history, atsResult, atsConfig, resumeText = '' } = {}) {
  const gaps = (atsResult?.gaps || []).join(', ') || 'нет';
  const matched = (atsResult?.matched || []).join(', ') || 'нет';
  const testTask = String(atsConfig?.test_task || '').trim();
  // Same resolution the scorer uses (pass_threshold || thresholds.strong), not 6.5:
  // showing the model a wrong pass line is how a passing candidate reads as failing.
  const passLine = Number(atsConfig?.pass_threshold ?? atsConfig?.thresholds?.strong ?? 6.5);
  const required = criteriaNames(atsConfig?.required);
  const preferred = criteriaNames(atsConfig?.preferred);
  return `Вакансия: ${atsConfig?.vacancy_title || 'не указана'}
Скор кандидата: ${atsResult?.score ?? 'н/д'} из 10. Порог прохода: ${passLine}. Вердикт скоринга: ${atsResult?.verdict || 'н/д'}.
Вердикт «ПРОПУСТИТЬ» означает, что кандидат ПРОХОДИТ отбор — вопросов к нему не задавай, иди дальше по процессу. Не предлагай отказ, если вердикт не «ОТКЛОНИТЬ».
Обязательные требования (мастхевы — уточнять можно только их): ${required.join(', ') || 'нет'}
Желательные (не уточнять, пока обязательные не подтверждены): ${preferred.join(', ') || 'нет'}
Совпадения: ${matched}
Пробелы: ${gaps}
Тестовое задание в вакансии: ${testTask ? 'есть' : 'НЕТ — не предлагать его'}

${resumeText ? `Резюме (кратко):\n${String(resumeText).slice(0, 1500)}\n\n` : ''}Переписка:
${renderThread(history)}

Какое одно действие сделать сейчас?`;
}

/**
 * Decide the next step. Deterministic rules first, cheap LLM only for the cases
 * rules cannot judge (which skill to ask about, whether an answer was specific).
 *
 * @returns {Promise<{ action: string, reason: string, missing_skills: string[], by: 'rule'|'llm', degraded?: boolean }>}
 */
async function planNextStep({ history = [], atsResult = null, atsConfig = {}, resumeText = '', username, apiKey, now = Date.now(), llmFn } = {}) {
  const rule = deterministicStep({ history, atsResult, atsConfig, now });
  if (rule) return { ...rule, missing_skills: [] };

  const messages = [
    { role: 'system', content: PLANNER_SYSTEM },
    { role: 'user', content: buildPlannerMessage({ history, atsResult, atsConfig, resumeText }) },
  ];

  try {
    let raw;
    if (llmFn) {
      raw = await llmFn(apiKey, messages, { maxTokens: 400, temperature: 0 });
    } else if (ladderToken()) {
      // The planner runs on the DEFAULT ladder (owner 2026-10-01: «процесс определения
      // следующего шага … на стандартной mimi go по дефолту, по дефолтной лесенке») —
      // 'service' opens with the Go free tier and reaches Go mimo. No ladder token →
      // the degraded 'wait' below, same as the old no-key path.
      raw = await hhLlm({
        messages,
        purpose: 'default',
        ladder: process.env.HH_PLANNER_LADDER,
        temperature: 0,
        maxTokens: 400,
        source: 'hh-funnel',
      });
    } else {
      return { action: 'wait', reason: 'Нет ключа LLM — шаг воронки не определён, ждём ответа.', missing_skills: [], by: 'rule', degraded: true };
    }
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no json');
    const parsed = JSON.parse(m[0]);
    const action = VALID_ACTIONS.includes(parsed.action) ? parsed.action : 'wait';
    const reason = String(parsed.reason || '').slice(0, 300);
    const missing_skills = Array.isArray(parsed.missing_skills)
      ? parsed.missing_skills.map(s => String(s).slice(0, 120)).filter(Boolean).slice(0, 5)
      : [];
    return guardPlannerAction({ action, reason, missing_skills }, { history, atsResult, atsConfig });
  } catch (e) {
    return { action: 'wait', reason: `Планировщик недоступен (${e.message}) — ждём ответа.`, missing_skills: [], by: 'rule', degraded: true };
  }
}

/**
 * Post-gate on the planner's decision. `deterministicStep` above can only stop the
 * funnel early; nothing checked what the model came back with.
 *
 * Live finding 01.10.2026 (vacancy 138004863, production key): the planner answered
 * `reject` for a candidate scored 8.5 against a 7.5 pass threshold, verdict
 * ПРОПУСТИТЬ — twice out of three runs on the same thread. `reject` is the one step
 * that leaves the system for good ("вежливый отказ"), so a prompt line is not a
 * gate: the threshold the owner set must decide it, not the model's reading of it.
 * The same class applies to `send_test`, which sends a real assignment.
 *
 * Direction is deliberate: this can only make the funnel safer. Every override moves
 * an outward action (reject / send_test) to an inward one (the answer is still owed,
 * the recruiter decides), never the other way round.
 */
function guardPlannerAction(plan, { history = [], atsResult = null, atsConfig = {} } = {}) {
  const score = atsResult?.score;
  const review = atsConfig.review_threshold ?? 4;
  const decidedToReject = plan.action === 'reject';

  // A refusal is allowed only on the ATS verdict the recruiter's thresholds produced.
  // Unknown score (not scored yet) is treated as "do not refuse" — silence costs a
  // day, a wrong refusal costs the candidate.
  const mayReject = atsResult?.verdict === 'ОТКЛОНИТЬ' && score != null && score < review;
  if (decidedToReject && !mayReject) {
    const why = score == null
      ? `кандидат ещё не отскорен (балла нет)`
      : `скор ${score} при пороге отклонения ${review}`;
    return {
      action: 'wait',
      reason: `Планировщик предложил отказ, но ${why} — ждём вместо отказа.`,
      missing_skills: [],
      by: 'rule',
      guarded: 'reject',
    };
  }

  // «Что уточняем» (owner's rule, 02.10.2026): a candidate with verdict
  // ПРОПУСТИТЬ already clears the must-haves — new questions are the defect the
  // owner reported («спрашиваем просто так»). deterministicStep covers first
  // contact; this catches the model choosing ask_skills anyway.
  if (plan.action === 'ask_skills' && atsResult?.verdict === 'ПРОПУСТИТЬ') {
    const testTask = String(atsConfig.test_task || '').trim();
    const next = testTask && !testTaskWasSent(history, testTask) ? 'propose_test' : 'invite_call';
    return {
      ...plan,
      action: next,
      reason: `Планировщик предложил уточнения при вердикте ПРОПУСТИТЬ (${plan.reason}) — вместо вопросов предлагаем следующий шаг процесса.`,
      missing_skills: [],
      by: 'rule',
      guarded: 'ask_skills',
    };
  }

  // The assignment may only go out when the config actually carries it: an empty
  // test_task would send a letter about an assignment that does not exist.
  if (plan.action === 'send_test' && !String(atsConfig.test_task || '').trim()) {
    return {
      action: 'wait',
      reason: 'Планировщик предложил отправить задание, а в вакансии его нет — ждём.',
      missing_skills: [],
      by: 'rule',
      guarded: 'send_test',
    };
  }

  return { ...plan, by: 'llm' };
}

// Instruction for the WRITING step. The planner already decided; this must not
// re-decide. Each entry is written in the recruiter's voice so the writer has a
// speakable line to adapt instead of a third-person stub to echo (the #68 lesson).
const ACTION_INSTRUCTION = {
  ask_skills:
    'Задача письма: спросить про навыки, которых нет в резюме и которые стоят баллы. Список — в блоке «Нужно уточнить». '
    + 'Спрашивай ТОЛЬКО по этому списку — это нехватки обязательных требований. Ничего сверх: не имя, не «когда удобно», '
    + 'не желательные навыки и не условия — это следующие шаги процесса. '
    + 'Спроси про каждый пункт по отдельности, живым языком, и объясни зачем спрашиваешь (одно предложение). '
    + 'Не представляйся заново, если уже представлялся.',
  clarify_answer:
    'Задача письма: ответ кандидата невнятный. Обязательные три шага: 1) коротко поблагодари за ответ; '
    + '2) спроси своими словами, что именно он имел в виду; 3) перечисли вопросы заново списком, каждый с новой строки. '
    + 'Не представляйся заново.',
  propose_test:
    'Задача письма: сначала один вывод — мы изучили профиль кандидата, обязательные требования закрыты, он проходит дальше. '
    + 'Затем спросить, готов ли кандидат выполнить тестовое задание. Скажи, сколько времени оно занимает, '
    + 'и предложи удобный срок ответа. Больше НИЧЕГО не спрашивай — ни имени, ни времени созвона, ни условий, '
    + 'ни дополнительных уточнений: ровно один шаг — готовность к тестовому. '
    + 'Сам текст задания НЕ приводи — он придёт следующим письмом, после того как кандидат согласится.',
  send_test:
    'Задача письма: подтвердить, что отправляем задание, и спросить удобный срок. Текст задания приложен ниже — '
    + 'он отправляется отдельным письмом дословно.',
  invite_call:
    'Задача письма: предложить короткий созвон. Одно-два предложения о том, что обсудим, и вопрос об удобном времени. '
    + 'Больше ничего не спрашивай — ни навыков, ни имени, ни условий. '
    + 'Конкретное время называй только из блока «Доступность» — и всегда с датой И временем; нет слотов — спроси, когда удобно. '
    + 'Не представляйся заново.',
  confirm_conditions:
    'Задача письма: коротко подтвердить условия (зарплата, формат работы, график — из контекста вакансии) и спросить, '
    + 'подходят ли они кандидату. Без давления.',
  followup:
    'Задача письма: короткое вежливое напоминание без давления, 2-3 предложения. Мы уже писали — напомни об этом. '
    + 'Не представляйся заново и не переспрашивай то, что уже спрашивали.',
  reject:
    'Задача письма: вежливый отказ. Уважительно, тепло, без объяснения причин, пожелай удачи в поиске.',
  wait: '',
};

function buildActionInstruction(action, { missingSkills = [], testTask = '' } = {}) {
  // 'wait' has an intentionally EMPTY instruction: no letter is due. Using `||`
  // here would have silently rendered the follow-up text for a step whose whole
  // point is to write nothing — the exact bug the owner reported as "ничего не
  // делать, может быть".
  if (action === 'wait') return '';
  const base = ACTION_INSTRUCTION[action] || ACTION_INSTRUCTION.followup;
  const parts = [base];
  if (action === 'ask_skills' && missingSkills.length) {
    parts.push(`Нужно уточнить (это самые весомые пробелы по скорингу):\n${missingSkills.map(s => `- ${s}`).join('\n')}`);
  }
  // The writer has to know roughly what the task is to answer "сколько времени оно
  // занимает" — but it must never reproduce it: the task goes out in its own
  // letter, word-for-word. Short excerpt for propose_test, full text for send_test.
  if (testTask && (action === 'propose_test' || action === 'send_test')) {
    const body = action === 'send_test'
      ? `Текст задания, который уйдёт следующим письмом дословно (не переписывай его здесь):\n${String(testTask).slice(0, 1200)}`
      : `Суть задания (для контекста, НЕ цитируй в письме — задание придёт отдельным сообщением):\n${String(testTask).slice(0, 400)}`;
    parts.push(body);
  }
  return parts.filter(Boolean).join('\n\n');
}

/**
 * The test-task letter is assembled in code, never generated: the vacancy text
 * says the assignment must be sent word-for-word, and a model paraphrase is the
 * most likely way that promise breaks.
 */
function buildTestTaskMessage(testTask) {
  const text = String(testTask || '').trim();
  if (!text) return null;
  return text;
}

module.exports = {
  FUNNEL_LOGIC_VERSION,
  guardPlannerAction,
  ACTIONS,
  VALID_ACTIONS,
  ACTION_INSTRUCTION,
  deterministicStep,
  buildPlannerMessage,
  planNextStep,
  buildActionInstruction,
  buildTestTaskMessage,
  testTaskWasSent,
  promisedTestTask,
  renderThread,
  lastMessage,
};
