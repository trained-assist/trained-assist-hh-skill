// Unit tests for src/hh-portrait.js — schema, completeness, ATS derivation, storage.
// No LLM, no network: extraction is covered by the L2 behavior fixture.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const {
  SECTIONS,
  emptyPortrait,
  normalizePortrait,
  computeCompleteness,
  buildAtsFromPortrait,
  portraitFile,
  readPortrait,
  writePortrait,
} = require('../../src/hh-portrait.js');

function filledPortrait() {
  const p = emptyPortrait();
  p.company = {
    name: 'ООО «Пример»', industry: 'Торговля', site: 'https://example.ru', founded_headcount: '2019, 15 человек',
    about: 'На рынке 6 лет', office_address: 'г. Москва', notable_clients: ['Клиент А'], contact_person: 'Оксана',
  };
  p.vacancy = {
    title: 'Маркетолог', headcount: 1, tags: ['продвижение на маркетплейсах'], work_format: 'Удалённо', location: 'Москва', reason: 'Расширение',
    workplace_address: 'Удаленно', reports_to: 'Собственнику', manages: 'Помощник',
    responsibilities: ['Ведение кабинетов WB'], programs: ['Excel'], expected_results: ['Рост продаж'],
    training: 'Да', career_growth: 'Да', probation_months: 3, salary_trial: '70000 ₽', salary_after: '100000 ₽',
    salary_total: '100000 ₽', schedule: '5/2', weekend_work: 'нет', business_trips: 'нет',
    employment_type: 'ТК РФ', perks: ['бонусы'],
  };
  p.requirements = {
    age: '25-35', gender: 'не важно', marital_status: 'не принципиально', education: 'высшее',
    experience: 'от 2 лет в маркетинге', stop_factors: ['пассивность'], photo_required: false,
    hard_skills: ['SEO карточек', 'Аналитика'], soft_skills: ['Самостоятельность'], additional_info: 'ISTJ',
    selection_stages: ['Телефонное интервью'],
  };
  return p;
}

describe('normalizePortrait', () => {
  it('drops unknown keys and trims strings', () => {
    const out = normalizePortrait({
      company: { name: '  ООО «Тест»  ', bogus: 'мусор' },
      vacancy: { title: 'Логист', perks: 'Корпоративные мероприятия\nОплата больничного' },
      requirements: { hard_skills: ['  ', 'Этран'], photo_required: false },
      nonsense_top: true,
    }, { sources: ['vacancy'], vacancy_id: 'v-1' });

    expect(out.nonsense_top).toBeUndefined();
    expect(out.company.name).toBe('ООО «Тест»');
    expect(out.company.bogus).toBeUndefined();
    expect(out.vacancy.title).toBe('Логист');
    expect(out.vacancy.perks).toEqual(['Корпоративные мероприятия', 'Оплата больничного']);
    expect(out.requirements.hard_skills).toEqual(['Этран']);
    expect(out.requirements.photo_required).toBe(false);
    expect(out.meta.sources).toEqual(['vacancy']);
    expect(out.meta.vacancy_id).toBe('v-1');
    expect(out.meta.version).toBe(1);
  });

  it('empty strings and dashes become null, empty lists become []', () => {
    const out = normalizePortrait({ company: { name: '   ', site: '-' }, requirements: { soft_skills: '' } });
    expect(out.company.name).toBeNull();
    expect(out.company.site).toBeNull();
    expect(out.requirements.soft_skills).toEqual([]);
    expect(out.vacancy.title).toBeNull();
  });

  it('preserves created_at when provided (force-rebuild keeps history)', () => {
    const out = normalizePortrait({ vacancy: { title: 'X' } }, { created_at: '2026-01-01T00:00:00.000Z' });
    expect(out.meta.created_at).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('computeCompleteness', () => {
  it('empty portrait is 0% with every field missing', () => {
    const c = computeCompleteness(emptyPortrait());
    expect(c.sections).toHaveLength(SECTIONS.length);
    expect(c.percent).toBe(0);
    const totalFields = SECTIONS.reduce((s, x) => s + x.fields.length, 0);
    expect(c.missing_flat).toHaveLength(totalFields);
    expect(c.sections.every(s => s.filled === 0 && s.percent === 0)).toBe(true);
  });

  it('fully filled portrait is 100% with no gaps', () => {
    const c = computeCompleteness(filledPortrait());
    expect(c.percent).toBe(100);
    expect(c.missing_flat).toEqual([]);
    expect(c.sections.every(s => s.percent === 100)).toBe(true);
    expect(c.sections.reduce((s, x) => s + x.total, 0)).toBe(41);
  });

  it('whitespace strings, empty arrays and nulls count as missing; explicit false counts as answered', () => {
    const p = filledPortrait();
    p.vacancy.schedule = '   ';
    p.requirements.hard_skills = [];
    const c = computeCompleteness(p);
    expect(c.percent).toBe(95); // 41 поле, 2 пустых
    expect(c.missing_flat).toEqual([
      'Зарплата и условия: График работы',
      'Hard skills: Ключевые навыки / знания',
    ]);
    // photo_required: false — ответ «нет», а не пропуск
    const stop = c.sections.find(s => s.key === 'stop_process');
    expect(stop.filled).toBe(stop.total);
  });

  it('each section exposes donut data: weight, filled, total, percent, missing', () => {
    const c = computeCompleteness(filledPortrait());
    for (const s of c.sections) {
      expect(s.weight).toBe(s.total);
      expect(s.percent).toBe(100);
      expect(s.missing).toEqual([]);
      expect(typeof s.label).toBe('string');
    }
  });
});

describe('buildAtsFromPortrait', () => {
  it('required = hard skills (weight 2), preferred = soft skills (weight 1), no knockout', () => {
    const cfg = buildAtsFromPortrait(filledPortrait(), 'v-1');
    expect(cfg.knockout).toBeUndefined();
    expect(cfg.required).toEqual([
      { name: 'SEO карточек', weight: 2 },
      { name: 'Аналитика', weight: 2 },
    ]);
    expect(cfg.preferred).toEqual([{ name: 'Самостоятельность', weight: 1 }]);
    expect(cfg.pass_threshold).toBe(6.5);
    expect(cfg.review_threshold).toBe(4);
    expect(cfg.vacancy_id).toBe('v-1');
    expect(cfg.vacancy_title).toBe('Маркетолог');
    expect(cfg.source).toBe('portrait');
  });

  it('falls back to company programs when hard skills are missing', () => {
    const p = filledPortrait();
    p.requirements.hard_skills = [];
    const cfg = buildAtsFromPortrait(p, null);
    expect(cfg.required).toEqual([{ name: 'Excel', weight: 2 }]);
  });

  it('derives filters from the portrait', () => {
    const cfg = buildAtsFromPortrait(filledPortrait(), 'v-1');
    expect(cfg.filters.min_experience_years).toBe(2);
    expect(cfg.filters.remote_ok).toBe(true);
    expect(cfg.filters.salary_max_rub).toBe(100000);
  });

  it('salary in thousands ("70 т.р.") is normalized to rubles', () => {
    const p = filledPortrait();
    p.vacancy.salary_after = '70 т.р.';
    p.vacancy.salary_total = null;
    expect(buildAtsFromPortrait(p, null).filters.salary_max_rub).toBe(70000);
  });

  it('vacancy_context carries title, salary and top responsibilities', () => {
    const cfg = buildAtsFromPortrait(filledPortrait(), null);
    expect(cfg.vacancy_context).toContain('Маркетолог');
    expect(cfg.vacancy_context).toContain('100000 ₽');
    expect(cfg.vacancy_context).toContain('Ведение кабинетов WB');
    expect(cfg.vacancy_context.length).toBeLessThanOrEqual(1200);
  });
});

describe('storage', () => {
  it('round-trips a portrait through contexts/hh/portrait:{id}.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-portrait-'));
    try {
      expect(readPortrait(dir, 'v-9')).toBeNull();
      expect(portraitFile(dir, 'v-9')).toBe(path.join(dir, 'contexts', 'hh', 'portrait:v-9.json'));

      const saved = writePortrait(dir, 'v-9', filledPortrait());
      expect(saved.meta.vacancy_id).toBe('v-9');

      const raw = JSON.parse(fs.readFileSync(portraitFile(dir, 'v-9'), 'utf8'));
      expect(raw.value.meta.vacancy_id).toBe('v-9');
      expect(typeof raw.updated_at).toBe('string');

      const loaded = readPortrait(dir, 'v-9');
      expect(loaded.vacancy.title).toBe('Маркетолог');
      expect(computeCompleteness(loaded).percent).toBe(100);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('corrupt file reads as null instead of throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-portrait-'));
    try {
      fs.mkdirSync(path.dirname(portraitFile(dir, 'v-1')), { recursive: true });
      fs.writeFileSync(portraitFile(dir, 'v-1'), 'не json');
      expect(readPortrait(dir, 'v-1')).toBeNull();
      // контейнер без value-объекта схемы тоже не должен выдавать «портрет»
      fs.writeFileSync(portraitFile(dir, 'v-1'), JSON.stringify({ value: 'строка' }));
      expect(readPortrait(dir, 'v-1')).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Поле tags (#133): тематические теги вакансии как данные для отбора фактов ──

describe('vacancy.tags', () => {
  it('normalizes a raw string into a list, empty into [], junk dropped', () => {
    const out = normalizePortrait({
      vacancy: {
        title: 'WB',
        tags: 'продвижение на маркетплейсах; SEO карточек\n \nаналитика продаж',
      },
    });
    expect(out.vacancy.tags).toEqual(['продвижение на маркетплейсах', 'SEO карточек', 'аналитика продаж']);
    expect(normalizePortrait({ vacancy: { tags: null } }).vacancy.tags).toEqual([]);
    expect(normalizePortrait({ vacancy: { tags: '  ' } }).vacancy.tags).toEqual([]);
  });

  it('shows up in the completeness gauge as its own section', () => {
    const without = computeCompleteness(emptyPortrait());
    const sec = without.sections.find(s => s.key === 'tags');
    expect(sec).toBeDefined();
    expect(sec.label).toBe('Теги вакансии');
    expect(sec.missing.map(m => m.field)).toEqual(['vacancy.tags']);

    const p = filledPortrait();
    expect(computeCompleteness(p).sections.find(s => s.key === 'tags').percent).toBe(100);
  });

  it('round-trips through the portrait file (normalize → write → read)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-portrait-tags-'));
    try {
      const saved = writePortrait(dir, 'v-tags', { vacancy: { title: 'WB', tags: ['маркетплейсы', 'SEO'] } });
      expect(saved.vacancy.tags).toEqual(['маркетплейсы', 'SEO']);
      const loaded = readPortrait(dir, 'v-tags');
      expect(loaded.vacancy.tags).toEqual(['маркетплейсы', 'SEO']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unknown tag keys are still dropped (schema stays closed)', () => {
    const out = normalizePortrait({ vacancy: { tags: ['ok'], tag_weights: { a: 1 } } });
    expect(out.vacancy.tags).toEqual(['ok']);
    expect(out.vacancy.tag_weights).toBeUndefined();
  });
});
