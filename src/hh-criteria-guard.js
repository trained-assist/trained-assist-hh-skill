'use strict';

// Criteria quality guard — companion to src/hh-bullshit-guard.js, but for ATS
// criteria instead of outgoing messages.
//
// Live case 01.10.2026 (vacancy «Менеджер по продвижению на Wildberries»,
// 138004863, profile tes-recruiter): hh_extract_ats_config produced
//   required: «аналитический склад ума», «постановка ТЗ подрядчикам»
//   preferred: «понимание товара и трендов»
// and scored candidates against them. None of these can be confirmed or refuted
// from a resume or from a candidate's own answer, so the rubric was pure noise:
// the LLM gave every candidate 1–2/3 on all of them and the verdict carried no
// information. The owner read the criteria in the ATS editor and called it
// "абстрактные неизмеримые критерии … булшит бинго".
//
// A prompt-only fix is not enough: the same failure reappears every time a
// recruiter regenerates a config, for every vacancy, and nothing reports it. The
// gate has to be executable — the same shape as the message guard: free regex
// first, then one cheap LLM pass over whatever the regex did not flag.

const { hhLlm, ladderToken } = require('./hh-llm');


// ─── Regex pass (free, high precision) ───────────────────────────────────────

// JS \b and \w are ASCII-only: in a Cyrillic string \b never fires (both sides are
// non-word), so /^уме(ет|ют)\b/ silently matched nothing. Same trap as the one
// documented in src/hh-bullshit-guard.js — use explicit lookarounds instead.
const CYR_B = '(?<![а-яёА-ЯЁ])';
const CYR_A = '(?![а-яёА-ЯЁ])';
const cyrWord = (w) => `${CYR_B}${w}${CYR_A}`;

const VAGUE_PATTERNS = [
  // «склад ума» и родственные — самый частый мусор
  /склад[а-яё]*\s+ум[а-яё]*/i,
  /аналитическ[а-яё]*\s+ум/i,
  // качества личности вместо проверяемого факта
  /ответственн/i,
  /стрессоустойчив/i,
  /работа[ть]? в команде/i,
  /умение работать в/i,
  /коммуникабельн/i,
  /навык[иа]? коммуникации/i,
  /умение общаться/i,
  /коммуникативн/i,
  /инициативн/i,
  /целеустрем[её]л/i,
  /быстро\s+обучаем/i,
  /легко\s+обучаем/i,
  /обучаемост/i,
  /дисциплинированн/i,
  /внимательност/i,
  /аккуратност/i,
  /добросовестн/i,
  /работоспособност/i,
  /выносливост/i,
  /пунктуальност/i,
  /мотиваци[яи]/i,
  /лидерск[а-яё]*\s+(качеств|человек)/i,
  /профессионализм/i,
  /проактивн/i,
  /креативн/i,
  /творческ[а-яё]*\s+подход/i,
  // «умеет X вообще» — нет ни инструмента, ни цифры, ни объекта
  /^уме(ет|ют)/i,
  new RegExp('^способност[ьи]', 'i'),
  // «понимание X» — the word promises judgement, not a checkable fact. Named
  // explicitly in the owner's review of vacancy 138004863.
  new RegExp(`${CYR_B}(понимани[еяю]|разбирающ[ий][а-я]*|ориентирующ[ий][а-я]*)${CYR_A}`, 'i'),
  // процессные формулировки без проверяемого результата — «постановка ТЗ
  // подрядчикам» (owner's words: "какая-то фигня")
  new RegExp(`${CYR_B}постановк[аи]\\s+(тз|тех\\.?\\s*задач|задач)`, 'i'),
  // отрицательная форма: критерий должен называть навык, а не его отсутствие
  /^(неуме|неспособн|отсутств|нет\s+опыта|без\s+опыта)/i,
];

function findVagueByRegex(name) {
  const text = String(name || '').trim();
  if (!text) return 'пустой критерий';
  for (const re of VAGUE_PATTERNS) {
    if (re.test(text)) return `неизмеримая формулировка: ${re.source}`;
  }
  return null;
}

// ─── LLM pass (one cheap call, only for what regex did not catch) ─────────────

// Kept as a named export because call sites and tests inject/patch it. apiKey stays in
// the signature for compatibility but is ignored — the call goes through the ladder.
function llmCall(_apiKey, messages, { maxTokens = 900, temperature = 0 } = {}) {
  return hhLlm({ messages, purpose: 'score', temperature, maxTokens, source: 'hh-criteria-guard' });
}

// "is an LLM available?" probe for callers. The ladder token is the credential now.
function getApiKey() {
  return ladderToken() ? 'llm-ladder' : null;

}

const GUARD_SYSTEM = `Ты — строгий ревьюер критериев отбора. Отвечай ТОЛЬКО JSON, без markdown и без пояснений.

Критерий ХОРОШИЙ, если по нему можно однозначно сказать «да/нет» по резюме или по ответу кандидата: назван инструмент/система/площадка, метрика, цифра, объём, срок, категория товаров, число объектов.
Критерий ПЛОХОЙ, если это качество личности, общая «умение/способность», или пересказ задачи без проверяемого признака.

Примеры.
ПЛОХОЙ: «аналитический склад ума», «ответственность», «умение работать в команде», «понимание товара и трендов», «умеет анализировать и развивать карточки товаров», «постановка ТЗ подрядчикам».
ХОРОШИЙ: «настройка внутренней рекламы WB: ставки, ДРР, поисковая выдача», «знание метрик карточки WB (CTR, ДРР, выкуп, оборачиваемость)», «SEO-оптимизация карточки товара: семантика, заголовок, rich-контент», «опыт работы с карточками одежды/обуви на WB от 2 лет», «ведение рекламного кабинета WB с бюджетом от 30 тыс ₽/мес».

Если критерий можно надёжно переформулировать в проверяемый — дай замену в этой же предметной области, без выдумывания новых требований.`;

async function findVagueByLlm(names, apiKey, llmFn) {
  const call = llmFn || llmCall;
  const raw = await call(apiKey, [
    { role: 'system', content: GUARD_SYSTEM },
    {
      role: 'user',
      content: `Критерии (JSON-массив строк):\n${JSON.stringify(names)}\n\nВерни {"items":[{"name":"<критерий как входе>","vague":true/false,"why":"<коротко>","replacement":"<измеримая формулировка или null>"}]}`,
    },
  ], { maxTokens: 900, temperature: 0 });

  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('criteria guard: no json in llm response');
  const parsed = JSON.parse(m[0]);
  return Array.isArray(parsed.items) ? parsed.items : [];
}

// ─── Public API ──────────────────────────────────────────────────────────────

function criteriaNames(config) {
  const pick = (list) => (Array.isArray(list) ? list : [])
    .map(c => (typeof c === 'string' ? c : c?.name))
    .filter(Boolean);
  return [
    ...pick(config?.required).map(n => ({ field: 'required', name: n })),
    ...pick(config?.preferred).map(n => ({ field: 'preferred', name: n })),
  ];
}

/**
 * @param {object} config — ATS config ({ required: [{name}], preferred: [{name}] } or strings)
 * @param {{ username?: string, apiKey?: string, useLlm?: boolean, llmCall?: Function }} [options]
 * @returns {Promise<{ ok: boolean, violations: Array<{field,name,reason,source,suggestion?}>, degraded: boolean }>}
 */
async function checkCriteria(config, options = {}) {
  const all = criteriaNames(config);
  const violations = [];

  const uncertain = [];
  for (const c of all) {
    const reason = findVagueByRegex(c.name);
    if (reason) violations.push({ ...c, reason, source: 'regex', suggestion: null });
    else uncertain.push(c);
  }

  const useLlm = options.useLlm !== false && uncertain.length > 0;
  if (!useLlm) {
    return { ok: violations.length === 0, violations, degraded: useLlm === false && uncertain.length > 0 };
  }

  const apiKey = options.apiKey || getApiKey(options.username);
  if (!apiKey) {
    return { ok: violations.length === 0, violations, degraded: true, llm_skipped: 'no_api_key' };
  }

  try {
    const items = await findVagueByLlm(uncertain.map(c => c.name), apiKey, options.llmCall);
    const byName = new Map();
    for (const it of items) byName.set(String(it?.name || '').trim(), it);
    for (const c of uncertain) {
      const it = byName.get(c.name.trim());
      if (it && it.vague) {
        violations.push({
          ...c,
          reason: it.why || 'неизмеримая формулировка',
          source: 'llm',
          suggestion: it.replacement || null,
        });
      }
    }
  } catch (e) {
    return { ok: violations.length === 0, violations, degraded: true, llm_skipped: `error: ${e.message}` };
  }

  return { ok: violations.length === 0, violations, degraded: false };
}

/**
 * Deterministic cleanup for the extraction path: drop the flagged criteria.
 * Used only where a human has not seen the config yet (hh_extract_ats_config's
 * draft) — never on a config a recruiter already reviewed and saved.
 */
function dropViolations(config, violations) {
  if (!violations?.length) return config;
  const bad = new Set(violations.map(v => `${v.field}:${String(v.name).trim().toLowerCase()}`));
  const remove = (list, field) => (Array.isArray(list) ? list : []).filter(c => {
    const name = typeof c === 'string' ? c : c?.name;
    if (!name) return false;
    return !bad.has(`${field}:${name.trim().toLowerCase()}`);
  });
  return {
    ...config,
    required: remove(config?.required, 'required'),
    preferred: remove(config?.preferred, 'preferred'),
  };
}

module.exports = {
  VAGUE_PATTERNS,
  findVagueByRegex,
  criteriaNames,
  checkCriteria,
  dropViolations,
  getApiKey,
  llmCall,
};
