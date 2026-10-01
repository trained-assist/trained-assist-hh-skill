// #88 (часть эпика #83) — формат транскрипта по гайду и склейка соседних реплик.
// Две вещи, которые должны быть точными в любой сессии:
//   1. рендер из сырого deepgram.json: заголовок «Интервью: …», Дата/Длительность,
//      реплики «[м:сс] Спикер: текст» — и побайтово как у клиента (см. фикстуры
//      fixtures/interviews/, они скопированы из ~/Documents/primery-intervyu);
//   2. соседние реплики одного спикера склеиваются, чужие — нет, таймкоды живые.
// Роли подписываются по Q&A-детектору; если разделения нет — «Спикер N», без выдумок.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const interview = require('../../src/mcp-skills/tools/98b-interview.js');

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'interviews');
const SEPARATOR = '='.repeat(60);
const RECRUITER = 'Владимир (рекрутер)';

const utterance = (speaker, start, transcript) => ({ speaker, start, transcript, end: start + 1 });
const deepgramJson = (utterances, duration = null) => ({
  metadata: duration == null ? {} : { duration },
  results: { utterances },
});

const render = (json, { candidate = 'Иван Иванов', date = '01.10.2026' } = {}) => {
  const turns = interview.turnsFromDeepgram(json);
  const detection = interview.detectRoles(turns, null);
  return interview.renderTranscript({
    title: detection.speakers_detected ? `${RECRUITER} — ${candidate}` : candidate,
    date,
    durationSec: json.metadata?.duration ?? null,
    rows: turns.map(t => ({
      label: interview.labelFor(t.speaker, detection.roles, candidate),
      t: t.t,
      text: t.text,
    })),
  });
};

describe('transcript rendering (guide format)', () => {
  it('writes the header, duration in minutes and one row per merged turn', () => {
    const json = deepgramJson([
      utterance(0, 0, 'Здравствуйте!'),
      utterance(0, 2.4, 'Расскажите о себе?'),
      utterance(1, 10, 'Пять лет на Node.js.'),
    ], 61);

    expect(render(json)).toBe([
      `Интервью: ${RECRUITER} — Иван Иванов`,
      'Дата: 01.10.2026',
      'Длительность: 1.0 мин',
      SEPARATOR,
      '',
      '[0:00] Владимир (рекрутер): Здравствуйте! Расскажите о себе?',
      '',
      '[0:10] Иван Иванов: Пять лет на Node.js.',
      '',
    ].join('\n'));
  });

  it('merges only neighbours of the same speaker and keeps their start timestamp', () => {
    const json = deepgramJson([
      utterance(0, 0, 'Вопрос первый?'),
      utterance(1, 5, 'Ответ.'),
      utterance(0, 9, 'Уточнение.'),
      utterance(0, 12, 'И ещё одно.'),
      utterance(1, 20, 'Второй ответ.'),
    ]);
    const rows = interview.turnsFromDeepgram(json);

    expect(rows).toHaveLength(4);
    expect(rows.map(r => [r.speaker, r.t])).toEqual([[0, 0], [1, 5], [0, 9], [1, 20]]);
    expect(rows[2].text).toBe('Уточнение. И ещё одно.');
    expect(rows[0].text).toBe('Вопрос первый?'); // свой спикер не склеивается с чужим
  });

  it('formats timestamps as [m:ss] with a padded second part', () => {
    expect(interview.fmtClock(0)).toBe('0:00');
    expect(interview.fmtClock(65)).toBe('1:05');
    expect(interview.fmtClock(65.9)).toBe('1:05');
    expect(interview.fmtClock(600)).toBe('10:00');
  });

  it('reproduces the client reference transcript from raw deepgram utterances', () => {
    // fixtures/interviews/*.deepgram-utterances.json — срезанные (без words/confidence)
    // сырые ответы Deepgram по двум видео клиента: ground truth по спикерам speaker: 0/1.
    for (const [index, turns] of [[1, 15], [2, 19]]) {
      const json = JSON.parse(readFileSync(join(FIXTURES, `video-interveu-primer-${index}.deepgram-utterances.json`), 'utf8'));
      const fixture = readFileSync(join(FIXTURES, `video-interveu-primer-${index}-transcript.txt`), 'utf8');
      const rows = interview.turnsFromDeepgram(json);
      const detection = interview.detectRoles(rows, null);

      expect(detection.speakers_detected).toBe(true);
      expect(detection.roles).toEqual({ 0: 'recruiter', 1: 'candidate' });
      expect(rows).toHaveLength(turns); // 130/127 utterance'ов → 15/19 склеенных реплик

      const mine = interview.renderTranscript({
        title: `Владимир (рекрутер) — Кандидат (пример ${index})`,
        date: '01.10.2026',
        durationSec: json.metadata.duration,
        rows: rows.map(t => ({ label: interview.labelFor(t.speaker, detection.roles, 'Кандидат'), t: t.t, text: t.text })),
      });
      const normalize = (text) => text.split('\n')
        .map((line) => (line.startsWith('Дата:') ? 'Дата:' : line.replace(/^=+$/, SEPARATOR)))
        .join('\n');

      expect(normalize(mine)).toBe(normalize(fixture));
    }
  });

  it('signs nothing when speakers are not separated: «Спикер N», plain header', () => {
    const json = deepgramJson([utterance(0, 0, 'Раз два три.')]);
    expect(render(json, { candidate: 'Иван Иванов' })).toBe([
      'Интервью: Иван Иванов',
      'Дата: 01.10.2026',
      `Длительность: неизвестна`,
      SEPARATOR,
      '',
      '[0:00] Спикер 0: Раз два три.',
      '',
    ].join('\n'));
  });

  it('falls back to a single text block when Deepgram returned no utterances', () => {
    const json = { metadata: { duration: 12 }, results: { channels: [{ alternatives: [{ transcript: 'Слышно плохо.' }] }] } };
    const turns = interview.turnsFromDeepgram(json);

    expect(turns).toEqual([{ speaker: 0, t: 0, text: 'Слышно плохо.' }]);
    expect(interview.detectRoles(turns, null).speakers_detected).toBe(false);
  });
});

describe('parseTranscript — reading an existing transcript', () => {
  it('reads [m:ss] rows, keeps the header and joins continuation lines', () => {
    const { header, turns } = interview.parseTranscript([
      'Интервью: Владимир (рекрутер) — Кандидат',
      'Дата: 23.09.2026',
      'Длительность: 7.4 мин',
      SEPARATOR,
      '',
      '[0:00] Владимир (рекрутер): Здравствуйте?',
      '',
      '[0:24] Кандидат: Ответ',
      'продолжение.',
    ].join('\n'));

    expect(header).toBe('Интервью: Владимир (рекрутер) — Кандидат');
    expect(turns).toEqual([
      { speaker: 'Владимир (рекрутер)', t: 0, text: 'Здравствуйте?' },
      { speaker: 'Кандидат', t: 24, text: 'Ответ продолжение.' },
    ]);
  });

  it('reads rows without timestamps (Zoom example format)', () => {
    const { turns } = interview.parseTranscript([
      'Интервью: Владимир (рекрутер) — Дмитрий (кандидат)',
      'Дата: 18.09.2026',
      SEPARATOR,
      '',
      'Дмитрий: Да, могу объяснить.',
      'Владимир: А почему уходите?',
    ].join('\n'));

    expect(turns).toEqual([
      { speaker: 'Дмитрий', t: null, text: 'Да, могу объяснить.' },
      { speaker: 'Владимир', t: null, text: 'А почему уходите?' },
    ]);
  });

  it('round-trips a rendered transcript back into the same turns', () => {
    const json = deepgramJson([
      utterance(0, 0, 'Вопрос?'),
      utterance(1, 7, 'Ответ.'),
    ], 61);
    const parsed = interview.parseTranscript(render(json, { candidate: 'Кандидат' }));

    expect(parsed.turns).toEqual([
      { speaker: RECRUITER, t: 0, text: 'Вопрос?' },
      { speaker: 'Кандидат', t: 7, text: 'Ответ.' },
    ]);
  });
});
