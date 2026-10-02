'use strict';

// «Не переспрашивай то, что уже есть в резюме» — детерминированно, а не строкой промпта.
//
// Живой дефект 02.10.2026: письмо кандидату попросило уточнить имя, хотя имя стоило
// в самом резюме первой строкой (и в скрининговом профиле — везде). Правило против
// этого уже есть в планировщике воронки (hh-funnel, «Не переспрашивай … включая имя»),
// но правило в промпте — пожелание, а не гейт: модель его читает и нарушает.
// Этот модуль — гейт: он ничего не знает про вакансии и кандидатов, только
// «есть ли в резюме значение поля X» и «спрашивает ли исходящее письмо про X».
//
// Поля выбраны консервативно: имя, город, зарплата, график, почта, телефон — то,
// где переспрашивание очевидно любому читателю. Опыт/навыки сюда не идут: там
// уточнение почти всегда законное (мастхев в вакансии может отсутствовать в резюме).

// ─── Извлечение известных фактов из текста резюме ────────────────────────────
// buildResumeText (src/hh-resume.js) печатает «Метка: значение» построчно;
// держимся этой формы и фолбэка на «Кандидат: …» из заголовка.

const FIELD_EXTRACTORS = [
  { key: 'name', label: 'имя', re: /^#\s*Кандидат:\s*(.+)$/m },
  { key: 'location', label: 'город', re: /^(?:Локация|Город):\s*(.+)$/mi },
  { key: 'salary', label: 'зарплата', re: /^Зарплата:\s*(.+)$/mi },
  { key: 'schedule', label: 'график', re: /^(?:График|Занятость|Формат):\s*(.+)$/mi },
  { key: 'email', label: 'почта', re: /^(?:Почта|E-?mail|Email):\s*(\S+)$/mi },
];

const PHONE_RE = /(\+?7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/;

function extractKnownFacts(resumeText = '') {
  const text = String(resumeText || '');
  const facts = [];
  for (const f of FIELD_EXTRACTORS) {
    const m = text.match(f.re);
    const value = m ? String(m[1] || '').trim() : '';
    // «Кандидат» без имени (buildResumeText так печатает резюме без ФИО) — не факт.
    if (value && value !== 'Кандидат') facts.push({ key: f.key, label: f.label, value });
  }
  const phone = text.match(PHONE_RE);
  if (phone) facts.push({ key: 'phone', label: 'телефон', value: phone[0] });
  return facts;
}

// Короткая строка для промпта: что уже известно и не подлежит переспрашиванию.
function factsLine(resumeText = '') {
  const facts = extractKnownFacts(resumeText);
  if (!facts.length) return '';
  return facts.map(f => `${f.label}: ${f.value}`).join(' · ');
}

// ─── Поиск вопроса про уже известный факт ────────────────────────────────────

const ASK_PATTERNS = {
  name: [/как\s+вас\s+зовут/i, /как\s+к\s+вам\s+обращаться/i, /ваш[а-яё]*\s+(?:полное\s+)?им[яе]/i, /уточн\w*[^?!\n]{0,40}им[яе]/i, /ваш[а-яё]*\s+фамили\w*/i],
  location: [/ваш\s+(?:город|локация|регион)/i, /в\s+каком\s+городе/i, /где\s+(?:вы\s+)?(?:сейчас\s+)?находитесь/i, /откуда\s+вы\b/i],
  salary: [/ожидан\w*[^?!\n]{0,40}(?:зарплат|оклад)/i, /зарплатн\w+\s+запрос/i, /какую\s+зарплату/i, /желаемая\s+зарплата/i, /сколько\s+хотите\s+получать/i],
  schedule: [/какой\s+(?:график|формат)/i, /график\w*[^?!\n]{0,30}устраивает/i, /готовы\s+к\s+(?:офис|гибрид)/i, /вас\s+устраивает\s+(?:офис|гибрид)/i],
  email: [/ваш[а-яё]*\s+(?:почта|мейл|e-?mail|адрес\s+электронной)/i],
  phone: [/ваш[а-яё]*\s+(?:телефон|номер|контактн\w+\s+номер)/i, /номер\s+(?:телефона|мобильного)/i],
};

// Факт переспрашивается, только если фраза похожа на вопрос или просьбу: само
// упоминание («вижу, что вы в Москве») переспрашиванием не является.
const REQUEST_HINT_RE = /\?|уточн|напишите|скажите|подскажите|назовите|пожалуйста|пришлите/i;

function sentences(text) {
  return String(text || '').split(/\n+|(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

/**
 * @param {string} messageText — исходящее письмо кандидату
 * @param {string} resumeText  — текст резюме/контекста кандидата
 * @returns {{key:string,label:string,value:string}|null} первый факт, который письмо
 *   спрашивает при том, что он уже есть в резюме; null — нарушения нет.
 */
function asksKnownFact(messageText, resumeText) {
  const facts = extractKnownFacts(resumeText);
  if (!facts.length || !messageText) return null;
  for (const sentence of sentences(messageText)) {
    if (!REQUEST_HINT_RE.test(sentence)) continue;
    for (const fact of facts) {
      const patterns = ASK_PATTERNS[fact.key];
      if (!patterns) continue;
      if (patterns.some(re => re.test(sentence))) return fact;
    }
  }
  return null;
}

module.exports = { extractKnownFacts, factsLine, asksKnownFact };
