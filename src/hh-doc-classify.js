'use strict';
// Классификация документов кандидата (#87, эпик #83): детерминированные правила.
// Деление клиента: есть история работы (даты/компании/секции) → резюме; истории
// нет, просто «о себе» → сопроводительное; переписка → сопроводительное (тип
// в манифесте храним свой); структура интервью → интервью; фото/портфолио — свои.
// LLM-фолбэк для неоднозначного — в роуте (первые ~500 символов), здесь только правила.

const TYPES = ['resume', 'cover_letter', 'correspondence', 'interview', 'portfolio', 'photo', 'other'];
const TYPE_LABELS = {
  resume: 'Резюме',
  cover_letter: 'Сопроводительное письмо',
  correspondence: 'Переписка',
  interview: 'Интервью',
  portfolio: 'Портфолио',
  photo: 'Фото',
  other: 'Другое',
};

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic']);
const AV_EXT = new Set(['.mp4', '.mov', '.m4a', '.wav', '.mkv', '.mp3', '.webm', '.avi', '.aac', '.ogg']);
const ARCHIVE_EXT = new Set(['.zip', '.rar', '.7z', '.psd']);

// «2023 – 2025», «март 2025 — настоящее время», «06/2019 — 08/2021»
const DATE_RANGE = /(?:(?:19|20)\d{2}\s*[–—-]\s*(?:(?:19|20)\d{2}|наст\.?\s*времени|present|н\.?\s*в\.?|сейчас))|(?:(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)[а-яё]*\.?\s+(?:19|20)\d{2}\s*[–—-])/gi;
const RESUME_SECTIONS = /опыт\s+работы|трудовая\s+деятельность|work\s+history|professional\s+experience|^\s*experience\b|ключевые\s+навыки|^\s*skills\b|образование|^\s*education\b|о\s+себе|^\s*about\s+me\b/im;
const INTERVIEW_HEADER = /^\s*интервью\s*[:：]/im;
const TIMESTAMPS = /^\s*\[\d{1,2}:\d{2}(?::\d{2})?\]/m;
// Реплики-диалог: ≥3 строки «Спикер: текст» (в т.ч. без таймкодов)
const SPEAKER_TURN = /(?:^|\n)\s*(?:\[?[^\]\n:]{1,40}\]?\s*[:：])\s*\S/g;
const GREETING = /здравствуйте|добрый\s+(?:день|вечер|день)|доброе\s+утро|\bhello\b|\bhi\b/i;
const THREAD_MARKERS = /(?:^|\n)\s*(?:\d{1,2}[:.]\d{2}\s+|[А-ЯЁA-Z][а-яёa-z]+,\s*\d{1,2}\s+(?:янв|фев|мар|апр|ма[йя]|июн|июл|авг|сен|окт|ноя|дек)|\[Сообщение|\d{2}[./]\d{2}[./](?:19|20)\d{2})/;

function countMatches(re, text) {
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  return (String(text).match(new RegExp(re.source, flags)) || []).length;
}

function classifyDoc({ filename = '', text = '', ext = '' } = {}) {
  const e = String(ext || '').toLowerCase() || (filename.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
  const name = String(filename).toLowerCase();
  const body = String(text || '');

  if (IMAGE_EXT.has(e)) return { type: 'photo', detected_by: 'rules', reason: 'изображение' };
  if (AV_EXT.has(e)) return { type: 'interview', detected_by: 'rules', reason: 'аудио/видеофайл' };
  if (ARCHIVE_EXT.has(e) || /портфолио|portfolio/.test(name)) {
    return { type: 'portfolio', detected_by: 'rules', reason: 'архив/портфолио' };
  }
  if (!body.trim()) return { type: 'other', detected_by: 'rules', reason: 'текст не извлечён' };

  // Интервью с явными признаками: заголовок или таймкоды — до всего остального
  if (INTERVIEW_HEADER.test(body)) return { type: 'interview', detected_by: 'rules', reason: 'заголовок «Интервью:»' };
  if (TIMESTAMPS.test(body)) return { type: 'interview', detected_by: 'rules', reason: 'таймкоды [м:сс]' };

  // Резюме проверяем ДО эвристики «диалога»: форма резюме богата строками
  // «Метка: значение» и вопросами — раньше это путалось с репликами спикеров.
  // Резюме: истории дат + секции резюме (или ≥2 диапазонов дат сами по себе)
  const ranges = countMatches(DATE_RANGE, body);
  if (RESUME_SECTIONS.test(body) && ranges >= 1) return { type: 'resume', detected_by: 'rules', reason: 'секции резюме + даты опыта' };
  if (ranges >= 2) return { type: 'resume', detected_by: 'rules', reason: 'диапазоны дат опыта' };

  // Переписка: короткие реплики с отметками времени/дат/«[Сообщение»
  if (THREAD_MARKERS.test(body) && countMatches(THREAD_MARKERS, body) >= 2) {
    return { type: 'correspondence', detected_by: 'rules', reason: 'следы ленты сообщений' };
  }

  // Диалог без дат опыта — последним (частые ложные срабатывания на формах)
  const turns = countMatches(SPEAKER_TURN, body);
  if (turns >= 3 && (countMatches(/\?/g, body) >= 2 || turns >= 5)) {
    return { type: 'interview', detected_by: 'rules', reason: 'диалоговая структура (реплики спикеров)' };
  }

  // Истории нет → «о себе» / письмо (правило клиента); переписку уже поймали выше
  if (GREETING.test(body) || body.length < 2500) {
    return { type: 'cover_letter', detected_by: 'rules', reason: 'без истории опыта — письмо/о себе' };
  }
  return { type: 'other', detected_by: 'rules', reason: 'правила не дали уверенности' };
}

// Подсказка для LLM-фолбэка: отправляем только начало, классифицируем дешёвой моделью.
function llmClassifyChunk(text) {
  return String(text || '').slice(0, 500);
}

module.exports = { TYPES, TYPE_LABELS, classifyDoc, llmClassifyChunk };
