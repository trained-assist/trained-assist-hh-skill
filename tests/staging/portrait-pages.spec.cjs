// UX-проверка страниц эпика «портрет кандидата» (#83, страницы #85/#87/#91) в реальном Chromium.
// HTML рендерится модулем (page.setContent), данные — из настоящих фикстур src/
// (портрет через normalizePortrait/computeCompleteness, манифест через addDocument,
// документы через buildReportData/renderCleanEvalMd/renderProfileMd/mdToHtml/wrapHtml).
// Главный чек — ноль JS-ошибок: инлайн-скрипты страниц должны парситься и жить без pageerror.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { vacancyNewPageHtml } = require('../../src/hh-vacancy-new-html.js');
const { candidateNewPageHtml } = require('../../src/hh-candidate-new-html.js');
const { normalizePortrait, computeCompleteness } = require('../../src/hh-portrait.js');
const cand = require('../../src/hh-candidate-docs.js');
const evalDocs = require('../../src/hh-candidate-eval-docs.js');

const RESUME = 'Опыт работы\n2023 – 2025 ООО «Пример», маркетолог\n2019 – 2023 ООО «Прошлый», ассистент\nКлючевые навыки: Excel, SEO\nОбразование: МГУ';
const INTERVIEW = 'Интервью: Стогниенко Анна\n[00:12] Рекрутер: Расскажите про B2B опыт\n[00:30] Анна: B2B у меня небольшой опыт\n[01:41] Анна: Вела Activate Me в Дубае\n';

// Ошибки страницы: pageerror (исключение инлайн-скрипта) + console error.
function watch(page) {
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  return {
    assertClean() {
      expect(pageErrors, 'page errors (инлайн-скрипты страниц)').toEqual([]);
      expect(consoleErrors, 'console errors').toEqual([]);
    },
  };
}

async function render(page, html) {
  await page.setContent(html, { waitUntil: 'load' });
}

// Портрет почти заполненный, но с двумя дырами — чтобы был виден «чего не хватает».
function partialPortrait(opts = {}) {
  const raw = {
    company: {
      name: 'ООО «Пример»', industry: 'Торговля', site: 'https://example.ru', founded_headcount: '2019',
      about: 'На рынке 6 лет', office_address: 'Москва', notable_clients: ['Клиент А'], contact_person: 'Оксана',
    },
    vacancy: {
      title: 'Маркетолог', headcount: 1, work_format: 'Удалённо', location: 'Москва', reason: 'Расширение',
      workplace_address: 'Удаленно', reports_to: 'Собственнику', manages: 'Помощник',
      responsibilities: ['Ведение кабинетов WB'], programs: ['Excel'], expected_results: ['Рост продаж'],
      training: 'Да', probation_months: 3, salary_trial: '70000', salary_after: '100000',
      salary_total: '100000', schedule: '5/2', weekend_work: 'нет', business_trips: 'нет',
      employment_type: 'ТК РФ', perks: ['бонусы'],
      // career_growth и marital_status намеренно не заполнены
    },
    requirements: {
      age: '25-35', gender: 'не важно', education: 'высшее', experience: 'от 2 лет',
      stop_factors: ['пассивность'], photo_required: false, hard_skills: ['SEO карточек'],
      soft_skills: ['Самостоятельность'], additional_info: 'ISTJ', selection_stages: ['скрининг'],
    },
  };
  if (opts.vacancyTitle) raw.vacancy.title = opts.vacancyTitle;
  return normalizePortrait(raw, { vacancy_id: 'vac-1' });
}

// Фикстура манифеста: два документа (резюме/интервью) + фото, как в юнит-тестах.
async function makeCandidate(dataDir) {
  const saved = { AGENT_DATA_DIR: process.env.AGENT_DATA_DIR, USERS_DIR: process.env.USERS_DIR };
  process.env.AGENT_DATA_DIR = path.join(dataDir, 'data');
  process.env.USERS_DIR = path.join(dataDir, 'users');
  try {
    const first = await cand.addDocument({ username: 'alice', candidateName: 'Стогниенко Анна', filename: 'cv.txt', buffer: Buffer.from(RESUME, 'utf8') });
    await cand.addDocument({ username: 'alice', candidateId: first.candidate_id, filename: 'interview.txt', buffer: Buffer.from(INTERVIEW, 'utf8') });
    const root = cand.candRoot('alice', first.candidate_id);
    fs.writeFileSync(path.join(root, 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const manifest = cand.readManifest('alice', first.candidate_id);
    manifest.photo = { file: 'photo.jpg', mime: 'image/jpeg', size: 4 };
    cand.writeManifest('alice', first.candidate_id, manifest);
    return { candidateId: first.candidate_id, manifest: cand.readManifest('alice', first.candidate_id) };
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

// ── (a) vacancy-new ────────────────────────────────────────────────────────────

test('vacancy-new: пустое состояние — «Собрать портрет», без gauge и ATS', async ({ page }) => {
  const w = watch(page);
  await render(page, vacancyNewPageHtml({ username: 'alice', token: 'tok', vacancyId: '' }));
  await expect(page.getByRole('heading', { name: 'Новая вакансия — портрет кандидата' })).toBeVisible();
  await expect(page.locator('#btn-build')).toBeVisible();
  await expect(page.locator('#btn-build')).toContainText('Собрать портрет');
  await expect(page.locator('#gauge-card')).toHaveCount(0);
  await expect(page.locator('#editor-card')).toHaveCount(0);
  await expect(page.locator('#btn-ats')).toHaveCount(0);
  await expect(page.locator('#btn-save')).toHaveCount(0);
  await expect(page.locator('#src-vacancy')).toBeVisible();
  w.assertClean();
});

test('vacancy-new: заполненный портрет — донут 8 сегментов, процент в центре, список пробелов, форма из INIT, btn-save/btn-ats', async ({ page }) => {
  const w = watch(page);
  const portrait = partialPortrait();
  const completeness = computeCompleteness(portrait);
  await render(page, vacancyNewPageHtml({ username: 'alice', token: 'tok', vacancyId: 'vac-1', portrait, completeness }));

  // Донут: 8 секций × (трек + заливка) = 16 дуг, процент по центру
  const gauge = page.locator('#gauge-card');
  await expect(gauge).toBeVisible();
  await expect(gauge.locator('svg')).toHaveAttribute('aria-label', `Полнота портрета ${completeness.percent}%`);
  await expect(gauge.locator('svg circle')).toHaveCount(16);
  await expect(gauge.locator('svg text').first()).toHaveText(`${completeness.percent}%`);
  await expect(gauge.locator('.legend .sec')).toHaveCount(8);
  expect(completeness.percent).toBeGreaterThan(0);
  expect(completeness.percent).toBeLessThan(100);

  // «Чего не хватает»
  const missing = gauge.locator('.miss li');
  await expect(missing.first()).toBeVisible();
  const missingTexts = await missing.allTextContents();
  expect(missingTexts.join('\n')).toContain('Семейное положение');
  expect(missingTexts.join('\n')).toContain('Карьерный рост');

  // Форма предзаполнена из INIT (значения проставлены инлайн-скриптом;
  // id полей — с точкой: f-vacancy.title, поэтому селектим по data-атрибутам)
  const field = (block, name) => page.locator(`[data-block="${block}"][data-field="${name}"]`);
  await expect(field('vacancy', 'title')).toHaveValue('Маркетолог');
  await expect(field('company', 'name')).toHaveValue('ООО «Пример»');
  await expect(field('requirements', 'hard_skills')).toHaveValue('SEO карточек');
  await expect(field('vacancy', 'responsibilities')).toHaveValue('Ведение кабинетов WB');
  await expect(field('requirements', 'photo_required')).toHaveValue('false');
  await expect(field('company', 'notable_clients')).toHaveValue('Клиент А');

  // Кнопки действий видимы
  await expect(page.locator('#btn-save')).toBeVisible();
  await expect(page.locator('#btn-ats')).toBeVisible();
  await expect(page.locator('#btn-build')).toContainText('Пересобрать портрет');
  w.assertClean();
});

test('vacancy-new: враждебный заголовок вакансии не попадает сырым в HTML', async ({ page }) => {
  const w = watch(page);
  const hostile = '<img src=x onerror=alert(1)>';
  const portrait = partialPortrait({ vacancyTitle: hostile });
  const html = vacancyNewPageHtml({ username: 'alice', token: 'tok', vacancyId: 'vac-1', portrait, completeness: computeCompleteness(portrait) });
  expect(html).not.toContain('<img src=x');

  const dialogs = [];
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  await render(page, html);
  await expect(page.locator('img[onerror]')).toHaveCount(0);
  // опасность остаётся данными поля, а не разметкой
  await expect(page.locator('[data-block="vacancy"][data-field="title"]')).toHaveValue(hostile);
  expect(dialogs).toEqual([]);
  w.assertClean();
});

// ── (b) candidate-new ──────────────────────────────────────────────────────────

test('candidate-new: пустое состояние — имя кандидата, dropzone, кнопка файлов', async ({ page }) => {
  const w = watch(page);
  await render(page, candidateNewPageHtml({ username: 'alice', token: 'tok' }));
  await expect(page.getByRole('heading', { name: 'Новый кандидат' })).toBeVisible();
  await expect(page.locator('#cand-name')).toBeVisible();
  await expect(page.locator('#cand-name')).toHaveAttribute('placeholder', /Стогниенко/);
  await expect(page.locator('#drop')).toBeVisible();
  await expect(page.locator('#btn-files')).toBeVisible();
  await expect(page.locator('#btn-eval')).toHaveCount(0);
  await expect(page.locator('#btn-profile')).toHaveCount(0);
  await expect(page.locator('table')).toHaveCount(0);
  w.assertClean();
});

test('candidate-new: манифест — строки таблицы, select типа, ссылки отчётов, btn-eval/btn-profile, фото', async ({ page }) => {
  const w = watch(page);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cand-new-ux-'));
  try {
    const { candidateId, manifest } = await makeCandidate(dir);
    expect(manifest.docs).toHaveLength(2);

    await render(page, candidateNewPageHtml({ username: 'alice', token: 'tok', candidateId, manifest }));

    // Таблица документов: строки + select типа для каждого документа
    const rows = page.locator('table tbody tr');
    await expect(rows).toHaveCount(2);
    const selects = page.locator('select[data-set-type]');
    await expect(selects).toHaveCount(2);
    await expect(selects.first().locator('option')).toHaveCount(7); // TYPE_LABELS целиком
    const types = manifest.docs.map(d => d.type).sort();
    expect(types).toEqual(['interview', 'resume']);
    for (let i = 0; i < manifest.docs.length; i++) {
      const sel = selects.nth(i);
      await expect(sel.locator('option:checked')).toHaveText(manifest.docs[i].type === 'resume' ? 'Резюме' : 'Интервью');
    }

    // Ссылки на два документа: просмотр/MD/PDF
    const links = await page.locator('a.btn').evaluateAll(as => as.map(a => a.getAttribute('href')));
    expect(links.some(h => h.includes('candidate-report?') && h.includes('which=profile'))).toBe(true);
    expect(links.some(h => h.includes('candidate-report?') && h.includes('which=profile') && h.includes('format=md'))).toBe(true);
    expect(links.some(h => h.includes('candidate-report.pdf?') && h.includes('which=eval'))).toBe(true);

    // Действия и фото
    await expect(page.locator('#btn-eval')).toBeVisible();
    await expect(page.locator('#btn-eval')).toContainText('Запустить оценку');
    await expect(page.locator('#btn-profile')).toBeVisible();
    await expect(page.locator('#btn-profile')).toContainText('Извлечь профиль');
    const photo = page.locator('img[src^="candidate-photo"]');
    await expect(photo).toHaveCount(1);
    expect(await photo.boundingBox()).not.toBeNull();

    // Имя кандидата — в заголовке карточки документов
    await expect(page.locator('h3', { hasText: 'Документы — Стогниенко Анна' })).toBeVisible();
    w.assertClean();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── (d) два документа (#91) ────────────────────────────────────────────────────

async function makeReportData(dataDir) {
  const saved = { AGENT_DATA_DIR: process.env.AGENT_DATA_DIR, USERS_DIR: process.env.USERS_DIR };
  process.env.AGENT_DATA_DIR = path.join(dataDir, 'data');
  process.env.USERS_DIR = path.join(dataDir, 'users');
  try {
    const { candidateId } = await makeCandidate(dataDir);
    const ivDir = path.join(dataDir, 'data', 'hh', 'alice', 'interviews', candidateId);
    fs.mkdirSync(ivDir, { recursive: true });
    fs.writeFileSync(path.join(ivDir, `${candidateId}.interview-eval.json`), JSON.stringify({
      candidate: 'Стогниенко Анна',
      totals: { percent: 60, score_10: 6.0 },
      percent: 60, score10: 6.0, verdict: 'УТОЧНИТЬ',
      requirements: [
        { label: 'Опыт B2B', kind: 'must', must_have: true, weight: 2, score: 2, evidence: '«B2B у меня небольшой опыт»', source: 'интервью 2:43' },
        { label: 'Аналитика', kind: 'must', must_have: true, weight: 2, score: null, evidence: '', source: '' },
        { label: 'Ивенты', kind: 'nice', must_have: false, weight: 1, score: 4, evidence: 'Activate Me Дубай', source: 'интервью 1:41' },
      ],
      veto: [],
      coverage: { covered: [{ topic: 'Опыт True Gamers', quote: 'Я вела проекты' }], missing: ['Вебинары'] },
      communication: {
        style: { label: 'Стиль общения', score: 4, evidence: 'спокойно, по делу' },
        politeness: { label: 'Вежливость', score: 5, evidence: 'ну да, хорошо' },
      },
    }));
    const data = evalDocs.buildReportData({ username: 'alice', candidateId });
    expect(data.error).toBeNull();
    data.profile = {
      summary: 'Работаю проект-менеджером 6 лет.',
      fit: [
        { status: 'yes', requirement: 'Опыт PM', comment: '6 лет в проектах' },
        { status: 'partial', requirement: 'Бюджет', comment: 'сметы есть, медиапланов нет' },
        { status: 'note', requirement: 'B2B', comment: 'узкий сегмент' },
      ],
      experience: [{ period: '2023-2025', company: 'True Gamers', role: 'PM', details: ['15+ проектов'], from_interview: 'Activate Me' }],
      education: ['МПГУ, филолог'], languages: ['Английский C1'], location: 'Отрадное, удалёнка',
      salary_expectations: null,
      nuances: ['B2B узкий'],
      conclusion: null,
    };
    // data URI фото — пока AGENT_DATA_DIR ещё указывает на песочницу
    const photoUri = evalDocs.photoDataUri('alice', candidateId);
    return { data, candidateId, photoUri };
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

test('документ «Чистая оценка» рендерится в HTML: h1, таблица требований, Коммуникация, Ограничения', async ({ page }) => {
  const w = watch(page);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-doc-ux-'));
  try {
    const { data } = await makeReportData(dir);
    const md = evalDocs.renderCleanEvalMd(data);
    const html = evalDocs.wrapHtml(`Оценка — ${data.candidate.name}`, evalDocs.mdToHtml(md));
    await render(page, html);

    await expect(page.locator('h1')).toHaveText('Оценка кандидата — Стогниенко Анна');

    const reqTable = page.locator('table').filter({ has: page.locator('th', { hasText: 'Требование' }) });
    await expect(reqTable).toHaveCount(1);
    await expect(reqTable.locator('th')).toHaveCount(6);
    expect(await reqTable.locator('td').count()).toBeGreaterThan(0);
    await expect(reqTable).toContainText('must-have');

    await expect(page.locator('h2', { hasText: 'Коммуникация' })).toHaveCount(1);
    await expect(page.locator('h2', { hasText: 'Ограничения' })).toHaveCount(1);
    await expect(page.locator('h2', { hasText: 'Полнота данных' })).toHaveCount(1);
    w.assertClean();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('документ «Полный профиль» рендерится в HTML: грид ✓/△/⚠, опыт, приложение-резюме', async ({ page }) => {
  const w = watch(page);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-doc-ux-'));
  try {
    const { data, photoUri } = await makeReportData(dir);
    expect(photoUri).toMatch(/^data:image\/jpeg;base64,/);
    const md = evalDocs.renderProfileMd(data);
    const html = evalDocs.wrapHtml(data.candidate.name, evalDocs.mdToHtml(md), { photoDataUri: photoUri });
    await render(page, html);

    await expect(page.locator('h1')).toHaveText('Стогниенко Анна');
    await expect(page.locator('h2', { hasText: 'Соответствие вакансии' })).toHaveCount(1);

    const fitTable = page.locator('table').first();
    expect(await fitTable.locator('tr td:first-child').allTextContents()).toEqual(['✓', '△', '⚠']);

    await expect(page.locator('h2', { hasText: 'Опыт работы' })).toHaveCount(1);
    await expect(page.locator('h2', { hasText: 'Приложение: резюме' })).toHaveCount(1);
    await expect(page.locator('pre')).toContainText('Опыт работы');
    await expect(page.locator('img.photo')).toHaveCount(1);
    w.assertClean();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── (e) адаптив 390×844 ────────────────────────────────────────────────────────

test('адаптив 390×844: vacancy-new — gauge и кнопки видимы, нет горизонтального скролла', async ({ page }) => {
  const w = watch(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const portrait = partialPortrait();
  await render(page, vacancyNewPageHtml({ username: 'alice', token: 'tok', vacancyId: 'vac-1', portrait, completeness: computeCompleteness(portrait) }));

  await expect(page.locator('#gauge-card')).toBeVisible();
  await expect(page.locator('#gauge-card svg')).toBeVisible();
  await expect(page.locator('#btn-save')).toBeVisible();
  await expect(page.locator('#btn-ats')).toBeVisible();
  await expect(page.locator('#btn-build')).toBeVisible();

  const [scrollW, innerW] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scrollW, `scrollWidth ${scrollW} > innerWidth ${innerW}`).toBeLessThanOrEqual(innerW + 1);
  w.assertClean();
});

test('адаптив 390×844: candidate-new — карточки видимы, нет горизонтального скролла', async ({ page }) => {
  const w = watch(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cand-adaptive-'));
  try {
    const { candidateId, manifest } = await makeCandidate(dir);
    await render(page, candidateNewPageHtml({ username: 'alice', token: 'tok', candidateId, manifest }));

    await expect(page.locator('#drop')).toBeVisible();
    await expect(page.locator('table')).toBeVisible();
    await expect(page.locator('#btn-eval')).toBeVisible();
    await expect(page.locator('#btn-profile')).toBeVisible();

    const [scrollW, innerW] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(scrollW, `scrollWidth ${scrollW} > innerWidth ${innerW}`).toBeLessThanOrEqual(innerW + 1);
    w.assertClean();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
