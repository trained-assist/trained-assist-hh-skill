// Regression tests for candidate-message drafting that ignores the live dialogue.
//
// Bug: the background auto-draft (src/hh-scoring.js generateDraftMessages) built its
// prompt from the resume alone — a hardcoded "Напиши первое сообщение кандидату" —
// and never looked at the conversation. It also never ran the send guard. So a
// candidate who had already received our intro, answered it, and waited for a reply
// got a SECOND intro on the review page, re-asking the same questions, with no
// acknowledgement of what he actually wrote.
// Live case (30.09, vacancy 137012564): Леван Бахтадзе, negotiation 5610867713.
// We wrote 3 qualification questions at 11:49, he replied "здравствуйте, да" at
// 12:03, background scoring drafted at 12:15 — "Добрый день, Леван! Меня зовут
// Владимир, я рекрутер кадрового агентства HR Stalker…" — and because the draft was
// cached in ats_result, it was never refreshed again.
//
// Two more defects the same live case exposed:
//   * a vague answer ("да" to three questions) had no branch anywhere in the prompt
//     — no "thank you + clarify which question + re-ask", just a new question;
//   * a proposed slot may name a date without a time, which is what the recruiter
//     read as "the date is there but the time is not".

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  detectMessageType,
  buildDraftUserMessage,
  historySignature,
  isDraftStale,
} = require('../../src/hh-draft-message');
const { DEFAULT_MESSAGE_BASE } = require('../../src/hh-message-prompts');

// Real thread from HH (vacancy 137012564, negotiation 5610867713), trimmed to text.
const BAKHTADZE_HISTORY = [
  {
    hh_id: '15675384018',
    role: 'employer',
    text: 'Здравствуйте, Леван!\n\nМеня зовут Владимир, я рекрутер кадрового агентства HR Stalker…\nСколько клиентов вы сейчас ведёте?',
    timestamp: '2026-09-30T11:49:46+0300',
  },
  { hh_id: '15675691647', role: 'applicant', text: 'здравствуйте, да', timestamp: '2026-09-30T12:03:57+0300' },
];

const ATS = { score: 7.5, verdict: 'ПРОПУСТИТЬ', matched: ['Private Banking (МТС, БКС)'], gaps: ['средний чек клиента не указан'] };

describe('detectMessageType — one rule for all draft call sites', () => {
  it('empty thread is an intro', () => {
    expect(detectMessageType({ history: [] })).toBe('initial');
  });

  it('we wrote last and got no answer → follow-up, never a fresh intro', () => {
    expect(detectMessageType({ history: [BAKHTADZE_HISTORY[0]] })).toBe('followup');
  });

  it('candidate answered last → a reply to them, not a new letter', () => {
    expect(detectMessageType({ history: BAKHTADZE_HISTORY })).toBe('reply');
  });

  it('a vague answer is still a reply — it never becomes an intro', () => {
    expect(detectMessageType({
      history: [...BAKHTADZE_HISTORY, { role: 'applicant', text: 'да 🙂' }],
    })).toBe('reply');
  });

  it('messages without text (empty HH entries) do not count as an answer', () => {
    expect(detectMessageType({
      history: [BAKHTADZE_HISTORY[0], { hh_id: '1', role: 'applicant', text: '', timestamp: '' }],
    })).toBe('followup');
  });

  it('an explicit rejection request still wins', () => {
    expect(detectMessageType({ history: BAKHTADZE_HISTORY, forceType: 'rejection' })).toBe('rejection');
  });
});

describe('buildDraftUserMessage — the model sees the dialogue and the branch it is in', () => {
  const build = (over = {}) => buildDraftUserMessage({
    messageType: 'reply',
    firstName: 'Леван',
    atsResult: ATS,
    history: BAKHTADZE_HISTORY,
    ...over,
  });

  it('reply: carries the candidate’s actual words into the prompt', () => {
    const msg = build();
    expect(msg).toContain('Кандидат: здравствуйте, да');
    expect(msg).toContain('Рекрутер: Здравствуйте, Леван!');
  });

  it('reply: never asks for a first message', () => {
    expect(build()).not.toContain('первое сообщение');
  });

  it('reply: forbids a second self-introduction', () => {
    expect(build()).toMatch(/НЕ представляйся заново/i);
  });

  it('reply: a vague answer gets thank-you + "which question" + the questions again', () => {
    const msg = build();
    expect(msg).toMatch(/поблагодар/i);
    expect(msg).toMatch(/к какому из вопросов/i);
    expect(msg).toMatch(/заново/i);
  });

  it('reply: does not re-ask questions already answered in the thread', () => {
    expect(build()).toMatch(/НЕ повторяй вопросы, на которые/i);
  });

  it('initial: this is the only type that carries the resume', () => {
    const msg = build({ messageType: 'initial', resumeText: 'Опыт: МТС Банк, БКС' });
    expect(msg).toContain('Резюме:\nОпыт: МТС Банк, БКС');
    expect(build({ messageType: 'reply', resumeText: 'Опыт: МТС Банк' })).not.toContain('Резюме:');
  });

  it('followup: says the candidate has not answered, and forbids re-introducing', () => {
    const msg = build({ messageType: 'followup' });
    expect(msg).toMatch(/НЕ ответил/i);
    expect(msg).toMatch(/НЕ представляйся заново/i);
  });

  it('the ATS line stays in the prompt — verdict decides what we offer, not the type', () => {
    expect(build()).toContain('7.5/10');
    expect(build()).toContain('средний чек клиента не указан');
  });

  it('availability is appended verbatim when configured', () => {
    const msg = build({ availabilityBlock: '\n\nДоступность для звонка:\nДоступность рекрутера: четверг 15:00–17:00' });
    expect(msg).toContain('четверг 15:00–17:00');
  });
});

describe('system prompt: vague answer and complete slots', () => {
  it('has a branch for an answer that does not answer the questions', () => {
    expect(DEFAULT_MESSAGE_BASE).toMatch(/не ответил на (наши )?вопросы|ответ не по вопросам/i);
    expect(DEFAULT_MESSAGE_BASE).toMatch(/поблагодар/i);
  });

  it('a proposed slot must carry a time, not a bare date', () => {
    expect(DEFAULT_MESSAGE_BASE).toMatch(/дату и время/i);
  });

  it('still forbids inventing a time out of nowhere (#606 is not weakened)', () => {
    expect(DEFAULT_MESSAGE_BASE).toMatch(/НЕ придумывай время/i);
  });
});

describe('draft cache: a new candidate answer invalidates the stored draft', () => {
  const historyWith = (messages, atsResult = {}) => ({
    messages,
    ats_result: { score: 7.5, verdict: 'ПРОПУСТИТЬ', ...atsResult },
  });

  it('signature follows the last confirmed HH message', () => {
    expect(historySignature(BAKHTADZE_HISTORY)).toBe(historySignature([...BAKHTADZE_HISTORY]));
    expect(historySignature(BAKHTADZE_HISTORY)).not.toBe(
      historySignature([...BAKHTADZE_HISTORY, { hh_id: '15675699999', role: 'applicant', text: 'ок' }]),
    );
  });

  it('no draft at all → nothing to invalidate', () => {
    expect(isDraftStale({ messages: [], ats_result: { score: 7.5 } })).toBe(true);
  });

  it('a draft written before the candidate replied is stale', () => {
    // The live case: draft generated at 12:15 against a history whose last message
    // was our own; the candidate answered at 12:03 → the draft predates the answer.
    const h = historyWith(BAKHTADZE_HISTORY, {
      draft_message: 'Добрый день, Леван!',
      draft_history_sig: '15675384018',
    });
    expect(isDraftStale(h)).toBe(true);
  });

  it('a draft written against the current history is fresh', () => {
    const h = historyWith(BAKHTADZE_HISTORY, {
      draft_message: 'Спасибо за ответ, Леван!',
      draft_history_sig: historySignature(BAKHTADZE_HISTORY),
    });
    expect(isDraftStale(h)).toBe(false);
  });

  it('a legacy draft with no signature at all is regenerated once', () => {
    expect(isDraftStale(historyWith(BAKHTADZE_HISTORY, { draft_message: 'Добрый день!' }))).toBe(true);
  });
});

describe('no call site may build its own first-message prompt again', () => {
  // The single source of truth is src/hh-draft-message.js. A copy-pasted intro prompt
  // is how the live bug came back in the first place, so pin all three draft paths to
  // the shared builder.
  const srcDir = path.join(__dirname, '..', '..', 'src');
  const DRAFT_PATHS = ['hh-scoring.js', path.join('mcp-skills', 'tools', '90-hh.js'), 'hh-routes.js'];
  const code = rel => fs.readFileSync(path.join(srcDir, rel), 'utf8').replace(/^\s*\/\/.*$/gm, '');

  it('no module hardcodes the intro prompt', () => {
    const offenders = DRAFT_PATHS.filter(rel => code(rel).includes('Напиши первое сообщение'));
    expect(offenders).toEqual([]);
  });

  it('every draft path builds its message through the shared builder', () => {
    const missing = DRAFT_PATHS.filter(rel => !code(rel).includes('buildDraftUserMessage'));
    expect(missing).toEqual([]);
  });

  it('the shared builder is what all three call sites import', () => {
    const missing = DRAFT_PATHS.filter(rel => !code(rel).includes('hh-draft-message'));
    expect(missing).toEqual([]);
  });
});
