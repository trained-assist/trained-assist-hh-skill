// Unit tests for src/hh-letter-checks.js — the deterministic checks behind the
// "the letter must not name requirements nobody recorded" rule (issue #198).
//
// Everything here is strings and regexes: no LLM, no network. The rule must be
// explainable — every false positive here breaks a real letter.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const checks = require('../../src/hh-letter-checks.js');

const CRITERIA = [
  'Высшее профильное образование (химия, химическая технология, материаловедение)',
  'Опыт работы с лакокрасочными материалами',
];
const VACANCY = 'Разработка состава для обработки срезов ДСП и МДФ. Расчётные характеристики, не лабораторные результаты.';

describe('normalize', () => {
  it('lowercases, folds ё and drops punctuation', () => {
    expect(checks.normalize('Опыт: ЛКП, ДСП/МДФ!')).toBe('опыт лкп дсп мдф');
  });
});

describe('requirementClaims', () => {
  it('finds a requirement with a subject', () => {
    const claims = checks.requirementClaims('Обязательно высшее профильное образование.');
    expect(claims).toHaveLength(1);
    expect(claims[0].words).toContain('образование');
  });

  it('ignores a polite request that is not a requirement about the candidate', () => {
    expect(checks.requirementClaims('Обязательно ответьте, если вам удобно созвониться.')).toHaveLength(0);
  });

  it('ignores a question about the candidate', () => {
    expect(checks.requirementClaims('Расскажите, пожалуйста, про ваш опыт работы.')).toHaveLength(0);
  });

  it('keeps numbers as meaningful words', () => {
    const claims = checks.requirementClaims('Требуется опыт работы не менее 3 лет.');
    expect(claims[0].words).toContain('3');
  });
});

describe('findInventedRequirements', () => {
  it('accepts a requirement taken from the criteria', () => {
    const invented = checks.findInventedRequirements(
      'Обязательно высшее профильное образование — химия, химическая технология или материаловедение.',
      CRITERIA,
    );
    expect(invented).toHaveLength(0);
  });

  it('flags a requirement that exists nowhere', () => {
    const invented = checks.findInventedRequirements(
      'Требуется опыт работы в НИИ не менее 5 лет.',
      CRITERIA,
    );
    expect(invented).toHaveLength(1);
    expect(invented[0].missing.join(' ')).toMatch(/нии|5/);
  });

  it('flags an invented certification the vacancy never asked for', () => {
    const invented = checks.findInventedRequirements(
      'Обязательно наличие действующего сертификата по ГОСТ Р.',
      [...CRITERIA, VACANCY],
    );
    expect(invented).toHaveLength(1);
    expect(invented[0].sentence).toMatch(/сертификат/i);
  });

  it('does not check anything without sources — there is nothing to compare with', () => {
    expect(checks.findInventedRequirements('Требуется опыт работы в НИИ не менее 5 лет.', [])).toHaveLength(0);
  });

  it('a letter that states no requirement is never flagged', () => {
    expect(checks.findInventedRequirements(
      'Здравствуйте! Спасибо за отклик. Посмотрите материалы, напишите, когда будет удобно созвониться.',
      CRITERIA,
    )).toHaveLength(0);
  });

  it('a requirement the recruiter already stated earlier in the thread is not invented', () => {
    const invented = checks.findInventedRequirements(
      'Как мы и договаривались, обязателен диплом по химической технологии.',
      [...CRITERIA, 'Обязателен диплом по химической технологии.'],
    );
    expect(invented).toHaveLength(0);
  });
});

describe('requirementSources', () => {
  it('collects criteria names, vacancy context and title', () => {
    const sources = checks.requirementSources({
      atsConfig: {
        required: ['Высшее образование', { name: 'Опыт с ЛКП' }],
        preferred: [{ skill: 'Python' }],
        vacancy_title: 'Химик-технолог',
        vacancy_context: 'Состав для обработки срезов ДСП.',
      },
      vacancyContext: 'Описание из HH.',
    });
    expect(sources).toEqual(expect.arrayContaining([
      'Высшее образование', 'Опыт с ЛКП', 'Python', 'Химик-технолог', 'Состав для обработки срезов ДСП.', 'Описание из HH.',
    ]));
  });

  it('reads the legacy { item: [...] } shape of the criteria lists', () => {
    const sources = checks.requirementSources({ atsConfig: { required: { item: ['Диплом'] } } });
    expect(sources).toContain('Диплом');
  });
});
