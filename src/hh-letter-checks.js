'use strict';

// Детерминированные проверки письма кандидату: правдивость требований.
//
// Письмо пишет модель (src/hh-message-prompts.js → src/conversation-generation.js),
// и модель может назвать требование, которого нет ни в описании вакансии, ни в
// списке обязательных требований ATS-конфига. Кандидат читает «обязателен диплом по
// химии» и отвечает «я химик» — а вакансия требовала другого; или просто теряет
// интерес к вакансии, которую не узнаёт (живой случай 22.10.2026, вакансия
// 138336566: кандидат #5646572699 на длинное письмо с требованиями, которых он не
// проверял, ответил «Простите, Вы о чем?? Зачем пишете столько много?????»).
//
// Проверка бесплатная и воспроизводимая — строки и regex, без LLM: гвард
// (src/hh-bullshit-guard.js) зовёт её до того, как письмо уйдёт кандидату, и
// существующий цикл «гвард → перегенерация с причиной → предупреждение рекрутеру»
// (src/hh-routes.js) чинит текст автоматически.
//
// Что считается требованием: предложение с маркером («обязательно», «требуется»,
// «нужно», «должен», …) И с предметом требования (опыт, образование, диплом,
// знания, навыки, стаж, квалификация, …). «Обязательно ответьте, если удобно
// созвониться» — не требование о кандидате, поэтому предмет обязателен: без него
// проверка ругалась бы на обычные просьбы.

// Маркер требования: предложение с таким словом утверждает, что нужно от кандидата.
const REQUIREMENT_MARKER = /(обязательн\w*|треб\w*|необходим\w*|должен\w*|нужн\w*|приветствуется|не менее|не меньше|от\s*\d)/i;

// Предмет требования — про кандидата, а не про процесс переписки.
const REQUIREMENT_SUBJECT = /(опыт|образован|диплом|стаж|знани|навык|умени|квалификаци|высш|профил|специалист|инженер|технолог|химик|разработчик|научн|сертификат|норматив|допуск|разряд|лицензи|аккредитац)/i;

// Слова маркера — они не содержат предмета требования и в сравнении не участвуют.
const MARKER_WORDS = new Set([
  'обязательно', 'обязательна', 'обязательны', 'обязателен', 'обязательна',
  'требуется', 'требуются', 'требование', 'требования', 'необходимо', 'необходимы',
  'должен', 'должна', 'должно', 'должны', 'нужно', 'нужен', 'нужна', 'нужны',
  'приветствуется', 'приветствуем',
]);

// Слова, которые не говорят ничего о содержании требования.
const STOP_WORDS = new Set([
  'и', 'в', 'во', 'на', 'с', 'со', 'по', 'для', 'до', 'от', 'из', 'у', 'о', 'об',
  'обо', 'под', 'над', 'при', 'без', 'про', 'за', 'то', 'же', 'бы', 'ли', 'не',
  'нет', 'да', 'ну', 'вот', 'так', 'или', 'а', 'но', 'это', 'этот', 'эта', 'эти',
  'все', 'всё', 'весь', 'как', 'что', 'кто', 'где', 'когда', 'какой', 'какая',
  'какие', 'если', 'чтобы', 'мы', 'вы', 'он', 'она', 'они', 'я', 'мне', 'мной',
  'нам', 'вам', 'ему', 'ей', 'им', 'свой', 'своя', 'свои', 'своих', 'себя',
  'должен', 'должна', 'должно', 'должны', 'нужно', 'нужен', 'нужна', 'нужны',
  'пожалуйста', 'спасибо', 'здравствуйте', 'здрасте', 'привет', 'добрый',
  'день', 'деньги', 'добрый', 'очень', 'также', 'ещё', 'еще', 'уже', 'только',
  'там', 'тут', 'здесь', 'мне', 'вам', 'вас', 'нас', 'него', 'нее', 'них',
  'собой', 'своих', 'своим', 'своему', 'быть', 'есть', 'был', 'была', 'было',
  'который', 'которая', 'которые', 'которым', 'это', 'ваш', 'ваша', 'ваше',
  'наш', 'наша', 'наше', 'наши', 'их', 'его', 'ее', 'им', 'ими', 'ими',
]);

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9%]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Грубая, но достаточная обрезка окончания: «образование» и «образования» должны
// считаться одним и тем же словом при сравнении с источниками.
function stem(word) {
  return word.length > 4 ? word.slice(0, word.length - 2) : word;
}

function words(text) {
  return normalize(text).split(' ').filter(Boolean);
}

function contentWords(text) {
  // Числа важны: «не менее 3 лет» отличается от «не менее 10 лет», поэтому
  // одиночная цифра остаётся значимым словом.
  return words(text).filter(w => (w.length >= 3 || /\d/.test(w)) && !STOP_WORDS.has(w) && !MARKER_WORDS.has(w));
}

/** Предложения письма — по точкам/переводам строк. */
function sentences(text) {
  return String(text || '')
    .split(/(?<=[.!?…])\s+|\n+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Требования, названные в письме.
 * @returns {Array<{ sentence: string, words: string[] }>}
 */
function requirementClaims(text) {
  const claims = [];
  for (const sentence of sentences(text)) {
    if (!REQUIREMENT_MARKER.test(sentence)) continue;
    if (!REQUIREMENT_SUBJECT.test(sentence)) continue;
    const w = contentWords(sentence);
    if (!w.length) continue;
    claims.push({ sentence, words: w });
  }
  return claims;
}

/**
 * Требования, которых нет в источниках.
 *
 * @param {string} text письмо кандидату
 * @param {string[]} sources известные источники правды: критерии ATS, контекст
 *   вакансии, описание вакансии, прежние письма рекрутера в этой переписке.
 * @returns {Array<{ sentence: string, missing: string[] }>}
 */
function findInventedRequirements(text, sources = []) {
  const list = (Array.isArray(sources) ? sources : [sources]).filter(s => String(s || '').trim());
  if (!list.length) return [];                       // нет эталонов — нечего проверять
  const haystack = normalize(list.join(' \n '));
  const found = [];
  for (const claim of requirementClaims(text)) {
    const missing = claim.words.filter(w => !haystack.includes(stem(w)));
    // Половина содержания неизвестна — это не пересказ требования из источников.
    if (missing.length >= Math.ceil(claim.words.length / 2)) {
      found.push({ sentence: claim.sentence, missing });
    }
  }
  return found;
}

/**
 * Источники правды о требованиях из ATS-конфига и контекста вакансии.
 * @param {object} atsConfig конфиг вакансии (required/preferred/vacancy_context)
 * @param {string} [vacancyContext] описание вакансии, как его видит HH
 * @returns {string[]}
 */
function requirementSources({ atsConfig = null, vacancyContext = '' } = {}) {
  const names = list => (Array.isArray(list) ? list : (Array.isArray(list?.item) ? list.item : []))
    .map(c => (typeof c === 'string' ? c : (c?.name || c?.skill || c?.criterion)))
    .filter(Boolean);
  const sources = [];
  if (atsConfig) {
    sources.push(...names(atsConfig.required));
    sources.push(...names(atsConfig.preferred));
    if (atsConfig.vacancy_title) sources.push(String(atsConfig.vacancy_title));
    if (atsConfig.vacancy_context) sources.push(String(atsConfig.vacancy_context));
  }
  if (vacancyContext) sources.push(String(vacancyContext));
  return sources;
}

module.exports = {
  normalize,
  stem,
  words,
  contentWords,
  sentences,
  requirementClaims,
  findInventedRequirements,
  requirementSources,
  REQUIREMENT_MARKER,
  REQUIREMENT_SUBJECT,
  STOP_WORDS,
  MARKER_WORDS,
};
