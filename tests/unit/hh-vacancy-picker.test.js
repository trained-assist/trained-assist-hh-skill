// Vacancy switcher on /hh/proactive, /hh/review and /hh/ats-editor: one dropdown with the
// full name + city + company instead of a wrap of truncated chips (agent 2026-09-29).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { vacancyPickerHtml, vacancyLabel, extractVacancyPicker, injectHhNav, NAV_ID } = require('../../src/hh-nav.js');
const { generateProactivePageHtml } = require('../../src/hh-proactive-page.js');

const VACANCIES = [
  { id: '1', title: 'Дизайнер мебели', area: { id: '51', name: 'Сыктывкар' }, company_label: 'Мебель Натали — Дизайнер' },
  { id: '2', title: 'Дизайнер мебели', area: { id: '1', name: 'Москва' } },
  { id: '3', title: 'Инженер-конструктор' },
];

describe('vacancy picker', () => {
  it('labels carry city and company so same-title vacancies are distinguishable', () => {
    expect(vacancyLabel(VACANCIES[0])).toBe('Дизайнер мебели · Сыктывкар · Мебель Натали');
    expect(vacancyLabel(VACANCIES[1])).toBe('Дизайнер мебели · Москва');
    expect(vacancyLabel(VACANCIES[2])).toBe('Инженер-конструктор');
  });

  it('renders one <select> with the current vacancy selected, always visible even for a single vacancy', () => {
    const html = vacancyPickerHtml(VACANCIES, '2', v => `?vacancy_id=${v.id}`);
    expect(html.match(/<select/g)).toHaveLength(1);
    expect(html.match(/<option/g)).toHaveLength(3);
    expect(html).toContain('<option value="?vacancy_id=2" selected>Дизайнер мебели · Москва</option>');
    // Epic #112: the switcher must be visible when there is exactly one vacancy —
    // that is when «+ Добавить вакансию» is needed most.
    const single = vacancyPickerHtml(VACANCIES.slice(0, 1), '1', v => `?vacancy_id=${v.id}`);
    expect(single).not.toBe('');
    expect(single.match(/<option/g)).toHaveLength(1);
    // And empty pickers stay silent (no tracked vacancies yet).
    expect(vacancyPickerHtml([], '1', () => '')).toContain('data-testid="vacancy-picker"');
  });

  it('renders «+ Добавить вакансию» when the page supplies its link', () => {
    const html = vacancyPickerHtml(VACANCIES, '2', v => `?vacancy_id=${v.id}`, 'https://x/hh/vacancy-new?username=u&token=t');
    expect(html).toContain('data-testid="vacancy-add"');
    expect(html).toContain('https://x/hh/vacancy-new?username=u&amp;token=t');
    expect(html).toContain('+ Добавить вакансию');
  });

  it('an untracked current vacancy gets a placeholder instead of silently selecting another', () => {
    const html = vacancyPickerHtml(VACANCIES, '999', v => `?vacancy_id=${v.id}`);
    expect(html).toContain('<option value="" selected>— выберите вакансию —</option>');
  });

  it('proactive page uses the dropdown, not chip tabs', () => {
    const html = generateProactivePageHtml({ vacancy_title: 'Дизайнер мебели', candidates: [] }, 'u', 'https://x', 't', {},
      { activeVacancies: VACANCIES, vacancyId: '1' });
    expect(html).toContain('data-testid="vacancy-picker"');
    expect(html).not.toContain('class="vacancy-tab');
    expect(html).toContain('https://x/hh/proactive?username=u&amp;token=t&amp;vacancy_id=2');
  });
});

// Issue #121: the picker decides the scope of every section link, so it must sit in the
// nav bar ABOVE them, not as a separate block under the bar. The page templates still
// emit it inline (their markup/JS/query params must stay byte-for-byte), so the nav
// wrapper moves it.
describe('picker placement in the nav (#121)', () => {
  const picker = vacancyPickerHtml(VACANCIES, '2', v => `?vacancy_id=${v.id}`, '/add');
  const page = `<!doctype html><html><body>
  ${picker}
  <main>page content</main></body></html>`;

  it('extracts the picker out of the page body, keeping the rest untouched', () => {
    const { picker: p, rest } = extractVacancyPicker(page);
    expect(p).toContain('data-testid="vacancy-picker"');
    expect(p).toContain('?vacancy_id=2');
    expect(rest).not.toContain('data-testid="vacancy-picker"');
    expect(rest).toContain('<main>page content</main>');
  });

  it('renders the picker inside the nav, on the top row above the section links', () => {
    const out = injectHhNav(page, { pathname: '/hh/proactive', username: 'u', token: 't', vacancyId: '2' });
    const navStart = out.indexOf(`<nav id="${NAV_ID}"`);
    const navEnd = out.indexOf('</nav>');
    expect(navStart).toBeGreaterThan(-1);
    const nav = out.slice(navStart, navEnd);
    const pickerAt = nav.indexOf('data-testid="vacancy-picker"');
    const settingsAt = nav.indexOf('data-testid="nav-settings"');
    const linksAt = nav.indexOf('class="hh-nav-row hh-nav-links"');
    expect(pickerAt).toBeGreaterThan(-1);
    // Top row: picker + settings. Bottom row: the section links it scopes.
    expect(settingsAt).toBeGreaterThan(pickerAt);
    expect(linksAt).toBeGreaterThan(settingsAt);
    expect(nav.slice(linksAt)).toContain('>Вакансии<');
    // Exactly once — moved, not copied.
    expect(out.match(/data-testid="vacancy-picker"/g)).toHaveLength(1);
  });

  it('leaves pages without a picker on the original single row', () => {
    const bare = '<!doctype html><html><body><main>x</main></body></html>';
    const out = injectHhNav(bare, { pathname: '/hh/plan', username: 'u', token: 't' });
    expect(out).not.toContain('class="hh-nav-row"');
    expect(out).not.toContain('data-testid="vacancy-picker"');
    expect(out).toContain('data-testid="nav-settings"');
    expect(out).toContain('<main>x</main>');
  });

  it('cuts on the marker, not the first </div> — the picker nests divs', () => {
    const { picker: p } = extractVacancyPicker(page);
    // The select and the +Добавить link live inside the picker; a naive tag match would
    // have truncated here and left orphan markup in the body.
    expect(p).toContain('</select>');
    expect(p).toContain('/add');
    expect(p.trimEnd().endsWith('</div>')).toBe(true);
  });
});
