// Визуальный replay канона v2 (#120): внутренняя оценка и клиентский профиль
// рендерятся в реальном Chromium, проверяются на ноль JS-ошибок, кириллицу,
// длинный опыт, фото, пустые разделы и многостраничность. PDF проверяется
// рендером страниц тем же браузером.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const v2 = require('../../src/hh-eval-docs-v2.js');
const canonical = require('../../src/hh-eval-canonical.js');
const branding = require('../../src/hh-branding.js');

const FIXTURES = path.join(__dirname, '..', '..', 'fixtures', 'evals');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

const interviewJson = load('interview-eval-89.json');
const jobJson = load('job-eval-90.json');

const DOCS = [
  { doc_id: 'cv', type: 'resume', role: 'source', sha256: 'a'.repeat(64) },
  { doc_id: 'cl', type: 'cover_letter', role: 'source', sha256: 'b'.repeat(64) },
  { doc_id: 'pt', type: 'portfolio', role: 'source', sha256: 'c'.repeat(64) },
  { doc_id: 'iv', type: 'interview', role: 'source', sha256: 'd'.repeat(64) },
];

const EVAL = canonical.buildCanonical({
  candidateId: 'ivanov',
  vacancyId: 'v-node-1',
  vacancyTitle: 'Senior Node.js разработчик',
  rows: interviewJson.requirements.map((r) => ({
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

// Длинный опыт — чтобы документ гарантированно вышел за одну страницу.
const LONG_EXPERIENCE = [
  { period: '2023–2025', company: 'True Gamers', role: 'Senior Node.js', details: ['15+ проектов', 'сократил сборку с 12 до 4 минут', 'онбординг четырёх новичков'], from_interview: 'Activate Me Дубай' },
  { period: '2020–2023', company: 'DataLine', role: 'Node.js разработчик', details: ['REST API для 2 млн пользователей', 'перевёл монолит на сервисы'] },
  { period: '2018–2020', company: 'StartUp', role: 'Fullstack', details: ['MVP с нуля за три месяца'] },
  { period: '2016–2018', company: 'Agency', role: 'Верстальщик', details: ['лендинги, промо-сайты'] },
];

const DRAFT = {
  version: 2,
  audience: 'client',
  candidate_name: 'Иванов Иван',
  position: 'Senior Node.js разработчик',
  client_name: 'ООО «Пример»',
  evaluation: EVAL,
  summary: 'Пять лет разработки на Node.js, последние два — тимлид бэкенд-команды.',
  desired_role: 'Тимлид бэкенд-команды',
  work_format: 'Офис или гибрид',
  experience: LONG_EXPERIENCE,
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
  score: 4,
  expert_check: { status: 'incorrect' },
  evidence: { quote: '«пять лет пишу на ноде»', source_ref: 'интервью 2:43' },
  risk_log: ['PostgreSQL — единственный must-have ниже 3'],
  contradictions: ['В резюме 5 лет, в интервью 4.5'],
  questions_next_stage: ['Уточнить опыт с Kafka'],
  correspondence: 'Внутренняя переписка — не для клиента',
  internal_notes: 'Кандидат просил не упоминать увольнение',
};

function watch(page) {
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  return {
    assertClean() {
      expect(pageErrors, 'page errors (инлайн-скрипты страниц)').toEqual([]);
      expect(consoleErrors, 'console errors').toEqual([]);
    },
  };
}

test.describe('канон v2: визуальный replay в Chromium', () => {
  test('внутренняя оценка: MD → HTML без ошибок, кириллица и все разделы на месте', async ({ page }) => {
    const md = v2.renderCleanEvalMdV2(EVAL, {
      candidateName: 'Иванов Иван',
      notes: {
        risks: ['PostgreSQL — единный must-have ниже 3'],
        contradictions: ['В резюме 5 лет, в интервью 4.5'],
        questions_next_stage: ['Уточнить опыт с Kafka'],
      },
    });
    const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>
      body{font:14px/1.5 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;max-width:820px;margin:0 auto;padding:24px}
      table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align::top}
      th{background:#f0f0f0}h1{font-size:22px}h2{font-size:16px;border-bottom:1px solid #bbb;padding-bottom:3px}
    </style></head><body>${require('../../src/hh-candidate-eval-docs.js').mdToHtml(md)}</body></html>`;
    const w = watch(page);
    await page.setContent(html, { waitUntil: 'load' });
    w.assertClean();

    await expect(page.locator('h1')).toHaveText('Внутренняя оценка кандидата — Иванов Иван');
    await expect(page.locator('h2')).toContainText([
      'Сводка', 'Профессиональные требования', 'Личностные требования',
      'Коммуникация', 'Внутренние риски и противоречия', 'Вопросы следующего этапа',
      'Не обсуждалось', 'Ограничения',
    ]);
    // Кириллица не превратилась в кракозябры.
    await expect(page.locator('body')).toContainText('Управление командой');
    await expect(page.locator('body')).toContainText('Образование: высшее техническое');
    // Экспертная проверка — колонкой в таблице.
    await expect(page.locator('th', { hasText: 'Экспертная проверка' })).toHaveCount(2);
    await expect(page.locator('td', { hasText: 'неверно' })).toHaveCount(1);
    // Нет утечки внутренних данных в отрендеренном HTML.
    const text = await page.locator('body').innerText();
    for (const leak of ['expert_check', 'risk_log', 'contradictions', 'questions_next_stage', 'criterion_id', 'source_ref', '«пять лет пишу на ноде»']) {
      expect(text, `утечка «${leak}» во внутренней оценке`).not.toContain(leak);
    }
  });

  test('клиентский профиль: третье лицо, фото, длинный опыт, несколько страниц', async ({ page }) => {
    const b = { ...branding.NEUTRAL, primary: '#1f4e8c', agency_name: 'Рекрутинг «Север»' };
    const html = v2.renderClientHtmlV2(DRAFT, { branding: b });
    const w = watch(page);
    await page.setContent(html, { waitUntil: 'load' });
    w.assertClean();

    await expect(page.locator('h1')).toHaveText('Иванов Иван');
    await expect(page.locator('h2')).toContainText([
      'О кандидате', 'Желаемая роль и формат', 'Опыт работы', 'Образование и навыки',
      'Оценка кандидата', 'Зарплатные ожидания', 'Тесты и ссылки', 'Заключение рекрутера', 'Приложения',
    ]);
    // Длинный опыт — все четыре места на месте, в обратной хронологии.
    for (const company of ['True Gamers', 'DataLine', 'StartUp', 'Agency']) {
      await expect(page.locator('.job', { hasText: company })).toHaveCount(1);
    }
    // Тесты — разделом с типизированными результатами.
    await expect(page.locator('td', { hasText: 'D=4 · I=2 · S=3 · C=3' })).toHaveCount(1);
    // INTJ встречается дважды — в названии теста и в результате; оба места легитимны.
    await expect(page.locator('td', { hasText: 'INTJ' })).toHaveCount(2);
    // Пометка об усечении приложения.
    await expect(page.locator('body')).toContainText('показаны первые 60000 знаков из 84000');
    // Внутренние поля не протекают ни в текст, ни в DOM.
    const text = await page.locator('body').innerText();
    for (const leak of ['expert_check', 'risk_log', 'contradictions', 'questions_next_stage', 'correspondence', 'internal_notes', 'не для клиента', 'не упоминать увольнение', 'PostgreSQL — единственный must-have ниже 3']) {
      expect(text, `утечка «${leak}» в клиентский профиль`).not.toContain(leak);
    }
    const htmlText = await page.content();
    expect(htmlText).not.toMatch(/data-(score|evidence|risk|internal|expert|veto|evaluation)/i);
    expect(htmlText).not.toMatch(/<script/i);
    expect(htmlText).not.toMatch(/<!--/);

    // Несколько страниц: длинный опыт должен разойтись на 2+ страницы A4.
    const pages = await page.evaluate(() => {
      const el = document.querySelector('.page');
      return Math.ceil(el.scrollHeight / (Math.round(297 * 96 / 25.4)));
    });
    expect(pages, 'клиентский профиль с длинным опытом должен быть многостраничным').toBeGreaterThanOrEqual(2);
  });

  test('клиентский профиль с фото: фото только в клиентском документе', async ({ page }) => {
    const photo = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
    const html = v2.renderClientHtmlV2(DRAFT, { photoDataUri: photo });
    const w = watch(page);
    await page.setContent(html, { waitUntil: 'load' });
    w.assertClean();
    await expect(page.locator('img.photo')).toHaveCount(1);

    // Внутренняя оценка — MD, фото там не рендерится вовсе.
    const md = v2.renderCleanEvalMdV2(EVAL, { candidateName: 'Иванов Иван' });
    expect(md).not.toContain('data:image');
  });

  test('PDF: клиентский профиль печатается в многостраничный документ без ошибок', async ({ page }) => {
    const html = v2.renderClientHtmlV2(DRAFT);
    const w = watch(page);
    await page.setContent(html, { waitUntil: 'load' });
    w.assertClean();

    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '16mm', right: '16mm' } });
    expect(pdf.length).toBeGreaterThan(1000);
    // PDF-заголовок начинается с %PDF — значит это настоящий документ, а не пустой ответ.
    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');

    // Страницы считаем по маркеру /Type /Page — многостраничность видна и в PDF.
    const pageCount = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    expect(pageCount, 'PDF должен быть многостраничным').toBeGreaterThanOrEqual(2);
  });

  test('пустые разделы рендерятся честно, без пустых заголовков и без выдумок', async ({ page }) => {
    const empty = canonical.buildCanonical({ candidateId: 'x', rows: [] });
    const md = v2.renderCleanEvalMdV2(empty, { candidateName: 'Новый Кандидат' });
    const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>
      body{font:14px/1.5 sans-serif;max-width:820px;margin:0 auto;padding:24px}
      table{width:100%;border-collapse:collapse}th,td{border:1px solid #ccc;padding:4px 6px}
    </style></head><body>${require('../../src/hh-candidate-eval-docs.js').mdToHtml(md)}</body></html>`;
    const w = watch(page);
    await page.setContent(html, { waitUntil: 'load' });
    w.assertClean();

    const text = await page.locator('body').innerText();
    expect(text).toContain('Строк требований нет — сравнивать нечего');
    expect(text).toContain('Не зафиксированы');
    expect(text).toContain('Не определены');
    // Никаких выдуманных оценок и пустых таблиц требований: есть только служебные
    // таблицы параметров и сводки — таблицы требований нет, потому что строк нет.
    expect(text).not.toContain('[object Object]');
    await expect(page.locator('table')).toHaveCount(2);
    await expect(page.locator('th', { hasText: 'Требование' })).toHaveCount(0);
    // Пустые разделы видны как честные пометки, а не как пустые заголовки.
    expect(text).toContain('Не зафиксированы');
    expect(text).toContain('Не определены');
  });
});