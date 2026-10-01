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

const https = require('https');
const fs = require('fs');
const path = require('path');
const { tokensRoot } = require('./data-paths.js');
const { ladderChat, ladderToken } = require('./llm-ladder');

// Bump when the decision rules or the action set change: drafts are cached per
// candidate and a stale draft written by older logic would otherwise live forever
// (issue #71 — isDraftStale only compared the thread, not the logic version).
const FUNNEL_LOGIC_VERSION = 'funnel-v1';

const PLANNER_MODEL = 'google/gemini-2.5-flash';

// The fixed step set. `wait` is a first-class outcome on purpose: a candidate who
// has not answered needs silence, not a second letter.
const ACTIONS = {
  ask_skills:
    'Спросить про обязательные и желательные навыки, которых нет в резюме, — те, что стоят баллы в скоринге.',
  clarify_answer:
    'Ответ кандидата невнятный («да», «ок», «согласен», ответ не по теме или на один вопрос из нескольких) — уточнить, что именно он имел в виду.',
  propose_test:
    'Кандидат подтвердил навыки и условия, скор высокий — спросить, готов ли он выполнить тестовое задание.',
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

Правила:
- Если кандидат ещё ничего не получал от нас — ask_skills.
- Если мы уже задавали вопросы про навыки, а он не ответил или ответил ерундой — clarify_answer.
- Если он подтвердил навыки, скор высокий, а тестовое задание ещё не предлагалось — propose_test.
- Если он сказал, что готов выполнить тестовое, а само задание ещё не отправлялось — send_test.
- Если тестовое уже отправлено и сдано (или вакансия без тестового задания) и скор высокий — invite_call.
- Если последнее сообщение наше и кандидат не отвечает долго (больше 2 дней) — followup. Если прошло меньше — wait.
- Если скор низкий и пробелы критичные — reject.
- Никогда не выбирай действие, которое уже было выполнено ранее в этой переписке.
- Никогда не предлагай тестовое задание, если в вакансии его нет.

Формат ответа:
{"action":"<одно из действий>","reason":"<одно предложение почему>","missing_skills":["<навык, которого не хватает>"]}
Поле missing_skills заполняй только для ask_skills (что спросить), иначе пустой массив.`;

function llmCall(apiKey, messages, { maxTokens = 400, temperature = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: PLANNER_MODEL, messages, temperature, max_tokens: maxTokens });
    const req = https.request({
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (parsed.error) reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          else resolve(parsed.choices?.[0]?.message?.content);
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(20_000, () => req.destroy(new Error('funnel planner timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getApiKey(username) {
  if (username) {
    const file = path.join(tokensRoot(), String(username), 'openrouter');
    if (fs.existsSync(file)) {
      const key = fs.readFileSync(file, 'utf8').trim();
      if (key) return key;
    }
  }
  return process.env.OPENROUTER_API_KEY || null;
}

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

  if (!last) {
    return { action: 'ask_skills', reason: 'Переписка ещё не начата — первое сообщение с уточняющими вопросами.', by: 'rule' };
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

function buildPlannerMessage({ history, atsResult, atsConfig, resumeText = '' } = {}) {
  const gaps = (atsResult?.gaps || []).join(', ') || 'нет';
  const matched = (atsResult?.matched || []).join(', ') || 'нет';
  const testTask = String(atsConfig?.test_task || '').trim();
  return `Вакансия: ${atsConfig?.vacancy_title || 'не указана'}
Скор кандидата: ${atsResult?.score ?? 'н/д'}/${atsConfig?.pass_threshold ?? '?'} (порог прохода), вердикт: ${atsResult?.verdict || 'н/д'}
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
      raw = await llmFn(apiKey || getApiKey(username), messages, { maxTokens: 400, temperature: 0 });
    } else if (ladderToken()) {
      // The planner runs on the DEFAULT ladder (owner 2026-10-01: «процесс определения
      // следующего шага … на стандартной mimi go по дефолту, по дефолтной лесенке») —
      // 'service' opens with the Go free tier and reaches Go mimo. No ladder token →
      // the degraded 'wait' below, same as the old no-key path.
      const res = await ladderChat({
        messages,
        ladder: process.env.HH_PLANNER_LADDER || 'service',
        temperature: 0,
        maxTokens: 400,
        source: 'hh-funnel',
      });
      raw = res.content;
    } else {
      return { action: 'wait', reason: 'Нет ключа LLM — шаг воронки не определён, ждём ответа.', missing_skills: [], by: 'rule', degraded: true };
    }
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no json');
    const parsed = JSON.parse(m[0]);
    const action = VALID_ACTIONS.includes(parsed.action) ? parsed.action : 'wait';
    return {
      action,
      reason: String(parsed.reason || '').slice(0, 300),
      missing_skills: Array.isArray(parsed.missing_skills)
        ? parsed.missing_skills.map(s => String(s).slice(0, 120)).filter(Boolean).slice(0, 5)
        : [],
      by: 'llm',
    };
  } catch (e) {
    return { action: 'wait', reason: `Планировщик недоступен (${e.message}) — ждём ответа.`, missing_skills: [], by: 'rule', degraded: true };
  }
}

// Instruction for the WRITING step. The planner already decided; this must not
// re-decide. Each entry is written in the recruiter's voice so the writer has a
// speakable line to adapt instead of a third-person stub to echo (the #68 lesson).
const ACTION_INSTRUCTION = {
  ask_skills:
    'Задача письма: спросить про навыки, которых нет в резюме и которые стоят баллы. Список — в блоке «Нужно уточнить». '
    + 'Спроси про каждый по отдельности, живым языком, и объясни зачем спрашиваешь (одно предложение). '
    + 'Не представляйся заново, если уже представлялся.',
  clarify_answer:
    'Задача письма: ответ кандидата невнятный. Обязательные три шага: 1) коротко поблагодари за ответ; '
    + '2) спроси своими словами, что именно он имел в виду; 3) перечисли вопросы заново списком, каждый с новой строки. '
    + 'Не представляйся заново.',
  propose_test:
    'Задача письма: спросить, готов ли кандидат выполнить тестовое задание. Скажи, сколько времени оно занимает, '
    + 'и предложи удобный срок ответа. Сам текст задания НЕ приводи — он придёт следующим письмом, '
    + 'после того как кандидат согласится.',
  send_test:
    'Задача письма: подтвердить, что отправляем задание, и спросить удобный срок. Текст задания приложен ниже — '
    + 'он отправляется отдельным письмом дословно.',
  invite_call:
    'Задача письма: предложить короткий созвон. Одно-два предложения о том, что обсудим, и вопрос об удобном времени. '
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
  PLANNER_MODEL,
  ACTIONS,
  VALID_ACTIONS,
  ACTION_INSTRUCTION,
  deterministicStep,
  buildPlannerMessage,
  planNextStep,
  buildActionInstruction,
  buildTestTaskMessage,
  testTaskWasSent,
  renderThread,
  lastMessage,
  llmCall,
  getApiKey,
};
