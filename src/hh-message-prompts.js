'use strict';

const path = require('path');
// Credential store (trained-assist-agent#1939) via hh-utils' safe reader: the
// per-recruiter override file lives under agent-tokens, so the migration
// encrypts it — legacy plaintext transparent, v2 envelope decrypted, a base64
// stub never returned, missing CRED_ENCRYPTION_KEY → default prompt with a warning.
const { readCredentialFileSafe } = require('./hh-utils');

// Single source of truth for the candidate-message system prompt.
//
// This used to be copy-pasted independently in src/server.js (/hh/generate-message,
// the real path the /hh/review page hits), src/hh-scoring.js (background auto-draft
// job after hh_batch_evaluate), and src/mcp-skills/tools/90-hh.js (chat-triggered
// hh_regenerate_messages / hh_draft_review_page). Editing one copy silently did not
// affect the others. Edit the prompt HERE — all three call sites render from it.
//
// The base instructions below are also editable per-recruiter without a code deploy,
// via the /hh/style page: a non-empty `agent-tokens/<user>/hh-message-base-prompt`
// file overrides MESSAGE_SYSTEM_BASE entirely. Call loadBaseOverride() at each call
// site (same pattern already used for the hh-message-style file) and pass the result
// as `baseOverride`.

const BASE_PROMPT_FILENAME = 'hh-message-base-prompt';
const INSTRUCTIONS_TEMPLATE_FILENAME = 'hh-message-instructions-template';

function loadBaseOverride(tokensBase, username) {
  try {
    const file = path.join(tokensBase, String(username), BASE_PROMPT_FILENAME);
    const text = readCredentialFileSafe(file)?.trim();
    if (text) return text;
  } catch { /* ignore */ }
  return null;
}

// Per-vacancy process instructions (epic #112). The OWNER's default — what a newly
// created vacancy's instruction is seeded from before the recruiter edits it. The
// funnel (src/hh-funnel.js) implements the same process deterministically in code;
// this free text is the recruiter's editable copy, never above the funnel action.
const DEFAULT_MESSAGE_INSTRUCTIONS =
  'Если в резюме нет деталей по обязательным требованиям — уточни именно их, по одному вопросу в строке.\n' +
  'Когда все обязательные требования закрыты — спроси, готов ли кандидат выполнить тестовое задание.\n' +
  'Если готов — отправь задание текстом письма. После сдачи — предложи созвон.\n' +
  'Не выдумывай детали, которых нет в резюме и в переписке.';

// The recruiter's editable global template (agent-tokens/<user>/hh-message-instructions-template,
// editable on /hh/style). Copied into each vacancy's ATS config at first save; the
// vacancy's own copy then lives independently. Set → wins, else the default.
function loadInstructionsTemplate(tokensBase, username) {
  try {
    const file = path.join(tokensBase, String(username), INSTRUCTIONS_TEMPLATE_FILENAME);
    const text = readCredentialFileSafe(file)?.trim();
    if (text) return text;
  } catch { /* ignore */ }
  return null;
}

// Resolution rule (#112): the vacancy's own field wins; an empty field falls back to
// the recruiter's global template, then to the default. Never another vacancy's text.
function resolveMessageInstructions({ username, tokensBase, atsConfig = {} } = {}) {
  const own = String(atsConfig?.message_instructions || '').trim();
  if (own) return own;
  return loadInstructionsTemplate(tokensBase, username) || DEFAULT_MESSAGE_INSTRUCTIONS;
}

const MESSAGE_SYSTEM_BASE = 'Ты — рекрутер. ВСЕГДА пиши сообщение, даже если данных мало.\n' +
  'Пишешь сообщение кандидату на HeadHunter. Это может быть первое сообщение или ответ внутри уже идущей переписки — на входе всегда полная история диалога и результат ATS-оценки кандидата (скор, вердикт).\n\n' +
  'КАК ЧИТАТЬ ЭТИ ИНСТРУКЦИИ. Все инструкции ниже описывают СМЫСЛ, а не готовые фразы для копирования. Никогда не переноси в текст письма служебные обороты и описания кандидата («он», «кандидат», «наши вопросы») — ты пишешь письмо от первого лица, рекрутер, а не инструктор. Пример-фраза в кавычках дана чтобы показать тон, а не чтобы быть вставленной дословно. Перед отправкой перечитай письмо: в нём не должно быть ни одной фразы, которую нельзя произнести вслух кандидату как есть. Нарушение этого правила даёт кандидату служебную внятность вместо нормального письма (#68).\n\n' +
  'Если это первое сообщение (истории переписки ещё нет): 1) Приветствие с именем 2) 1-2 предложения что в резюме зацепило 3) короткое описание роли 4) конкретный вопрос для квалификации (самый важный пробел из требований вакансии) 5) призыв к действию.\n\n' +
  'Если кандидат уже отвечал в переписке: прочитай его ответы и учти скор/вердикт. Если скор хороший/проходной и ответы кандидата по делу, или скор высокий сразу — аккуратно, ничего не обещая, предложи следующий шаг: сейчас планируем процесс собеседований, предложи созвониться. Если скор низкий или в ответах остались пробелы — задай уточняющий вопрос по самому важному пробелу.\n\n' +
  'ОБЯЗАТЕЛЬНОЕ ПРАВИЛО для продолжения переписки: никогда не начинай сообщение заново — не представляйся, если уже представлялся, и не переспрашивай то, что уже спросил и на что есть ответ.\n\n' +
  'Если ответ кандидата НЕ ответил на наши вопросы или неоднозначен (например «да», «ок», «хорошо», «согласен», «давайте», ответ не по теме, ответ на один вопрос вместо трёх) — обязательно, все три шага: 1) коротко поблагодари за ответ, 2) спроси у кандидата, что именно он имел в виду, своими словами и как живой человек (например: «Ваше «да» — это про все вопросы сразу или про какой-то один?»), 3) перечисли вопросы заново списком. Пропуск любого из шагов ломает переписку: кандидат не понимает, что на него ответил.\n\n' +
  'Если кандидат ещё не ответил на наше последнее сообщение: напиши короткий вежливый follow-up без давления, упомяни, что ты уже писал ранее.\n\n' +
  'Если это отказ: напиши вежливый отказ — уважительно, тепло, без объяснения причин, пожелай удачи в поиске.\n\n' +
  'Про время звонка — ВАЖНО: если ниже в контексте дан блок "Доступность для звонка" с реальными данными — используй только их (предложи слот из указанной доступности или дай ссылку на запись). Если такого блока нет — НЕ придумывай время и дату (никаких «утро», «завтра днём», «в среду в 15:00»); вместо этого спроси у кандидата, когда ему удобно созвониться. Если предлагаешь конкретный слот — всегда называй дату И время («в четверг в 15:00»): дата без времени не считается предложением, кандидат не знает, во сколько звонить. Если в блоке доступности нет слотов с временем — не называй дату вовсе, спроси удобное время.\n\n' +
  'Форматирование: каждый вопрос — отдельная строка (через \\n). Между смысловыми блоками — пустая строка. Не пиши всё в один абзац.\n' +
  'Длина: 4-7 предложений (follow-up и отказ — 2-3). Не используй шаблонные фразы. Пиши от первого лица на русском языке.\n' +
  'НЕЛЬЗЯ: обещать перезвонить или позвонить — только переписка в HH. Не используй слова «перезвоню», «позвоню», «свяжусь по телефону», «созвонимся». Не обещай трудоустройство или конкретные условия — только предлагай следующий шаг процесса.\n' +
  'НЕЛЬЗЯ оставлять плейсхолдеры в квадратных или фигурных скобках (например «[Ваше имя]», «{company}») — если имя рекрутера не задано явно в контексте, просто не называй себя по имени, представься только по компании/роли ("Я — рекрутер компании X").';

const REJECTION_SYSTEM_BASE = 'Ты — рекрутер. Напиши вежливый отказ кандидату.\n' +
  'Тон: уважительный, тёплый, без объяснения причин. Пожелай удачи в поиске. 2-3 предложения. Пиши на русском языке.';

// interview_config lives inside ats_config.json (set via the ATS editor). Only treat
// it as real, usable availability if invite_call_enabled is on AND there's actual
// availability text or a booking link — otherwise the model has nothing concrete to
// offer and must ask the candidate instead of inventing a time (see #606).
function hasRealAvailability(interviewConfig) {
  const ic = interviewConfig || {};
  return !!(ic.invite_call_enabled && (ic.availability?.trim() || ic.booking_url?.trim()));
}

function buildAvailabilityBlock(interviewConfig) {
  if (!hasRealAvailability(interviewConfig)) return '';
  const ic = interviewConfig;
  const notes = [];
  if (ic.level) notes.push(`Уровень позиции: ${ic.level}.`);
  if (ic.requirements) notes.push(`Требования к звонку: ${ic.requirements}.`);
  if (ic.availability) notes.push(`Доступность рекрутера: ${ic.availability}.`);
  if (ic.booking_url) notes.push(`Ссылка для самостоятельной записи: ${ic.booking_url}.`);
  return `\n\nДоступность для звонка:\n${notes.join('\n')}`;
}

// message_config.json (set via the recruiter-identity page): agency/name/signature/rules.
function buildRecruiterIdentity(msgCfg) {
  if (!msgCfg) return '';
  return [
    msgCfg.represent_as || (msgCfg.agency ? `Ты пишешь от лица агентства ${msgCfg.agency}.` : ''),
    msgCfg.recruiter_name ? `Твоё имя: ${msgCfg.recruiter_name}.` : '',
    msgCfg.signature ? `Подпись в конце каждого сообщения: «${msgCfg.signature}».` : '',
    ...(msgCfg.rules || []).map(r => `ПРАВИЛО: ${r}`),
  ].filter(Boolean).join('\n');
}

// Criteria names, same shape the planner uses (criteriaNames in hh-funnel.js): plain
// array, legacy {item:[…]}, or portrait-style objects with name/skill/criterion.
function criteriaNamesForPrompt(list) {
  const arr = Array.isArray(list) ? list : (Array.isArray(list?.item) ? list.item : []);
  return arr
    .map(c => (typeof c === 'string' ? c : (c?.name || c?.skill || c?.criterion)))
    .filter(Boolean);
}

// The writer must know the must-haves. Until 02.10.2026 this block was never appended:
// the only vacancy text handed to the writer came from the raw HH /vacancies/{id}
// description (vacancyContext), which the recruiter's ATS editor does not write to, so
// the writer was told "ask only about must-haves" without ever being told what they
// ARE. Live on vacancy 138004863: 4 required criteria sat in the config, zero reached
// the model. The planner already had them (buildPlannerMessage) — this is the same
// source, now on the writer side too. Always present, even when the list is empty:
// an empty list is a fact ("no must-haves recorded"), a missing block is a hole.
function buildCriteriaBlock(atsConfig = {}) {
  const required = criteriaNamesForPrompt(atsConfig?.required);
  const preferred = criteriaNamesForPrompt(atsConfig?.preferred);
  const lines = [];
  lines.push('Обязательные требования (мастхевы) этой вакансии — уточнять можно ТОЛЬКО их:');
  lines.push(required.length ? required.map(r => `- ${r}`).join('\n') : '- (не указано)');
  if (preferred.length) {
    lines.push('Желательные навыки (не уточнять, пока обязательные не подтверждены):');
    lines.push(preferred.map(p => `- ${p}`).join('\n'));
  }
  return '\n\n## Обязательные требования вакансии\n' + lines.join('\n');
}

function buildMessageSystemPrompt({ vacancyContext = '', recruiterCtx = '', commStyle = '', baseOverride = '', vacancyInstruction = '', atsConfig = {} } = {}) {
  let prompt = (baseOverride || MESSAGE_SYSTEM_BASE) + (vacancyContext ? '\n\n## Контекст вакансии\n' + vacancyContext : '');
  // Always present — see buildCriteriaBlock. Independent of vacancyContext: the raw HH
  // description and the recruiter's measurable criteria are different fields.
  prompt += buildCriteriaBlock(atsConfig);
  if (recruiterCtx) prompt += `\n\n## Идентичность рекрутера\n${recruiterCtx}`;
  if (commStyle) prompt += `\n\n## Стиль общения рекрутера\n${commStyle}`;
  if (vacancyInstruction) {
    prompt += `\n\n## Инструкция для этой вакансии\n${vacancyInstruction}\n` +
      'Приоритет над этим текстом: действие воронки и список обязательных требований — уточняй только то, чего нет в данных кандидата.';
  }
  return prompt;
}

function buildRejectionSystemPrompt({ recruiterCtx = '', commStyle = '' } = {}) {
  let prompt = REJECTION_SYSTEM_BASE;
  if (recruiterCtx) prompt += `\n\n## Идентичность рекрутера\n${recruiterCtx}`;
  if (commStyle) prompt += `\n\n## Стиль рекрутера\n${commStyle}`;
  return prompt;
}

module.exports = {
  hasRealAvailability,
  buildAvailabilityBlock,
  buildRecruiterIdentity,
  buildMessageSystemPrompt,
  buildRejectionSystemPrompt,
  buildCriteriaBlock,
  criteriaNamesForPrompt,
  loadBaseOverride,
  loadInstructionsTemplate,
  resolveMessageInstructions,
  BASE_PROMPT_FILENAME,
  INSTRUCTIONS_TEMPLATE_FILENAME,
  DEFAULT_MESSAGE_BASE: MESSAGE_SYSTEM_BASE,
  DEFAULT_MESSAGE_INSTRUCTIONS,
};
