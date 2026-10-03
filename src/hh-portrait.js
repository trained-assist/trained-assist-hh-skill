'use strict';
// Портрет кандидата — canonical-схема требований по вакансии (эпик #83).
// Портрет ≈ вакансия ≈ переписка с клиентом: один объект, разные источники.
// Хранение: contexts/hh/portrait:{vacancyId}.json (по образцу ats_config:{vacancyId}).

const fs = require('fs');
const path = require('path');
const { hhLlmJson } = require('./hh-llm');

const PORTRAIT_VERSION = 1;

// ── Схема: блоки и разрезы индикатора полноты ─────────────────────────────────
// Разрезы = секции donut-диаграммы (#85). field = dotted path, label = как в
// форме-эталоне (Портрет кандидата №1–4), чтобы правки из PDF переносились 1:1.

const SECTIONS = [
  {
    key: 'company', label: 'О компании',
    fields: [
      ['company.name', 'Полное название компании'],
      ['company.industry', 'Сфера деятельности'],
      ['company.site', 'Сайт компании'],
      ['company.founded_headcount', 'Дата основания / численность'],
      ['company.about', 'О компании / преимущества'],
      ['company.office_address', 'Адрес главного офиса'],
      ['company.notable_clients', 'Крупные клиенты'],
      ['company.contact_person', 'Контактное лицо'],
    ],
  },
  {
    key: 'format_location', label: 'Формат и локация',
    fields: [
      ['vacancy.work_format', 'Формат работы (офис / удалёнка / гибрид)'],
      ['vacancy.location', 'Город / локация'],
      ['vacancy.workplace_address', 'Адрес места работы'],
      ['vacancy.reports_to', 'Кому подчиняется'],
      ['vacancy.manages', 'Кто подчиняется / взаимодействие'],
    ],
  },
  {
    key: 'salary_conditions', label: 'Зарплата и условия',
    fields: [
      ['vacancy.salary_trial', 'Оплата на испытательном сроке'],
      ['vacancy.salary_after', 'Зарплата после испытательного срока'],
      ['vacancy.salary_total', 'Средний совокупный доход'],
      ['vacancy.probation_months', 'Испытательный срок'],
      ['vacancy.schedule', 'График работы'],
      ['vacancy.weekend_work', 'Работа в выходные'],
      ['vacancy.business_trips', 'Командировки'],
      ['vacancy.employment_type', 'Форма оформления (ТК / ГПХ / самозанятость)'],
      ['vacancy.perks', 'Соцпакет / плюшки'],
      ['vacancy.training', 'Обучение'],
      ['vacancy.career_growth', 'Карьерный рост'],
    ],
  },
  {
    key: 'experience_education', label: 'Опыт и образование',
    fields: [
      ['requirements.age', 'Возраст'],
      ['requirements.gender', 'Пол'],
      ['requirements.marital_status', 'Семейное положение'],
      ['requirements.education', 'Основное образование'],
      ['requirements.experience', 'Опыт работы'],
    ],
  },
  {
    key: 'responsibilities', label: 'Обязанности и результаты',
    fields: [
      ['vacancy.title', 'Название вакансии'],
      ['vacancy.reason', 'Причина появления вакансии'],
      ['vacancy.responsibilities', 'Функциональные обязанности'],
      ['vacancy.programs', 'Программы / инструменты компании'],
      ['vacancy.expected_results', 'Ожидаемые результаты'],
    ],
  },
  {
    key: 'tags', label: 'Теги вакансии',
    fields: [['vacancy.tags', 'Тематические теги']],
  },
  {
    key: 'hard_skills', label: 'Hard skills',
    fields: [['requirements.hard_skills', 'Ключевые навыки / знания']],
  },
  {
    key: 'soft_skills', label: 'Soft skills',
    fields: [
      ['requirements.soft_skills', 'Личные качества'],
      ['requirements.additional_info', 'Дополнительная информация'],
    ],
  },
  {
    key: 'stop_process', label: 'Стоп-факторы и отбор',
    fields: [
      ['requirements.stop_factors', 'Нежелательный опыт / стоп-факторы'],
      ['requirements.photo_required', 'Обязательность фото в резюме'],
      ['requirements.selection_stages', 'Этапы отбора'],
    ],
  },
];

const BLOCK_FIELDS = {
  company: ['name', 'industry', 'site', 'founded_headcount', 'about', 'office_address', 'notable_clients', 'contact_person'],
  vacancy: ['title', 'headcount', 'tags', 'work_format', 'location', 'reason', 'workplace_address', 'reports_to', 'manages',
    'responsibilities', 'programs', 'expected_results', 'training', 'career_growth', 'probation_months',
    'salary_trial', 'salary_after', 'salary_total', 'schedule', 'weekend_work', 'business_trips',
    'employment_type', 'perks'],
  requirements: ['age', 'gender', 'marital_status', 'education', 'experience', 'stop_factors', 'photo_required',
    'hard_skills', 'soft_skills', 'additional_info', 'selection_stages'],
};

const ARRAY_FIELDS = new Set([
  'company.notable_clients',
  'vacancy.tags',
  'vacancy.responsibilities', 'vacancy.programs', 'vacancy.expected_results', 'vacancy.perks',
  'requirements.stop_factors', 'requirements.hard_skills', 'requirements.soft_skills', 'requirements.selection_stages',
]);

function emptyPortrait() {
  const block = (names) => Object.fromEntries(names.map(n => [n, null]));
  return {
    meta: { version: PORTRAIT_VERSION, created_at: null, updated_at: null, sources: [], vacancy_id: null },
    company: block(BLOCK_FIELDS.company),
    vacancy: block(BLOCK_FIELDS.vacancy),
    requirements: block(BLOCK_FIELDS.requirements),
  };
}

// ── Нормализация: LLM/пользовательский ввод → строгая схема ──────────────────
// Неизвестные ключи отбрасываются (защита от мусора модели), строки чистятся,
// ожидаемые списки приводятся к массиву строк. Никакой бизнес-логики — только форма.

function trimScalar(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (Array.isArray(v)) {
    const parts = v.map(x => (x === null || x === undefined ? '' : String(x).trim())).filter(Boolean);
    return parts.length ? parts.join('; ') : null;
  }
  const s = String(v).trim();
  return s === '' || s === '-' ? null : s;
}

function toList(v) {
  if (v === null || v === undefined) return [];
  let items;
  if (Array.isArray(v)) items = v;
  else if (typeof v === 'string') items = v.split(/\n|;|•|·/);
  else return [];
  return items.map(x => (x === null || x === undefined ? '' : String(x).trim())).filter(Boolean);
}

function getField(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? null : o[k]), obj);
}

function setField(obj, dotted, value) {
  const keys = dotted.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

function normalizePortrait(raw, { sources = [], vacancy_id = null, created_at = null } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = emptyPortrait();
  for (const [block, names] of Object.entries(BLOCK_FIELDS)) {
    const from = src[block] && typeof src[block] === 'object' ? src[block] : {};
    for (const name of names) {
      const dotted = `${block}.${name}`;
      const value = from[name];
      out[block][name] = ARRAY_FIELDS.has(dotted) ? toList(value) : trimScalar(value);
    }
  }
  out.meta = {
    version: PORTRAIT_VERSION,
    created_at: created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    sources: Array.isArray(sources) ? sources.filter(s => typeof s === 'string' && s) : [],
    vacancy_id,
  };
  return out;
}

// ── Полнота ───────────────────────────────────────────────────────────────────

function isFilled(dotted, value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value === true || value === false; // явно заданный факт
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  return String(value).trim() !== '';
}

function computeCompleteness(portrait) {
  const sections = SECTIONS.map(section => {
    const missing = [];
    let filled = 0;
    for (const [dotted, label] of section.fields) {
      if (isFilled(dotted, getField(portrait, dotted))) filled += 1;
      else missing.push({ field: dotted, label });
    }
    const total = section.fields.length;
    return {
      key: section.key,
      label: section.label,
      weight: total, // дуга donut пропорциональна числу полей разреза
      filled,
      total,
      percent: total ? Math.round((filled / total) * 100) : 0,
      missing,
    };
  });
  const total = sections.reduce((s, x) => s + x.total, 0);
  const filled = sections.reduce((s, x) => s + x.filled, 0);
  return {
    sections,
    percent: total ? Math.round((filled / total) * 100) : 0,
    missing_flat: sections.flatMap(s => s.missing.map(m => `${s.label}: ${m.label}`)),
  };
}

// ── Извлечение (LLM, дешёвая модель, детерминированная нормализация поверх) ───

const PORTRAIT_SYSTEM = `Ты собираешь «ПОРТРЕТ КАНДИДАТА» — структурированную заявку по вакансии из входных материалов (текст вакансии, переписка с клиентом, выдержки из брифа).

Правила:
- Заполняй ТОЛЬКО то, что реально есть в материалах. Не додумывай и не вычисляй.
- Поля, которых нет в материалах: null для строк/чисел/флагов, [] для списков.
- Списки (tags, responsibilities, hard_skills, soft_skills, stop_factors, perks, selection_stages, programs, expected_results, notable_clients) — плоские строки, одна позиция = один элемент.
- tags («Теги вакансии»): 3–8 тематических тегов, каждый 2–4 слова, по одной теме вакансии, по которой потом можно отбирать факты. Без названия компании, без оценочных прилагательных («лучший», «сильный»), без дублей обязанностей.
- Сохраняй факты клиента дословно, где это возможно (цифры зарплат, сроки, названия).
- Отвечай ТОЛЬКО JSON без markdown и пояснений.`;

function portraitExample() {
  return JSON.stringify({
    company: {
      name: 'ООО «Пример»', industry: 'Торговля', site: 'https://example.ru',
      founded_headcount: '2019, 15 человек', about: 'Компания на рынке 6 лет…',
      office_address: 'г. Москва', notable_clients: ['Клиент А'], contact_person: 'Оксана, собственник',
    },
    vacancy: {
      title: 'Маркетолог', headcount: 1, tags: ['продвижение на маркетплейсах', 'SEO карточек', 'аналитика рекламных кампаний'], work_format: 'Удалённо', location: 'Москва',
      reason: 'Расширение', workplace_address: 'Удаленно', reports_to: 'Собственнику', manages: null,
      responsibilities: ['Ведение кабинетов Wildberries', 'SEO-оптимизация карточек'],
      programs: ['Excel', 'ИИ-инструменты'], expected_results: ['Системное продвижение нового ассортимента'],
      training: 'Возможна оплата внешнего обучения', career_growth: 'Да, до руководителя отдела',
      probation_months: 3, salary_trial: '70 000 ₽', salary_after: 'Оклад + KPI', salary_total: '100 000 ₽',
      schedule: '5/2', weekend_work: 'Быть на связи по срочным вопросам', business_trips: 'Нет',
      employment_type: 'ТК РФ', perks: ['В дальнейшем возможны бонусы'],
    },
    requirements: {
      age: 'Без четких рамок', gender: 'Ж', marital_status: 'не принципиально',
      education: 'Приветствуется обучение по маркетплейсам', experience: 'от 2 лет маркетологом / по маркетплейсам',
      stop_factors: ['Пассивная позиция', 'Отсутствие самостоятельности'], photo_required: false,
      hard_skills: ['Ведение кабинетов WB и Ozon', 'SEO карточек', 'Аналитика рекламных кампаний'],
      soft_skills: ['Самостоятельность', 'Инициативность'], additional_info: 'ISTJ, ESTJ',
      selection_stages: ['Телефонное интервью', 'Видео-интервью', 'Тестирование'],
    },
  }, null, 2);
}

async function extractPortrait(sources) {
  const labeled = sources.map((s, i) => `--- Источник ${i + 1} (${s.type || 'text'}) ---\n${s.text}`).join('\n\n');
  // Единая точка LLM (src/hh-llm.js, #82): purpose 'default' → service-лестница,
  // ключ читает лестница, вызывающий код ключей не видит.
  return hhLlmJson({
    messages: [
      { role: 'system', content: PORTRAIT_SYSTEM },
      { role: 'user', content: `Пример формата:\n${portraitExample()}\n\nПОРТРЕТ КАНДИДАТА — входные материалы:\n\n${labeled}` },
    ],
    purpose: 'default',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutMs: 30_000,
    source: 'hh-portrait',
  });
}

// ── Портрет → ATS-конфиг ──────────────────────────────────────────────────────
// Без нокаутов (#74 — нокауты убраны из продукта, остаются только в данных старых
// конфигов). required ← hard skills (вес 2), preferred ← soft skills (вес 1);
// всё, что не подтвердилось в портрете, рекрутер доберет в /hh/ats-editor.

function parseMinExperience(text) {
  if (!text) return null;
  const m = String(text).match(/(\d{1,2})\s*(?:\+|и\s*более)?\s*(?:лет|года|год)/i);
  return m ? parseInt(m[1], 10) : null;
}

function parseSalaryRub(...values) {
  let best = null;
  const consider = (digits, scale) => {
    const n = parseInt(String(digits).replace(/[\s.]/g, ''), 10) * scale;
    if (Number.isFinite(n) && (best === null || n > best)) best = n;
  };
  for (const v of values) {
    if (!v) continue;
    const s = String(v);
    let m = s.match(/(\d[\d\s.]*)\s*(?:₽|руб)/i);
    if (m) { consider(m[1], 1); continue; }
    m = s.match(/(\d+)\s*(?:т\.?\s*р\.?|тыс)/i); // «70 т.р.» → 70000
    if (m) { consider(m[1], 1000); continue; }
    m = s.match(/^(\d[\d\s.]*)$/); // чистое число
    if (m) consider(m[1], 1);
  }
  return best;
}

function buildVacancyContext(p) {
  const v = p.vacancy || {};
  const c = p.company || {};
  const parts = [];
  if (v.title) parts.push(v.title);
  const fmt = [v.work_format, v.location && `локация: ${v.location}`].filter(Boolean).join(', ');
  if (fmt) parts.push(fmt);
  const salary = v.salary_total || v.salary_after || v.salary_trial;
  if (salary) parts.push(`зарплата: ${salary}`);
  if (v.schedule) parts.push(`график: ${v.schedule}`);
  if (c.name) parts.push(`компания: ${c.name}`);
  const resp = (v.responsibilities || []).slice(0, 4);
  if (resp.length) parts.push(`обязанности: ${resp.join('; ')}`);
  const stops = (p.requirements || {}).stop_factors || [];
  if (stops.length) parts.push(`стоп-факторы: ${stops.join('; ')}`);
  return parts.join('. ').slice(0, 1200);
}

function buildAtsFromPortrait(portrait, vacancyId = null) {
  const p = portrait || emptyPortrait();
  const req = p.requirements || {};
  const v = p.vacancy || {};
  const hard = (req.hard_skills || []).length ? req.hard_skills : (v.programs || []);
  const soft = req.soft_skills || [];
  return {
    vacancy_title: v.title || null,
    vacancy_context: buildVacancyContext(p),
    required: hard.map(name => ({ name, weight: 2 })),
    preferred: soft.map(name => ({ name, weight: 1 })),
    filters: {
      min_experience_years: parseMinExperience(req.experience),
      remote_ok: v.work_format ? /удал|remote/i.test(String(v.work_format)) : undefined,
      salary_max_rub: parseSalaryRub(v.salary_after, v.salary_total),
    },
    pass_threshold: 6.5,
    review_threshold: 4.0,
    vacancy_id: vacancyId || p.meta?.vacancy_id || null,
    source: 'portrait',
  };
}

// ── Хранение ──────────────────────────────────────────────────────────────────
// Контейнер {value, updated_at} — тот же формат, что у context-store (90-hh.js),
// чтобы generic-читалки контекста видели portrait как обычный контекстный ключ.

function portraitFile(workDir, vacancyId) {
  return path.join(workDir, 'contexts', 'hh', `portrait:${vacancyId}.json`);
}

function readPortrait(workDir, vacancyId) {
  const file = portraitFile(workDir, vacancyId);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const value = data && typeof data === 'object' ? (data.value ?? data) : null;
    if (!value || typeof value !== 'object' || !value.meta) return null;
    return value;
  } catch {
    return null;
  }
}

function writePortrait(workDir, vacancyId, portrait) {
  const file = portraitFile(workDir, vacancyId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const value = normalizePortrait(portrait, {
    sources: portrait?.meta?.sources || [],
    vacancy_id: vacancyId,
    created_at: portrait?.meta?.created_at || null,
  });
  fs.writeFileSync(file, JSON.stringify({ value, updated_at: new Date().toISOString() }, null, 2));
  return value;
}

module.exports = {
  SECTIONS,
  BLOCK_FIELDS,
  ARRAY_FIELDS,
  PORTRAIT_SYSTEM,
  PORTRAIT_VERSION,
  emptyPortrait,
  normalizePortrait,
  computeCompleteness,
  extractPortrait,
  buildAtsFromPortrait,
  portraitFile,
  readPortrait,
  writePortrait,
};
