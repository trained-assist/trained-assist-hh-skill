// Vacancy switcher on /hh/proactive, /hh/review and /hh/ats-editor: one dropdown with the
// full name + city + company instead of a wrap of truncated chips (agent 2026-09-29).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { vacancyPickerHtml, vacancyLabel } = require('../../src/hh-nav.js');
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
