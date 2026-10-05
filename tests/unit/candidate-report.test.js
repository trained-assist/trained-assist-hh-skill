// Candidate-for-client report (agent issue #982, moved from core in agent#1470):
// requirements log, HTML template and the MCP tools that share the notes file.
// Core keeps the quick-answer tests (they drive core's intent-engine).

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const report = require('../../src/hh-candidate-report.js');

const roots = [];
function freshDir() {
  const d = mkdtempSync(join(tmpdir(), 'cand-report-'));
  roots.push(d);
  return d;
}
afterAll(() => roots.forEach(d => rmSync(d, { recursive: true, force: true })));

const NOW = new Date(2026, 8, 18, 12, 0); // 18.09

describe('notes file', () => {
  let wd;
  beforeEach(() => { wd = freshDir(); });

  it('writes the issue layout: three sections, dated history', () => {
    report.addNote(wd, 'dmitriy-chayka', 'Не писать «рассматривает удалённый формат» — офис в МСК', { now: NOW, nameForNew: 'Дмитрий Чайка' });
    report.addNote(wd, 'dmitriy-chayka', 'Включить ссылку на видео скрининга', { now: NOW });
    const md = readFileSync(report.notesPath(wd, 'dmitriy-chayka'), 'utf8');
    expect(md).toContain('# Требования к профилю: Дмитрий Чайка');
    expect(md).toContain('## Что включать\n- Включить ссылку на видео скрининга');
    expect(md).toContain('## Что НЕ включать / формулировки\n- Не писать «рассматривает удалённый формат» — офис в МСК');
    expect(md).toContain('- 18.09 — добавлено: Включить ссылку на видео скрининга');
  });

  it('round-trips through parseNotes and keeps history', () => {
    report.addNote(wd, 'a', 'Писать от первого лица', { now: NOW });
    report.addNote(wd, 'a', 'Убрать фразу про NeuroFinance', { now: NOW });
    const n = report.readNotes(wd, 'a');
    expect(n.exclude).toEqual(['Писать от первого лица', 'Убрать фразу про NeuroFinance']);
    expect(n.history).toHaveLength(2);
  });

  it('classifies: negative lead + formulation rules → exclude, explicit inclusion → include', () => {
    expect(report.classifyNote('не упоминать удалёнку')).toBe('exclude');
    expect(report.classifyNote('убери фразу про фонд')).toBe('exclude');
    expect(report.classifyNote('нюансы подавать честно, не как плюсы')).toBe('exclude');
    expect(report.classifyNote('включи матрицу соответствия')).toBe('include');
    expect(report.classifyNote('добавь ссылку на видео')).toBe('include');
  });

  it('does not duplicate an identical requirement or add a history line for it', () => {
    report.addNote(wd, 'a', 'Не упоминать удалёнку', { now: NOW });
    const r = report.addNote(wd, 'a', 'не упоминать удалёнку', { now: NOW });
    expect(r.duplicate).toBe(true);
    const n = report.readNotes(wd, 'a');
    expect(n.exclude).toHaveLength(1);
    expect(n.history).toHaveLength(1);
  });

  it('notes file is 0600 (candidate PII context)', () => {
    report.addNote(wd, 'a', 'Не упоминать удалёнку');
    const { statSync } = require('fs');
    expect(statSync(report.notesPath(wd, 'a')).mode & 0o777).toBe(0o600);
  });
});

describe('candidate resolution', () => {
  it('matches surname in any case form, ambiguous and unknown are reported', () => {
    const wd = freshDir();
    report.addNote(wd, 'дмитрий-чайка', 'Не упоминать удалёнку');
    report.addNote(wd, 'антон-яковенко', 'Не упоминать удалёнку');
    expect(report.resolveCandidate(wd, 'Чайка')).toEqual({ slug: 'дмитрий-чайка' });
    expect(report.resolveCandidate(wd, 'Чайку')).toEqual({ slug: 'дмитрий-чайка' });
    expect(report.resolveCandidate(wd, 'Дмитрия Чайки')).toEqual({ slug: 'дмитрий-чайка' });
    expect(report.resolveCandidate(wd, 'Иванов')).toEqual({ none: true });
    report.addNote(wd, 'дмитрий-иванов', 'Не упоминать удалёнку');
    expect(report.resolveCandidate(wd, 'Дмитрий').ambiguous).toHaveLength(2);
  });

  it('no name → last candidate worked on', () => {
    const wd = freshDir();
    report.addNote(wd, 'антон-яковенко', 'Не упоминать удалёнку');
    report.addNote(wd, 'дмитрий-чайка', 'Не упоминать удалёнку');
    expect(report.resolveCandidate(wd, '')).toEqual({ slug: 'дмитрий-чайка' });
  });
});

describe('banned phrases', () => {
  const notes = {
    name: 'x', include: [],
    exclude: [
      'Не писать «рассматривает удалённый формат» — офис в МСК',
      'Убрать фразу «Основной фокус — зарубежный фондовый рынок»',
      'Нюансы подавать честно, не как плюсы',
      'Писать про «фонд» подробно', // not a negative rule → not a ban
    ],
    history: [],
  };

  it('extracts quoted phrases only from negative rules', () => {
    expect(report.forbiddenPhrases(notes)).toEqual([
      'рассматривает удалённый формат',
      'Основной фокус — зарубежный фондовый рынок',
    ]);
  });

  it('finds them case/ё/whitespace-insensitively anywhere in the data', () => {
    const data = { summary: 'Он  РАССМАТРИВАЕТ удаленный   формат работы', experience: [{ details: ['ок'] }] };
    expect(report.findViolations(data, notes)).toEqual([{ phrase: 'рассматривает удалённый формат' }]);
    expect(report.findViolations({ summary: 'чисто' }, notes)).toEqual([]);
  });
});

describe('HTML template', () => {
  const data = {
    candidate: { name: 'Дмитрий Чайка', age: '23 года', position: 'Финансовый советник, БКС', contacts: ['+7 900 000-00-00'], badges: ['план 115%', 'max сделка 42 млн'], photo_url: 'https://x.test/a.jpg' },
    client: { company: 'АТОН', vacancy: 'Финансовый советник' },
    summary: 'Я работаю с 130–140 клиентами.\n\nПлан выполняю на 115%.',
    matrix: [
      { requirement: 'Опыт в продажах ФУ', status: 'yes', comment: '3 года' },
      { requirement: 'Офис в МСК', status: 'partial', comment: 'сейчас в Таиланде' },
      { requirement: 'Английский', status: 'no' },
    ],
    experience: [{ period: '2023–н.в.', company: 'БКС', role: 'Советник', details: ['130–140 клиентов'] }],
    conclusion: 'Рекомендую к встрече.\n\nНюанс: релокация.',
    video_url: 'https://video.test/abc',
  };

  it('renders header, matrix statuses, conclusion, video and print CSS', () => {
    const { html, warnings } = report.renderProfileHtml(data);
    expect(warnings).toEqual([]);
    expect(html).toContain('<h1>Дмитрий Чайка</h1>');
    expect(html).toContain('план 115%');
    expect(html).toContain('class="st yes"');
    expect(html).toContain('class="st partial"');
    expect(html).toContain('class="st no"');
    expect(html).toContain('Вывод рекрутера');
    expect(html).toContain('href="https://video.test/abc"');
    expect(html).toContain('@media print');
    expect(html).toContain('@page{size:A4;margin:0}');
    expect(html.match(/<p>Я работаю/g)).toHaveLength(1);
    expect(html).toContain('<p>План выполняю'); // paragraphs split on blank line
  });

  it('escapes HTML and refuses non-http urls (no script/javascript: injection)', () => {
    const { html } = report.renderProfileHtml({
      ...data,
      candidate: { name: '<script>alert(1)</script>', photo_url: 'javascript:alert(1)' },
      video_url: 'javascript:alert(2)',
    });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('javascript:');
  });

  it('warns about missing sections instead of failing; name is mandatory', () => {
    const { warnings } = report.renderProfileHtml({ candidate: { name: 'X' } });
    expect(warnings.join('|')).toMatch(/summary.*matrix.*conclusion.*video_url/);
    expect(() => report.renderProfileHtml({ candidate: {} })).toThrow(/name/);
  });

  it('publishSlug is ASCII, stable, and distinct per candidate/profile', () => {
    const a = report.publishSlug('efi', 'дмитрий-чайка');
    expect(a).toMatch(/^profile-dmitriy-chayka-[0-9a-f]{6}$/);
    expect(report.publishSlug('efi', 'дмитрий-чайка')).toBe(a);
    expect(report.publishSlug('efi', 'антон-яковенко')).not.toBe(a);
    expect(report.publishSlug('other', 'дмитрий-чайка')).not.toBe(a);
  });
});

describe('MCP tools share the notes file', () => {
  const users = process.env.USERS_DIR || (process.env.USERS_DIR = freshDir());
  const prevUser = process.env.USER_ID;
  let tools;

  beforeEach(() => {
    process.env.USER_ID = 'rec-test';
    mkdirSync(join(users, 'rec-test'), { recursive: true });
    rmSync(join(users, 'rec-test', 'candidate-reports'), { recursive: true, force: true });
    // Modules read USER_ID at load; reload for a deterministic env.
    for (const k of Object.keys(require.cache)) if (/97-candidate|hh-core-publish/.test(k)) delete require.cache[k];
    tools = require('../../src/mcp-skills/tools/97-candidate-client-report.js').tools;
  });
  afterAll(() => {
    if (prevUser === undefined) delete process.env.USER_ID; else process.env.USER_ID = prevUser;
    rmSync(join(users, 'rec-test'), { recursive: true, force: true });
  });

  const DATA = {
    candidate: { name: 'Дмитрий Чайка' },
    summary: 'Он рассматривает удалённый формат.',
    matrix: [{ requirement: 'Офис', status: 'yes' }],
    conclusion: 'Рекомендую.',
    video_url: 'https://v.test/1',
  };

  it('a note added by quick answer is enforced on render; fixing the text unblocks publishing', async () => {
    const wd = join(users, 'rec-test');
    report.addNote(wd, 'чайка', 'не писать «рассматривает удалённый формат»', { nameForNew: 'Чайка' });

    const ctx = await tools.candidate_report_context.handler({ candidate: 'Чайку' });
    expect(ctx.slug).toBe('чайка');
    expect(ctx.banned_phrases).toEqual(['рассматривает удалённый формат']);

    const bad = await tools.candidate_report_html.handler({ candidate: 'Чайка', data: DATA, publish: false });
    expect(bad.ok).toBe(false);
    expect(bad.violations).toEqual([{ phrase: 'рассматривает удалённый формат' }]);
    expect(existsSync(report.htmlPath(wd, 'чайка'))).toBe(false);

    const ok = await tools.candidate_report_html.handler({
      candidate: 'Чайка', publish: false,
      data: { ...DATA, summary: 'Готов работать в офисе в Москве.' },
    });
    expect(ok.ok).toBe(true);
    expect(existsSync(ok.html_file)).toBe(true);

    // Regeneration gets the previous data back — the recruiter doesn't have to restate anything.
    const again = await tools.candidate_report_context.handler({ candidate: 'Чайка' });
    expect(again.previous_data.summary).toBe('Готов работать в офисе в Москве.');
    expect(again.notes_markdown).toContain('профиль перегенерирован');
  });

  it('render publishes through core POST /internal/publish with an ASCII slug and password', async () => {
    const calls = [];
    const prev = { fetch: globalThis.fetch, secret: process.env.AGENT_SECRET, url: process.env.AGENT_INTERNAL_URL };
    process.env.AGENT_SECRET = 's'; process.env.AGENT_INTERNAL_URL = 'http://core.test';
    globalThis.fetch = async (u, init) => {
      const body = JSON.parse(init.body); calls.push({ u, body });
      const url = `https://pub.test/p/${body.slug}`;
      return { ok: true, json: async () => ({ url: body.password ? `${url}?password=${body.password}` : url, is_protected: !!body.password }) };
    };
    let r;
    try {
      r = await tools.candidate_report_html.handler({
      candidate: 'Дмитрий Чайка', data: { ...DATA, summary: 'Ок.' }, password: 's3cret',
    });
    } finally {
      globalThis.fetch = prev.fetch;
      if (prev.secret === undefined) delete process.env.AGENT_SECRET; else process.env.AGENT_SECRET = prev.secret;
      if (prev.url === undefined) delete process.env.AGENT_INTERNAL_URL; else process.env.AGENT_INTERNAL_URL = prev.url;
    }
    expect(calls[0].u).toBe('http://core.test/internal/publish');
    expect(calls[0].body).toMatchObject({ username: 'rec-test', format: 'html', password: 's3cret' });
    expect(r.ok).toBe(true);
    expect(r.url).toMatch(/\/p\/profile-dmitriy-chayka-[0-9a-f]{6}\?password=s3cret$/);
    expect(r.is_protected).toBe(true);
  });

  it('add_note tool writes into the same file', async () => {
    const r = await tools.candidate_report_add_note.handler({ candidate: 'Яковенко', text: 'Нюансы подавать честно' });
    expect(r.section).toBe('exclude');
    expect(existsSync(join(users, 'rec-test', 'candidate-reports', 'яковенко-report-notes.md'))).toBe(true);
  });

  it('errors clearly when candidate is unknown and no last candidate', async () => {
    const r = await tools.candidate_report_add_note.handler({ text: 'x y z' });
    expect(r.error).toMatch(/candidate/);
  });
});
