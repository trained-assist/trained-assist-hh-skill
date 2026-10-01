// src/hh-candidate-eval-docs.js — два документа кандидата (#91) + mdToHtml.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const docs = require('../../src/hh-candidate-eval-docs.js');
const cand = require('../../src/hh-candidate-docs.js');

let dataDir, usersDir;
let saved;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'hh-eval-docs-data-'));
  usersDir = mkdtempSync(join(tmpdir(), 'hh-eval-docs-users-'));
  saved = { AGENT_DATA_DIR: process.env.AGENT_DATA_DIR, USERS_DIR: process.env.USERS_DIR };
  process.env.AGENT_DATA_DIR = dataDir;
  process.env.USERS_DIR = usersDir;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(usersDir, { recursive: true, force: true });
});

const RESUME = Buffer.from('Опыт работы\n2023 – 2025 ООО «Пример», маркетолог\nНавыки: Excel, SEO', 'utf8');

async function makeCandidate(name = 'Стогниенко Анна') {
  const out = await cand.addDocument({ username: 'u1', candidateName: name, filename: 'cv.txt', buffer: RESUME });
  return out.candidate_id;
}

const FULL_SCORING = {
  percent: 60, score10: 6.0, verdict: 'УТОЧНИТЬ', spent_minutes: 3,
  rows: [
    { n: 1, requirement: 'Опыт B2B', klass: 'must', weight: 2, score: 2, evidence: '«B2B у меня небольшой опыт»', source: 'интервью 2:43' },
    { n: 2, requirement: 'Аналитика', klass: 'must', weight: 2, score: 'n/a', evidence: '', source: '' },
    { n: 3, requirement: 'Ивенты', klass: 'nice', weight: 1, score: 4, evidence: 'Activate Me Дубай', source: 'интервью 1:41' },
  ],
  not_evaluated: ['Аналитика'], veto: [],
  total_note: null, ats_score: null,
};

describe('renderCleanEvalMd', () => {
  it('contains the canon sections with weights, evidence and n/a', () => {
    const md = docs.renderCleanEvalMd({
      generated_at: '2026-10-01',
      candidate: { id: 'c1', name: 'Анна' },
      vacancy: { title: 'Маркетолог' },
      sources: { resume: true, cover_letter: false, correspondence: false, interview: true },
      interview_minutes: 7,
      scoring: FULL_SCORING,
      interview_coverage: { covered: [{ topic: 'Опыт True Gamers', quote: 'Я вела проекты' }], missing: ['Вебинары'] },
      communication: { rows: [{ metric: 'Вежливость', score: 5, quote: 'ну да, хорошо' }] },
      comparison: { min: 38, avg: 52, max: 71, place: 5, total: 9, percent: 60 },
      limitations: ['Переписка не загружена.'],
    });
    expect(md).toContain('# Оценка кандидата — Анна');
    expect(md).toContain('| Итоговый скор | **60% · 6.0 / 10** |');
    expect(md).toContain('must-have');
    expect(md).toContain('«B2B у меня небольшой опыт»');
    expect(md).toContain('**Не оценивалось (n/a):** Аналитика');
    expect(md).toContain('## Покрытие интервью');
    expect(md).toContain('**Не прозвучало:** Вебинары');
    expect(md).toContain('## Коммуникация');
    expect(md).toContain('**5-е место из 9**');
    expect(md).toContain('## Ограничения');
    expect(md).toContain('- Переписка не загружена.');
  });
});

describe('renderProfileMd', () => {
  it('renders the hybrid structure (fit grid, nuances, conclusion placeholder, resume appendix)', async () => {
    const candidateId = await makeCandidate();
    const data = docs.buildReportData({ username: 'u1', candidateId });
    expect(data.error).toBeNull();
    data.profile = {
      summary: 'Работаю проект-менеджером 6 лет.',
      fit: [{ status: 'partial', requirement: 'Бюджет', comment: 'сметы есть, медиапланов нет' }],
      experience: [{ period: '2023-2025', company: 'True Gamers', role: 'PM', details: ['15+ проектов'], from_interview: 'Activate Me' }],
      education: ['МПГУ, филолог'], languages: ['Английский C1'], location: 'Отрадное, удалёнка',
      salary_expectations: null,
      nuances: ['B2B узкий'],
      conclusion: null,
    };
    const md = docs.renderProfileMd(data);
    expect(md).toContain('# Стогниенко Анна');
    expect(md).toContain('## Саммари');
    expect(md).toContain('Работаю проект-менеджером');
    expect(md).toContain('| △ | Бюджет |');
    expect(md).toContain('## Опыт работы');
    expect(md).toContain('*Из интервью: Activate Me*');
    expect(md).toContain('## Ключевые параметры');
    expect(md).toContain('## Нюансы и риски');
    expect(md).toContain('рекрутер');
    expect(md).toContain('## Приложение: резюме');
    expect(md).toContain('Опыт работы'); // resume_raw из манифеста
  });

  it('falls back to a minimal fit grid without an LLM profile', async () => {
    const candidateId = await makeCandidate();
    const data = docs.buildReportData({ username: 'u1', candidateId });
    const md = docs.renderProfileMd(data);
    expect(md).toContain('## Соответствие вакансии');
    expect(md).toMatch(/\| [✓△⚠] \|/);
  });
});

describe('buildReportData limitations', () => {
  it('lists honestly what is missing', async () => {
    const candidateId = await makeCandidate();
    const data = docs.buildReportData({ username: 'u1', candidateId });
    expect(data.sources.resume).toBe(true);
    expect(data.sources.interview).toBe(false);
    expect(data.limitations.join(' ')).toContain('Интервью не загружено');
    expect(data.limitations.join(' ')).toContain('«Запустить оценку»');
    expect(data.scoring.rows).toEqual([]);
  });
});

describe('mdToHtml', () => {
  it('renders headings, lists, tables, bold and code', () => {
    const html = docs.mdToHtml('# Заголовок\n- пункт **жирный**\n- второй\n\n| A | B |\n|---|---|\n| 1 | `x` |\n\nКонец');
    expect(html).toContain('<h1>Заголовок</h1>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<b>жирный</b>');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>A</th>');
    expect(html).toContain('<code>x</code>');
    expect(html).toContain('<p>Конец</p>');
  });

  it('escapes HTML in text and preserves it in code blocks', () => {
    const html = docs.mdToHtml('параграф <script>alert(1)</script>\n\n```\n<b>code</b>\n```');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<pre>&lt;b&gt;code&lt;/b&gt;</pre>');
  });
});

describe('findInterviewEval (#89 layout)', () => {
  it('reads interviews/<slug>/<slug>.interview-eval.json and feeds coverage/communication into the report', async () => {
    const candidateId = await makeCandidate();
    const ivDir = join(dataDir, 'hh', 'u1', 'interviews', 'anna');
    mkdirSync(ivDir, { recursive: true });
    writeFileSync(join(ivDir, 'anna.interview-eval.json'), JSON.stringify({
      candidate: 'Стогниенко Анна', percent: 60, score10: 6, verdict: 'УТОЧНИТЬ',
      scoring: [{ criterion: 'Опыт B2B', weight: 2, score: 2, evidence: '«небольшой опыт»' }],
      coverage: { covered: [{ topic: 'Опыт', quote: 'True Gamers' }], missing: ['Вебинары'] },
      communication: { rows: [{ metric: 'Вежливость', score: 5, quote: 'ну да' }] },
    }));
    const data = docs.buildReportData({ username: 'u1', candidateId });
    expect(data.interview_coverage).toBeTruthy();
    expect(data.interview_coverage.missing).toContain('Вебинары');
    expect(data.communication.rows[0].metric).toBe('Вежливость');
    expect(data.scoring.rows[0].requirement).toBe('Опыт B2B');
    const md = docs.renderCleanEvalMd(data);
    expect(md).toContain('## Покрытие интервью');
  });
});

describe('photoDataUri', () => {
  it('embeds the stored photo as a data URI', async () => {
    const candidateId = await makeCandidate();
    const manifest = cand.readManifest('u1', candidateId);
    mkdirSync(cand.candRoot('u1', candidateId), { recursive: true });
    writeFileSync(join(cand.candRoot('u1', candidateId), 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    manifest.photo = { file: 'photo.jpg', mime: 'image/jpeg' };
    cand.writeManifest('u1', candidateId, manifest);
    const uri = docs.photoDataUri('u1', candidateId);
    expect(uri).toMatch(/^data:image\/jpeg;base64,/);
  });
});
