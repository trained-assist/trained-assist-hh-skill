// src/hh-vacancy-new-html.js — the /hh/vacancy-new page (#85): donut gauge,
// editable portrait form, «Сгенерировать АТС» wiring.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { vacancyNewPageHtml, donutSvg, FIELD_LABELS } = require('../../src/hh-vacancy-new-html.js');
const { emptyPortrait, normalizePortrait, computeCompleteness } = require('../../src/hh-portrait.js');

function filledPortrait() {
  return normalizePortrait({
    company: {
      name: 'ООО «Пример»', industry: 'Торговля', site: 'https://example.ru', founded_headcount: '2019',
      about: 'На рынке 6 лет', office_address: 'Москва', notable_clients: ['Клиент А'], contact_person: 'Оксана',
    },
    vacancy: {
      title: 'Маркетолог', headcount: 1, tags: ['продвижение на маркетплейсах'], work_format: 'Удалённо', location: 'Москва', reason: 'Расширение',
      workplace_address: 'Удаленно', reports_to: 'Собственнику', manages: 'Помощник',
      responsibilities: ['Ведение кабинетов WB'], programs: ['Excel'], expected_results: ['Рост продаж'],
      training: 'Да', career_growth: 'Да', probation_months: 3, salary_trial: '70000', salary_after: '100000',
      salary_total: '100000', schedule: '5/2', weekend_work: 'нет', business_trips: 'нет',
      employment_type: 'ТК РФ', perks: ['бонусы'],
    },
    requirements: {
      age: '25-35', gender: 'не важно', marital_status: 'нет', education: 'высшее', experience: 'от 2 лет',
      stop_factors: ['пассивность'], photo_required: false, hard_skills: ['SEO карточек'],
      soft_skills: ['Самостоятельность'], additional_info: 'ISTJ', selection_stages: ['скрининг'],
    },
  }, { vacancy_id: 'vac-1' });
}

describe('donutSvg', () => {
  it('draws two rings per section and shows the total percent', () => {
    const c = computeCompleteness(filledPortrait());
    const svg = donutSvg(c);
    expect(svg.match(/<circle/g)).toHaveLength(c.sections.length * 2);
    expect(svg).toContain(`>${c.percent}%<`);
    expect(c.percent).toBe(100);
  });

  it('renders an empty portrait as track-only rings at 0%', () => {
    const c = computeCompleteness(emptyPortrait());
    const svg = donutSvg(c);
    expect(svg.match(/<circle/g)).toHaveLength(c.sections.length); // только треки, fill = 0
    expect(svg).toContain('>0%<');
  });
});

describe('vacancyNewPageHtml', () => {
  it('empty state: input card + build button, no gauge or ATS button', () => {
    const html = vacancyNewPageHtml({ username: 'alice', token: 'tok', vacancyId: '' });
    expect(html).toContain('Собрать портрет');
    expect(html).toContain('id="src-vacancy"');
    expect(html).toContain('id="src-corr"');
    expect(html).toContain('var HAS_PORTRAIT = false');
    expect(html).not.toContain('id="btn-ats"');
    expect(html).not.toContain('id="gauge-card"');
    expect(html).toContain('<body>');
  });

  it('portrait state: gauge, form, save and ATS buttons, values prefilled via INIT', () => {
    const portrait = filledPortrait();
    const completeness = computeCompleteness(portrait);
    const html = vacancyNewPageHtml({ username: 'alice', token: 'tok', vacancyId: 'vac-1', portrait, completeness });
    expect(html).toContain('id="gauge-card"');
    expect(html).toContain('id="btn-ats"');
    expect(html).toContain('var HAS_PORTRAIT = true');
    expect(html).toContain('id="btn-save"');
    expect(html).toContain('Пересобрать портрет');
    expect(html).toContain('var INIT =');
    expect(html).toContain('Маркетолог'); // значение в INIT
    expect(html).toContain('data-block="requirements" data-field="hard_skills"');
    // INIT безопасен для </script>: угловые скобки экранированы
    const initLine = html.split('var INIT = ')[1] || '';
    expect(initLine.slice(0, 400)).not.toContain('<');
  });

  it('escapes hostile user data before it reaches the HTML', () => {
    const portrait = normalizePortrait({ vacancy: { title: '<img src=x onerror=alert(1)>' } }, { vacancy_id: 'v' });
    const html = vacancyNewPageHtml({ username: 'a', token: 't', vacancyId: 'v', portrait, completeness: computeCompleteness(portrait) });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('\\u003cimg src=x');
  });

  it('field labels come from the portrait schema (golden-standard form)', () => {
    expect(FIELD_LABELS['requirements.hard_skills']).toBe('Ключевые навыки / знания');
    expect(FIELD_LABELS['vacancy.headcount']).toBe('Количество вакансий');
  });
});
