// #88 — структурный детектор интервью: разделение спикеров и роли рекрутер/кандидат
// БЕЗ LLM. Правило из гайда: кто задаёт вопросы — рекрутер, кто отвечает —
// кандидат; заголовок «Интервью: … (рекрутер) — …», если транскрипт уже подписан,
// важнее эвристики. Если разделения нет (один голос) или чередование нечитаемо —
// speakers_detected: false честно, без выдуманных ролей.
// Фикстуры — реальные записи клиента: два видео из primery-intervyu (подписаны
// «Владимир (рекрутер)/Кандидат») и два Zoom-транскрипта («Владимир/Дмитрий»,
// один вообще без таймкодов).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const interview = require('../../src/mcp-skills/tools/98b-interview.js');

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'interviews');
const SEPARATOR = '='.repeat(60);

const read = (name) => readFileSync(join(FIXTURES, name), 'utf8');
const parse = (name) => interview.parseTranscript(read(name));

const CASES = [
  { file: 'video-interveu-primer-1-transcript.txt', recruiter: 'Владимир (рекрутер)', candidate: 'Кандидат', turns: 15 },
  { file: 'video-interveu-primer-2-transcript.txt', recruiter: 'Владимир (рекрутер)', candidate: 'Кандидат', turns: 19 },
  { file: 'zoom-2026-09-18-interview-dmitry-transcript.txt', recruiter: 'Владимир', candidate: 'Дмитрий', turns: 18 },
  { file: 'zoom-2026-09-23-interview-candidate-transcript.txt', recruiter: 'Владимир', candidate: 'Кандидат', turns: 17 },
];

describe('structure detector on real interview transcripts', () => {
  for (const c of CASES) {
    it(`${c.file}: roles are found from the header`, () => {
      const { header, turns } = parse(c.file);
      const detection = interview.detectRoles(turns, header);

      expect(detection.speakers_detected).toBe(true);
      expect(detection.reason).toBe('заголовок');
      expect(detection.roles[c.recruiter]).toBe('recruiter');
      expect(detection.roles[c.candidate]).toBe('candidate');
      expect(turns).toHaveLength(c.turns);
      for (const turn of turns) expect(typeof turn.text).toBe('string');
    });

    it(`${c.file}: Q&A pattern alone still picks the recruiter`, () => {
      // Фолбэк на случай deepgram-пути (там заголовка ещё нет): вопросы считает
      // тот, кто задаёт их заметно больше — «здравствуйте» здесь ни при чём.
      const { turns } = parse(c.file);
      const detection = interview.detectRoles(turns, null);

      expect(detection.speakers_detected).toBe(true);
      expect(detection.reason).toBe('q&a');
      expect(detection.roles[c.recruiter]).toBe('recruiter');
      expect(detection.roles[c.candidate]).toBe('candidate');
    });
  }

  it('signed rows map 1:1 to {speaker, role, text, t} turns', () => {
    const { header, turns } = parse('video-interveu-primer-2-transcript.txt');
    const detection = interview.detectRoles(turns, header);

    expect(turns[0]).toEqual({ speaker: 'Владимир (рекрутер)', t: 2, text: expect.any(String) });
    expect(detection.roles[turns[0].speaker]).toBe('recruiter');
    expect(detection.roles[turns[1].speaker]).toBe('candidate');
    expect(turns.every(t => t.t == null || t.t >= 0)).toBe(true);
  });
});

describe('no separation — honest speakers_detected: false', () => {
  const singleSpeaker = interview.parseTranscript([
    'Интервью: Кандидат', 'Дата: 01.10.2026', SEPARATOR, '',
    '[0:00] Кандидат: Просто монолог про опыт.', '[0:30] Кандидат: И продолжение.', '',
  ].join('\n')).turns;

  it('one speaker (monologue / no diarization)', () => {
    const detection = interview.detectRoles(singleSpeaker, null);
    expect(detection.speakers_detected).toBe(false);
    expect(detection.roles).toEqual({});
    expect(detection.reason).toBe('один спикер');
  });

  it('two speakers without a readable question pattern', () => {
    const turns = interview.parseTranscript([
      'Интервью: Интервью', 'Дата: 01.10.2026', SEPARATOR, '',
      '[0:00] Спикер 0: Мы говорили о планах.', '[0:12] Спикер 1: Да, о планах.', '',
    ].join('\n')).turns;
    const detection = interview.detectRoles(turns, null);

    expect(detection.speakers_detected).toBe(false);
    expect(detection.reason).toBe('нечитаемое чередование');
    expect(detection.roles).toEqual({});
  });

  it('both speakers ask as much — ambiguous, no roles invented', () => {
    const turns = [
      { speaker: 0, t: 0, text: 'Что вы делали?' },
      { speaker: 1, t: 9, text: 'А что здесь важно?' },
      { speaker: 0, t: 20, text: 'Когда начнёте?' },
      { speaker: 1, t: 31, text: 'Как лучше связаться?' },
    ];
    const detection = interview.detectRoles(turns, null);

    expect(detection.speakers_detected).toBe(false);
    expect(detection.roles).toEqual({});
  });

  it('a signed header beats a misleading question pattern', () => {
    const { header, turns } = parse('zoom-2026-09-18-interview-dmitry-transcript.txt');
    // Кандидат в этом интервью тоже спрашивал — заголовок автора главнее.
    expect(interview.detectRoles(turns, header).roles).toEqual({ Дмитрий: 'candidate', Владимир: 'recruiter' });
  });
});
