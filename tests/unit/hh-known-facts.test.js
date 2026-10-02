// «Не переспрашивай то, что уже есть в резюме» — детерминированный гейт.
//
// Живой дефект 02.10.2026: письмо кандидату попросило уточнить имя, хотя имя было
// в резюме первой строкой и в скрининговом профиле. Правило против этого есть в
// промпте планировщика, но правило в промпте нарушается; здесь проверяется то,
// что можно проверить без модели: есть значение поля X в резюме и спрашивает ли
// письмо про X.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractKnownFacts, factsLine, asksKnownFact } = require('../../src/hh-known-facts');
const { buildDraftUserMessage } = require('../../src/hh-draft-message');
const { bullshitGuard } = require('../../src/hh-bullshit-guard');

// Форма src/hh-resume.js buildResumeText: заголовок «# Кандидат: …» и «Метка: значение».
const RESUME = [
  '# Кандидат: Потапова Татьяна',
  'Позиция: Старший финансовый советник',
  'Локация: Москва',
  'Зарплата: 400000 RUR',
  'График: гибрид',
  '',
  'Опыт работы:',
  '- SKYFORT CAPITAL (09.2024–06.2026): Head of Growth',
].join('\n');

describe('extractKnownFacts', () => {
  it('достаёт имя, город, зарплату и график из текста buildResumeText', () => {
    const facts = Object.fromEntries(extractKnownFacts(RESUME).map(f => [f.key, f.value]));
    expect(facts.name).toBe('Потапова Татьяна');
    expect(facts.location).toBe('Москва');
    expect(facts.salary).toBe('400000 RUR');
    expect(facts.schedule).toBe('гибрид');
  });

  it('заголовок «Кандидат» без ФИО — не факт', () => {
    expect(extractKnownFacts('# Кандидат: Кандидат').map(f => f.key)).not.toContain('name');
  });

  it('пустой текст и отсутствующие метки дают пустой список', () => {
    expect(extractKnownFacts('')).toEqual([]);
    expect(extractKnownFacts('просто описание опыта без меток')).toEqual([]);
  });

  it('телефон ловится по маске, даже если метки нет', () => {
    const facts = extractKnownFacts('Позвонить: +7 919 867-69-33');
    expect(facts.some(f => f.key === 'phone')).toBe(true);
  });
});

describe('factsLine', () => {
  it('собирает короткую строку для промпта', () => {
    expect(factsLine(RESUME)).toContain('имя: Потапова Татьяна');
    expect(factsLine(RESUME)).toContain('город: Москва');
  });

  it('пусто, когда фактов нет — блок в письме не появится', () => {
    expect(factsLine('')).toBe('');
  });
});

describe('asksKnownFact', () => {
  it('вопрос про имя при известном имени — нарушение', () => {
    expect(asksKnownFact('Екатерина, добрый день! Подскажите, пожалуйста, как вас зовут?', RESUME)?.key).toBe('name');
    expect(asksKnownFact('Уточните ваше имя и фамилию.', RESUME)?.key).toBe('name');
  });

  it('вопрос про город/зарплату/график при известных значениях — нарушение', () => {
    expect(asksKnownFact('В каком городе вы находитесь?', RESUME)?.key).toBe('location');
    expect(asksKnownFact('Какие у вас ожидания по зарплате?', RESUME)?.key).toBe('salary');
    expect(asksKnownFact('Какой график работы вам подходит?', RESUME)?.key).toBe('schedule');
  });

  it('простое упоминание факта без вопроса — не нарушение', () => {
    expect(asksKnownFact('Вижу, что вы в Москве — как вам гибрид?', RESUME)).toBeNull();
    expect(asksKnownFact('Зарплата 400000 нас устраивает, обсудим на созвоне.', RESUME)).toBeNull();
  });

  it('вопрос про неизвестное поле — это законное уточнение, не нарушение', () => {
    expect(asksKnownFact('Есть ли у вас опыт с ДУ и хедж-фондами?', RESUME)).toBeNull();
    expect(asksKnownFact('Как вас зовут?', 'Опыт: 5 лет в продажах')).toBeNull();
  });

  it('без текста резюме сравнивать не с чем', () => {
    expect(asksKnownFact('Как вас зовут?', '')).toBeNull();
  });
});

describe('bullshitGuard: гейт до LLM', () => {
  it('блокирует письмо, спрашивающее известный факт, и называет причину', async () => {
    const res = await bullshitGuard(
      'Добрый день! Уточните, пожалуйста, ваше имя.',
      [{ role: 'applicant', text: 'Здравствуйте' }],
      { resumeText: RESUME },
    );
    expect(res.ok).toBe(false);
    expect(res.checks.known_fact).toBe('name');
    expect(res.reason).toContain('уже известное');
  });

  it('пропускает письмо без такого вопроса (и не трогает остальные проверки)', async () => {
    const res = await bullshitGuard(
      'Есть ли у вас опыт с ДУ и хедж-фондами?',
      [],
      { resumeText: RESUME },
    );
    expect(res.ok).toBe(true);
    expect(res.checks.known_fact).toBe(false);
  });

  it('без resumeText гейт молчит — сравнивать не с чем', async () => {
    const res = await bullshitGuard('Как вас зовут?', []);
    expect(res.ok).toBe(true);
    expect(res.checks.known_fact).toBe(false);
  });
});

describe('buildDraftUserMessage: факты видны во всех типах писем', () => {
  it('в reply письмо попадает блок «Факты из резюме» и запрет переспрашивать', () => {
    const msg = buildDraftUserMessage({ messageType: 'reply', firstName: 'Татьяна', resumeText: RESUME });
    expect(msg).toContain('Факты из резюме');
    expect(msg).toContain('Потапова Татьяна');
    expect(msg).toContain('Не переспрашивай');
  });

  it('в initial остаётся полное резюме, дублировать короткий блок не нужно', () => {
    const msg = buildDraftUserMessage({ messageType: 'initial', firstName: 'Татьяна', resumeText: RESUME });
    expect(msg).toContain('Резюме:\n# Кандидат');
    expect(msg).not.toContain('Факты из резюме (уже известны):');
    expect(msg).toContain('Не переспрашивай');
  });

  it('когда фактов нет — ни блока, ни запрета в письме нет', () => {
    const msg = buildDraftUserMessage({ messageType: 'reply', firstName: 'Иван', resumeText: '' });
    expect(msg).not.toContain('Факты из резюме');
    expect(msg).not.toContain('Не переспрашивай');
  });
});
