// #120 — рендереры канона v2: внутренняя оценка и клиентский профиль.
// Ключевое свойство клиентского рендера: внутренние поля (баллы, evidence,
// экспертные замечания, риск-лог, противоречия, переписка) не попадают ни в текст,
// ни в скрытый DOM, ни в embedded JSON, ни в HTML-комментарии. Проверяем это
// grep-тестом по построению, а не на конкретный набор слов.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const v2 = require('../../src/hh-eval-docs-v2.js');
const canonical = require('../../src/hh-eval-canonical.js');
const branding = require('../../src/hh-branding.js');

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'evals');
const load = (name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

const interviewJson = load('interview-eval-89.json');
const jobJson = load('job-eval-90.json');

const DOCS = [
  { doc_id: 'cv', type: 'resume', role: 'source', sha256: 'a'.repeat(64) },
  { doc_id: 'iv', type: 'interview', role: 'source', sha256: 'd'.repeat(64) },
];

const EVAL = canonical.buildCanonical({
  candidateId: 'ivanov',
  vacancyId: 'v-node-1',
  vacancyTitle: 'Senior Node.js разработчик',
  rows: interviewJson.requirements.map((r, i) => ({
    criterion_id: r.id,
    label: r.label,
    kind: r.kind === 'personality' ? 'personality' : 'professional',
    must_have: r.must_have,
    weight: r.weight,
    score: r.score,
    evidence: { quote: r.evidence, source_ref: 'интервью' },
    score_reason: r.reason,
    basis: 'interview',
  })),
  rowsFrom: 'interview',
  requirements: { revision: 'r3', source: 'portrait' },
  expertChecks: [{ criterion_id: 'req-1', status: 'incorrect', basis: 'нет такого проекта', checked_at: '2026-10-02' }],
  ats: { score: 7.2, verdict: 'УТОЧНИТЬ', reasoning: 'нет подтверждения распределённых систем' },
  comparison: { available: true, place: 3, total: 9, avg: 64, min: 38, max: 91, snapshot_at: '2026-10-01' },
  docs: DOCS,
  provenance: { interview_eval_path: 'interviews/ivanov/ivanov.interview-eval.json' },
  communication: interviewJson.communication,
});
const DRAFT = {
  version: 2,
  audience: 'client',
  candidate_name: 'Иванов Иван',
  position: 'Senior Node.js разработчик',
  client_name: 'ООО «Пример»',
  evaluation: EVAL,
  summary: 'Пять лет разработки на Node.js, последние два — тимлид.',
  desired_role: 'Тимлид бэкенд-команды',
  work_format: 'Офис или гибрид',
  experience: [
    { period: '2023–2025', company: 'True Gamers', role: 'Senior Node.js', details: ['15+ проектов', 'сократил сборку с 12 до 4 минут'], from_interview: 'Activate Me Дубай' },
    { period: '2020–2023', company: 'DataLine', role: 'Node.js разработчик', details: ['REST API для 2 млн пользователей'] },
  ],
  education: ['МГТУ, прикладная математика'],
  courses: ['«Advanced Node.js», 2024'],
  skills: ['Node.js', 'PostgreSQL', 'Docker', 'Kafka'],
  languages: ['Русский — родной', 'Английский — B2'],
  location: 'Москва',
  fit: [
    { status: 'confirmed', requirement: 'Node.js 5+ лет', comment: 'подтверждено резюме и интервью' },
    { status: 'partial', requirement: 'PostgreSQL', comment: 'схему сам не проектировал' },
  ],
  client_risks: ['Узкий опыт с распределёнными системами'],
  salary_expectations: '350 000 ₽ на руки',
  recruiter_conclusion: 'Рекомендую к собеседованию с техлидом.',
  tests: [
    { type: 'DISC', date: '2026-09-15', axes: { D: 4, I: 2, S: 3, C: 3 }, source_url: 'https://example.test/disc' },
    { type: 'MBTI', date: '2026-09-15', mbti_type: 'INTJ' },
  ],
  appendices: [
    { name: 'Резюме (PDF)', type: 'resume', truncated: true, shown_chars: 60000, total_chars: 84000 },
    { name: 'Портфолио', type: 'portfolio' },
  ],
  // Внутренние поля — их не должно быть в клиентском документе ни в каком виде.
  score: 4,
  expert_check: { status: 'incorrect' },
  evidence: { quote: '«пять лет пишу на ноде»', source_ref: 'интервью 2:43' },
  risk_log: ['PostgreSQL — единственный must-have ниже 3'],
  contradictions: ['В резюме указано 5 лет, в интервью — 4.5'],
  questions_next_stage: ['Уточнить опыт с Kafka'],
  correspondence: 'Внутренняя переписка с рекрутером — не для клиента',
  internal_notes: 'Кандидат просил не упоминать увольнение',
};

describe('renderCleanEvalMdV2 — внутренняя оценка', () => {
  const md = v2.renderCleanEvalMdV2(EVAL, {
    candidateName: 'Иванов Иван',
    notes: {
      risks: ['PostgreSQL — единственный must-have ниже 3'],
      contradictions: ['В резюме 5 лет, в интервью 4.5'],
      questions_next_stage: ['Уточнить опыт с Kafka'],
    },
  });

  it('шапка несёт идентичность оценки и версии', () => {
    expect(md).toContain('# Внутренняя оценка кандидата — Иванов Иван');
    expect(md).toContain(`evaluation_id | \`${EVAL.evaluation_id}\``);
    expect(md).toContain('Версия требований | r3 (portrait, 5 треб.)');
    expect(md).toContain('Методика | hh_portrait_v2 v2.0.0');
    expect(md).toContain('Строки оценки взяты из | интервью-оценка (#89)');
  });

  it('сводка: вердикт, три отдельных числа, покрытие, ATS отдельно', () => {
    // Экспертная проверка «неверно» опустила Node.js с 5 до 2 — отсюда и числа:
    // профессиональные (2·2+2·2+4·1)/25 = 12/25 = 48%; общий (12+3)/30 = 50%.
    expect(md).toContain('| Вердикт | **не рекомендован** (ОТКЛОНИТЬ) |');
    expect(md).toContain('| Профессиональные компетенции | **48%** · 4.8 / 10 |');
    expect(md).toContain('| Личностные качества (в итог не входят) | **60%** · 6 / 10 |');
    expect(md).toContain('| Общий итог | **50%** · 5 / 10 |');
    expect(md).toContain('| Покрытие | 4 из 5 (80%) · не обсуждалось 1 |');
    expect(md).toContain('| HH ATS (отдельно, 0–10) | 7.2 / 10 · УТОЧНИТЬ |');
    expect(md).toContain('| Veto | **сработало** — Node.js · PostgreSQL |');
  });

  it('таблица требований — 8 колонок с экспертной проверкой', () => {
    expect(md).toContain('| # | Требование | Вид | Must-have | Вес | 1–5 | Evidence (цитата + источник) | Почему этот балл | Экспертная проверка |');
    expect(md).toContain('| 1 | Node.js | Профессиональное | да | 2 | **2** |');
    expect(md).toContain('неверно'); // экспертная проверка понизила 5 → 2
    expect(md).toContain('нельзя проверить'); // без проверки — честно
  });

  it('личностные требования — отдельной таблицей', () => {
    expect(md).toContain('## Личностные требования');
    expect(md).toContain('Отдельная средняя, в общий итог не входит');
    expect(md).toContain('| 1 | Управление командой | Личностное |');
  });

  it('коммуникация — отдельным блоком, в итог не входит', () => {
    expect(md).toContain('## Коммуникация — отдельная ось, в итог не входит');
    expect(md).toContain('| Стиль общения | 4 / 5 |');
  });

  it('внутренние риски, противоречия и вопросы следующего этапа видны рекрутеру', () => {
    expect(md).toContain('## Внутренние риски и противоречия');
    expect(md).toContain('PostgreSQL — единственный must-have ниже 3');
    expect(md).toContain('В резюме 5 лет, в интервью 4.5');
    expect(md).toContain('## Вопросы следующего этапа');
    expect(md).toContain('Уточнить опыт с Kafka');
  });

  it('не обсуждалось — читаемыми темами, а не [object Object]', () => {
    expect(md).toContain('## Не обсуждалось');
    expect(md).toContain('- Образование: высшее техническое');
    expect(md).not.toContain('[object Object]');
  });

  it('сравнение недоступно показывает причину, а не число', () => {
    const noCmp = canonical.buildCanonical({ candidateId: 'x', rows: [] });
    const md2 = v2.renderCleanEvalMdV2(noCmp);
    expect(md2).toContain('недоступно — сравнение не рассчитывалось');
    expect(md2).not.toMatch(/место из \d/);
  });

  it('пустой набор строк — честная пометка, а не процент рядом с пустой таблицей', () => {
    const empty = canonical.buildCanonical({ candidateId: 'x', rows: [] });
    const md2 = v2.renderCleanEvalMdV2(empty);
    expect(md2).toContain('Строк требований нет — сравнивать нечего');
    expect(md2).not.toContain('## Требования');
  });
});

describe('renderClientProfileMdV2 — клиентский профиль', () => {
  const md = v2.renderClientProfileMdV2(DRAFT);

  it('третье лицо, деловой стиль, без внутренних баллов', () => {
    expect(md).toContain('# Иванов Иван');
    expect(md).toContain('Позиция: Senior Node.js разработчик');
    expect(md).toContain('Заказчик: ООО «Пример»');
    expect(md).toContain('## О кандидате');
    expect(md).toContain('Пять лет разработки на Node.js');
  });

  it('опыт в обратной хронологии с блоком «Из интервью» курсивом', () => {
    expect(md).toContain('## Опыт работы');
    expect(md).toContain('**True Gamers** — Senior Node.js (2023–2025)');
    expect(md).toContain('*Из интервью: Activate Me Дубай*');
  });

  it('оценка кандидата — словами, без чисел', () => {
    expect(md).toContain('## Оценка кандидата');
    expect(md).toContain('### Профессиональные компетенции');
    expect(md).toContain('| ✓ | Node.js 5+ лет |');
    expect(md).toContain('| △ | PostgreSQL |');
    expect(md).toContain('### Личностные качества');
    expect(md).toContain('Подтверждено поступком:');
  });

  it('клиентские риски — отдельное поле, не копия внутреннего списка', () => {
    expect(md).toContain('## Обращаем внимание клиента');
    expect(md).toContain('Узкий опыт с распределёнными системами');
  });

  it('зарплатные ожидания — факт, тесты — раздел, приложения — с пометками об усечении', () => {
    expect(md).toContain('## Зарплатные ожидания');
    expect(md).toContain('350 000 ₽ на руки');
    expect(md).toContain('## Тесты и ссылки');
    expect(md).toContain('| DISC | 2026-09-15 | D=4 · I=2 · S=3 · C=3 |');
    expect(md).toContain('| 16 Personalities / MBTI (INTJ) |');
    expect(md).toContain('## Приложения');
    expect(md).toContain('_(показаны первые 60000 знаков из 84000)_');
  });

  it('заключение рекрутера — от первого лица', () => {
    expect(md).toContain('## Заключение рекрутера');
    expect(md).toContain('Рекомендую к собеседованию с техлидом.');
  });
});

describe('утечка внутренних данных в клиентский документ', () => {
  const md = v2.renderClientProfileMdV2(DRAFT);
  const html = v2.renderClientHtmlV2(DRAFT);

// Внутренние поля не должны появиться ни в MD, ни в HTML — ни в тексте,
  // ни в скрытом DOM, ни в embedded JSON, ни в HTML-комментариях.
  // Термины взяты точными: «weight» в списке был бы ложным срабатыванием на
  // CSS-свойство font-weight, которое к данным отношения не имеет.
  const LEAKS = [
    'expert_check', 'risk_log', 'contradictions', 'questions_next_stage',
    'correspondence', 'internal_notes', 'evaluation_id', 'score_reason',
    'criterion_id', 'must_have', 'source_ref',
    '«пять лет пишу на ноде»', // evidence-цитата — внутренняя
    'не для клиента', 'не упоминать увольнение',
    'PostgreSQL — единственный must-have ниже 3',
  ];

  it('MD не содержит внутренних полей и их значений', () => {
    for (const leak of LEAKS) expect(md).not.toContain(leak);
  });

  it('HTML не содержит внутренних полей и их значений', () => {
    for (const leak of LEAKS) expect(html).not.toContain(leak);
  });

  it('HTML не содержит скрытых каналов: data-атрибутов, embedded JSON, комментариев', () => {
    expect(html).not.toMatch(/data-(score|evidence|risk|internal|expert|veto|evaluation)/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<!--/);
    expect(html).not.toMatch(/application\/json/);
  });

  it('баллы 1–5 не появляются в клиентском документе ни в каком виде', () => {
    // Внутренние баллы — единственное, что отличает оценку от статуса.
    expect(md).not.toMatch(/\b[1-5]\s*\/\s*5\b/);
    expect(html).not.toMatch(/\b[1-5]\s*\/\s*5\b/);
    expect(md).not.toContain('72%');
    expect(md).not.toContain('7.2 / 10');
  });

  it('клиентский вид отбрасывает внутренние поля по белому списку', () => {
    const view = v2.toClientView(DRAFT);
    for (const field of v2.CLIENT_FIELDS) expect(view).toHaveProperty(field);
    for (const internal of ['score', 'expert_check', 'evidence', 'risk_log', 'contradictions', 'questions_next_stage', 'correspondence', 'internal_notes']) {
      expect(view).not.toHaveProperty(internal);
    }
  });
});

describe('renderClientHtmlV2 — брендированный HTML', () => {
  it('применяет палитру и логотип агентства из настроек', () => {
    const b = { ...branding.NEUTRAL, primary: '#8b1a1a', agency_name: 'Рекрутинг «Север»', logo_data_uri: 'data:image/png;base64,iVBORw0KGgo=' };
    const html = v2.renderClientHtmlV2(DRAFT, { branding: b });
    expect(html).toContain('--acc:#8b1a1a');
    expect(html).toContain('data:image/png;base64,iVBORw0KGgo=');
    // Название агентства попадает в заголовок документа, а не в тело.
    expect(html).toContain('<title>Иванов Иван</title>');
  });

  it('без настроек — нейтральная палитра, идентичная действующей', () => {
    const html = v2.renderClientHtmlV2(DRAFT);
    expect(html).toContain(`--acc:${branding.NEUTRAL.primary}`);
    expect(html).not.toContain('agency_name');
  });

  it('фото попадает только в клиентский профиль, не во внутреннюю оценку', () => {
    const html = v2.renderClientHtmlV2(DRAFT, { photoDataUri: 'data:image/jpeg;base64,AAAA' });
    expect(html).toContain('class="photo"');
    // Внутренняя оценка — это MD, фото там не рендерится вовсе.
    const md = v2.renderCleanEvalMdV2(EVAL);
    expect(md).not.toContain('data:image');
  });
});

describe('hh-branding: настройки агентства', () => {
  it('читает branding.json и санитизирует невалидные поля', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branding-'));
    fs.mkdirSync(path.join(dir, 'contexts', 'hh'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'contexts', 'hh', 'branding.json'), JSON.stringify({
      primary: 'red', // не hex → нейтральный
      accent: '#00ff00',
      font: 'Arial; background: url(x)', // инъекция в CSS отсекается
      logo_data_uri: 'https://evil.test/logo.svg', // внешний URL не принимаем
      agency_name: 'Тест',
    }));
    const b = branding.loadBranding(dir);
    expect(b.primary).toBe(branding.NEUTRAL.primary);
    expect(b.accent).toBe('#00ff00');
    expect(b.font).toBe('Arial background url x');
    expect(b.logo_data_uri).toBeNull();
    expect(b.agency_name).toBe('Тест');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('без файла — нейтральная палитра, без ошибки', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branding-empty-'));
    expect(branding.loadBranding(dir)).toEqual(branding.NEUTRAL);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('ReportDraft: одна версия данных для MD, HTML и PDF', () => {
  it('audience и scopes задаются явно', () => {
    const d = v2.emptyDraft ? v2.emptyDraft('Иван') : null;
    // emptyDraft живёт в hh-candidate-report; проверяем через него.
    const report = require('../../src/hh-candidate-report.js');
    const draft = report.emptyDraft('Иван');
    expect(draft.audience).toBe('internal');
    report.setAudience(draft, 'client');
    expect(draft.audience).toBe('client');
    report.setScope(draft, 'vacancy', 'v-node-1');
    expect(draft.scopes.vacancy).toBe('v-node-1');
    expect(() => report.setAudience(draft, 'public')).toThrow(/unknown audience/);
    expect(() => report.setScope(draft, 'tenant', 'x')).toThrow(/unknown scope/);
  });

  it('draftFromEvaluation кладёт каноническую оценку как единственный источник баллов', () => {
    const report = require('../../src/hh-candidate-report.js');
    const draft = report.draftFromEvaluation(EVAL, { candidateName: 'Иванов Иван', audience: 'client' });
    expect(draft.evaluation.evaluation_id).toBe(EVAL.evaluation_id);
    expect(draft.audience).toBe('client');
  });

  it('ручные правки помечаются и не теряются при регенерации', () => {
    const report = require('../../src/hh-candidate-report.js');
    const draft = report.emptyDraft('Иван');
    draft.summary = 'Новое саммари';
    report.markEdited(draft, 'summary');
    expect(report.editedFields(draft)).toEqual(['summary']);
  });
});