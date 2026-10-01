// src/hh-doc-classify.js — детерминированная классификация документов кандидата (#87).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { classifyDoc, TYPES, TYPE_LABELS } = require('../../src/hh-doc-classify.js');

const RESUME_TEXT = `Опыт работы
2023 – 2025 ООО «Пример», маркетолог
- продвижение карточек
06/2019 — 08/2021 ООО «Другое»
Навыки: Excel, SEO
Образование: МГУ, 2018`;

const COVER_TEXT = `Добрый день, меня зовут Анна!

Последние 6 лет занимаюсь управлением проектами в маркетинге: выстраивала процессы, координировала команды, вела проекты от брифа до финальной аналитики.

Буду рада подробнее рассказать о своём опыте.
Спасибо!
Анна`;

const CORR_TEXT = `14:32 Владимир: Здравствуйте! Посмотрели резюме?
14:35 Анна: Здравствуйте, да, спасибо!
14:40 Владимир: Расскажите про опыт с маркетплейсами
14:52 Анна: Опыт есть, вела кабинеты два года`;

const INTERVIEW_TEXT = `Интервью: Владимир (рекрутер) — Анна
Дата: 01.10.2026
============================================================

[0:00] Владимир: Здравствуйте, расскажите об опыте?
[0:24] Анна: Последние два года вела проекты по маркетингу`;

const DIALOG_TEXT = `Рекрутер: Какой у вас опыт?
Кандидат: Пять лет в продажах.
Рекрутер: А командой управляли?
Кандидат: Да, команда пять человек.`;

describe('classifyDoc', () => {
  it('exposes the type vocabulary the client defined', () => {
    expect(TYPES).toEqual(['resume', 'cover_letter', 'correspondence', 'interview', 'portfolio', 'photo', 'other']);
    for (const t of TYPES) expect(TYPE_LABELS[t]).toBeTruthy();
  });

  it('resume: sections + date ranges', () => {
    const r = classifyDoc({ filename: 'cv.pdf', text: RESUME_TEXT });
    expect(r.type).toBe('resume');
    expect(r.detected_by).toBe('rules');
  });

  it('resume: two date ranges without section headers', () => {
    const r = classifyDoc({ filename: 'x.txt', text: '2019 – 2021 ООО А\n2021 – 2024 ООО Б\nделал то и это' });
    expect(r.type).toBe('resume');
  });

  it('cover letter: greeting, no work history (клиентское правило)', () => {
    const r = classifyDoc({ filename: 'letter.txt', text: COVER_TEXT });
    expect(r.type).toBe('cover_letter');
  });

  it('correspondence: message-thread markers', () => {
    const r = classifyDoc({ filename: 'chat.txt', text: CORR_TEXT });
    expect(r.type).toBe('correspondence');
  });

  it('interview: «Интервью:» header', () => {
    expect(classifyDoc({ filename: 't.txt', text: INTERVIEW_TEXT }).type).toBe('interview');
  });

  it('interview: timestamps [м:сс]', () => {
    expect(classifyDoc({ filename: 't.txt', text: '[0:00] Привет\n[0:12] Расскажи' }).type).toBe('interview');
  });

  it('interview: speaker turns with questions', () => {
    expect(classifyDoc({ filename: 't.txt', text: DIALOG_TEXT }).type).toBe('interview');
  });

  it('interview: by audio/video extension (no text needed)', () => {
    expect(classifyDoc({ filename: 'video.mp4' }).type).toBe('interview');
    expect(classifyDoc({ filename: 'audio.m4a' }).type).toBe('interview');
  });

  it('photo by image extension, portfolio by filename/archive', () => {
    expect(classifyDoc({ filename: 'photo.jpg' }).type).toBe('photo');
    expect(classifyDoc({ filename: 'portfolio-anna.zip' }).type).toBe('portfolio');
    expect(classifyDoc({ filename: 'Моё портфолио.pdf' }).type).toBe('portfolio');
  });

  it('falls back to other when rules are not confident', () => {
    const long = 'какой-то длинный текст без дат и секций. '.repeat(120);
    expect(classifyDoc({ filename: 'note.txt', text: long }).type).toBe('other');
  });
});
