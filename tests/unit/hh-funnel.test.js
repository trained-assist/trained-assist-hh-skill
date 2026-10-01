// Regression tests for the funnel state machine (src/hh-funnel.js) and the
// criteria guard (src/hh-criteria-guard.js) — both added 01.10.2026 after the
// owner reviewed the ATS config of vacancy «Менеджер по продвижению на
// Wildberries» (138004863) and rejected it as "абстрактные неизмеримые критерии".
//
// Three defects these tests lock down:
//
//  1. Criteria quality is a prompt instruction, which the model ignores on
//     regeneration. «аналитический склад ума» scored 1–2/3 for every candidate,
//     so the verdict carried no information. The guard must catch it by regex
//     (free) AND by LLM (whatever regex misses) — and the extraction path must
//     drop what the guard flags.
//  2. Deciding what to do and writing the letter were one prompt. The owner's
//     process is a fixed step set, and "nothing to do yet" is one of the steps:
//     a candidate we wrote to two hours ago must NOT get a second letter from the
//     background loop. That is a deterministic rule, not a model judgement.
//  3. The test task must leave word-for-word. It is assembled in code; a model
//     paraphrase would break the promise the vacancy text makes.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ACTIONS,
  VALID_ACTIONS,
  deterministicStep,
  planNextStep,
  buildActionInstruction,
  buildTestTaskMessage,
  testTaskWasSent,
  FUNNEL_LOGIC_VERSION,
} = require('../../src/hh-funnel');
const { checkCriteria, dropViolations, findVagueByRegex } = require('../../src/hh-criteria-guard');
const { applyCriteriaGuard } = require('../../src/hh-criteria-apply');
const { isDraftStale, historySignature, buildDraftUserMessage } = require('../../src/hh-draft-message');

const DAY = 86400000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

// ── Criteria guard ──────────────────────────────────────────────────────────

describe('criteria guard — regex pass', () => {
  // Every one of these shipped to production on vacancy 138004863 and was useless.
  const REAL_MESS = [
    'аналитический склад ума',
    'понимание товара и трендов',
    'неумение анализировать и развивать карточки товаров',
    'отсутствие опыта работы с Wildberries менее 2 лет',
    'постановка ТЗ подрядчикам',
    'умеет работать в команде',
    'ответственность',
    'навыки коммуникации',
  ];
  for (const name of REAL_MESS) {
    it(`flags «${name}»`, () => {
      expect(findVagueByRegex(name)).toBeTruthy();
    });
  }

  it('keeps what the owner explicitly said works', () => {
    // «Вот это бы сработало» — verbatim from the review, 01.10.2026.
    const GOOD = [
      'знание метрик рекламы WB: ставки, ДРР, поисковая выдача',
      'опыт настройки SEO и оптимизации карточки на ВБ',
      'опыт работы с одеждой на WB',
      'ведение рекламного кабинета WB с бюджетом от 30 тыс ₽/мес',
      'настройка внутренней рекламы WB',
    ];
    for (const name of GOOD) {
      expect(findVagueByRegex(name), name).toBeNull();
    }
  });
});

describe('criteria guard — LLM pass and cleanup', () => {
  it('flags what regex misses and returns a replacement', async () => {
    const config = { required: [{ name: 'управление ассортиментом карточек' }], preferred: [] };
    const llmCall = async () => JSON.stringify({
      items: [{ name: 'управление ассортиментом карточек', vague: true, why: 'нет ни инструмента, ни цифры', replacement: 'ведение карточек WB: CTR, ДРР, оборачиваемость' }],
    });
    const res = await checkCriteria(config, { useLlm: true, apiKey: 'k', llmCall });
    expect(res.ok).toBe(false);
    expect(res.violations[0].source).toBe('llm');
    expect(res.violations[0].suggestion).toContain('оборачиваемость');
  });

  it('drops only the flagged criteria', () => {
    const config = {
      required: [{ name: 'аналитический склад ума', weight: 1.5 }, { name: 'настройка рекламы WB', weight: 3 }],
      preferred: [{ name: 'знание метрик WB', weight: 1 }],
    };
    const violations = [{ field: 'required', name: 'аналитический склад ума' }];
    const cleaned = dropViolations(config, violations);
    expect(cleaned.required.map(c => c.name)).toEqual(['настройка рекламы WB']);
    expect(cleaned.preferred).toHaveLength(1);
  });

  it('degrades to regex-only without a key instead of failing', async () => {
    const res = await checkCriteria(
      { required: [{ name: 'аналитический склад ума' }, { name: 'настройка рекламы WB' }] },
      { useLlm: true, apiKey: null, username: 'nobody-without-a-token' },
    );
    expect(res.degraded).toBe(true);
    // regex still did its job
    expect(res.violations.map(v => v.name)).toEqual(['аналитический склад ума']);
  });
});

// ── Deterministic rules ─────────────────────────────────────────────────────

describe('funnel — deterministic rules run before any LLM', () => {
  it('first contact asks about the missing skills', () => {
    const step = deterministicStep({ history: [], atsConfig: {} });
    expect(step.action).toBe('ask_skills');
    expect(step.by).toBe('rule');
  });

  it('does NOT write again when we spoke last and the candidate is silent', () => {
    // The regression the owner asked for: "Ничего не делать, может быть".
    const step = deterministicStep({
      history: [{ role: 'employer', text: 'Здравствуйте!', timestamp: iso(3600 * 1000) }],
      atsConfig: {},
    });
    expect(step.action).toBe('wait');
  });

  it('nudges only after two days of silence', () => {
    const step = deterministicStep({
      history: [{ role: 'employer', text: 'Здравствуйте!', timestamp: iso(3 * DAY) }],
      atsConfig: {},
    });
    expect(step.action).toBe('followup');
  });

  it('rejects a candidate under the cutoff without asking the model', () => {
    const step = deterministicStep({
      history: [{ role: 'applicant', text: 'да', timestamp: iso(1000) }],
      atsResult: { verdict: 'ОТКЛОНИТЬ', score: 2 },
      atsConfig: { review_threshold: 4 },
    });
    expect(step.action).toBe('reject');
  });

  it('moves to the call once the test task was sent and answered, score is high', () => {
    const testTask = 'Откройте витрину и сверьте с гайдом.';
    const step = deterministicStep({
      history: [
        { role: 'employer', text: 'Готовы к тестовому?', timestamp: iso(2 * DAY) },
        { role: 'applicant', text: 'Готов, вот мои замечания', timestamp: iso(DAY) },
        { role: 'employer', text: testTask, timestamp: iso(DAY - 1000) },
        { role: 'applicant', text: 'Сделал, вот разбор', timestamp: iso(1000) },
      ],
      atsResult: { verdict: 'ПРОПУСТИТЬ', score: 8 },
      atsConfig: { pass_threshold: 6.5, test_task: testTask },
    });
    expect(step.action).toBe('invite_call');
  });

  it('never offers a test task the vacancy does not have', () => {
    const plan = deterministicStep({
      history: [{ role: 'applicant', text: 'Подтверждаю навыки', timestamp: iso(1000) }],
      atsResult: { verdict: 'ПРОПУСТИТЬ', score: 9 },
      atsConfig: { pass_threshold: 6.5 },
    });
    // No rule decides here, so the planner would be asked — and the prompt forbids
    // proposing a test task that is not in the config. The guard is the absence of
    // the offer, asserted through the instruction text.
    expect(plan?.action || 'llm').toBe('llm');
    expect(buildActionInstruction('propose_test')).toContain('Сам текст задания НЕ приводи');
  });
});

describe('funnel — test task is detected by its own text', () => {
  const TASK = 'Откройте витрину бренда и сверьте её с гайдом по карточкам.';

  it('recognises the task in the thread despite punctuation noise', () => {
    const sent = testTaskWasSent(
      [{ role: 'employer', text: `Тестовое задание.\n\n${TASK}\n\nСрок — два рабочих дня.` }],
      TASK,
    );
    expect(sent).toBe(true);
  });

  it('is false when the task was never sent', () => {
    expect(testTaskWasSent([{ role: 'employer', text: 'Здравствуйте, готовы к тестовому?' }], TASK)).toBe(false);
  });

  it('ignores an empty config value instead of matching everything', () => {
    expect(testTaskWasSent([{ role: 'employer', text: 'любой текст' }], '')).toBe(false);
  });
});

// ── Planner ─────────────────────────────────────────────────────────────────

describe('funnel — planner output', () => {
  it('accepts only the closed action set', async () => {
    const llmCall = async () => JSON.stringify({ action: 'invite_call', reason: 'всё подтверждено' });
    const plan = await planNextStep({
      history: [{ role: 'applicant', text: 'Подтверждаю', timestamp: iso(1000) }],
      atsResult: { verdict: 'ПРОПУСТИТЬ', score: 9, gaps: [] },
      atsConfig: { pass_threshold: 6.5 },
      apiKey: 'k',
      llmFn: llmCall,
    });
    expect(plan.action).toBe('invite_call');
    expect(plan.by).toBe('llm');
    expect(VALID_ACTIONS).toContain(plan.action);
  });

  it('falls back to wait on a hallucinated action', async () => {
    const llmCall = async () => JSON.stringify({ action: 'send_the_contract', reason: '...' });
    const plan = await planNextStep({
      history: [{ role: 'applicant', text: 'да', timestamp: iso(1000) }],
      atsResult: { verdict: 'ПРОПУСТИТЬ', score: 9 },
      atsConfig: {},
      apiKey: 'k',
      llmFn: llmCall,
    });
    expect(plan.action).toBe('wait');
  });

  it('degrades to wait when the planner is unavailable — never invents a step', async () => {
    const plan = await planNextStep({
      history: [{ role: 'applicant', text: 'да', timestamp: iso(1000) }],
      atsResult: { verdict: 'ПРОПУСТИТЬ', score: 9 },
      atsConfig: {},
      apiKey: 'k',
      llmFn: async () => { throw new Error('boom'); },
    });
    expect(plan.action).toBe('wait');
    expect(plan.degraded).toBe(true);
  });
});

// ── Writing step ────────────────────────────────────────────────────────────

describe('funnel — the writer renders the step, it does not choose it', () => {
  it('asks about exactly the missing skills the planner named', () => {
    const instruction = buildActionInstruction('ask_skills', {
      missingSkills: ['знание метрик WB', 'опыт SEO-оптимизации карточки'],
    });
    expect(instruction).toContain('Нужно уточнить');
    expect(instruction).toContain('знание метрик WB');
    expect(instruction).toContain('опыт SEO-оптимизации карточки');
  });

  it('a vague reply must trigger the three-step clarification', () => {
    const instruction = buildActionInstruction('clarify_answer');
    expect(instruction).toContain('поблагодари');
    expect(instruction).toContain('что именно он имел в виду');
    expect(instruction).toContain('перечисли вопросы заново');
  });

  it('every action has an instruction, and wait has none to render', () => {
    for (const a of VALID_ACTIONS) {
      if (a === 'wait') { expect(buildActionInstruction(a)).toBe(''); continue; }
      expect(buildActionInstruction(a).length, a).toBeGreaterThan(20);
    }
  });

  it('the planned action replaces the legacy type instruction in the prompt', () => {
    const userMsg = buildDraftUserMessage({
      messageType: 'reply',
      firstName: 'Дмитрий',
      history: [],
      action: 'propose_test',
      testTask: 'Откройте витрину и сверьте с гайдом.',
    });
    expect(userMsg).toContain('Задача письма: спросить, готов ли кандидат');
    // The step's own task text must be visible to the writer but must not be
    // mistaken for the letter itself.
    expect(userMsg).toContain('Откройте витрину и сверьте с гайдом.');
  });
});

describe('funnel — the test task leaves word-for-word', () => {
  it('returns the configured text unchanged', () => {
    const TASK = 'Задание 1.\nСверьте витрину с гайдом.\n— что не так; — почему это важно.';
    expect(buildTestTaskMessage(TASK)).toBe(TASK);
  });

  it('returns null when no task is configured', () => {
    expect(buildTestTaskMessage('')).toBeNull();
    expect(buildTestTaskMessage('   ')).toBeNull();
  });
});

// ── Issue #71: a logic change must invalidate cached drafts ─────────────────

describe('draft cache — the logic version is part of the signature (#71)', () => {
  it('stamps the funnel version into the signature', () => {
    expect(historySignature([])).toBe(`${FUNNEL_LOGIC_VERSION}:empty`);
    expect(historySignature([{ role: 'employer', text: 'hi', hh_id: '7' }])).toContain(FUNNEL_LOGIC_VERSION);
  });

  it('an old draft (no version in the signature) is treated as stale', () => {
    // The exact state left on prod by the broken prompt: sig without a version.
    const stale = isDraftStale({
      ats_result: { draft_message: 'К какому из моих вопросов вы относитесь?', draft_history_sig: '2:15675691647' },
      messages: [
        { role: 'employer', text: 'вопросы', hh_id: '1' },
        { role: 'applicant', text: 'здравствуйте, да', hh_id: '15675691647' },
      ],
    });
    expect(stale).toBe(true);
  });

  it('a fresh draft for the same thread is not stale', () => {
    const messages = [
      { role: 'employer', text: 'вопросы', hh_id: '1' },
      { role: 'applicant', text: 'здравствуйте, да', hh_id: '15675691647' },
    ];
    const fresh = isDraftStale({
      ats_result: { draft_message: 'Спасибо за ответ! Уточните, пожалуйста…', draft_history_sig: historySignature(messages) },
      messages,
    });
    expect(fresh).toBe(false);
  });

  it('"wait" is a decision, not missing work — no re-plan on every cycle', () => {
    const messages = [{ role: 'employer', text: 'вопросы', hh_id: '1' }];
    const decided = isDraftStale({
      ats_result: { funnel_action: 'wait', draft_skip_sig: historySignature(messages) },
      messages,
    });
    expect(decided).toBe(false);
    // …but a new message from the candidate reopens it.
    const reopened = isDraftStale({
      ats_result: { funnel_action: 'wait', draft_skip_sig: historySignature(messages) },
      messages: [...messages, { role: 'applicant', text: 'да', hh_id: '2' }],
    });
    expect(reopened).toBe(true);
  });
});

describe('action set is closed and documented', () => {
  it('covers the owner\'s process end to end', () => {
    for (const a of ['ask_skills', 'clarify_answer', 'propose_test', 'send_test', 'invite_call', 'wait']) {
      expect(VALID_ACTIONS, a).toContain(a);
      expect(ACTIONS[a].length, a).toBeGreaterThan(10);
    }
  });
});

describe('criteria guard — a flagged criterion is replaced, not silently deleted', () => {
  it('uses the measurable wording the guard proposed', () => {
    // Regression from the live check on 138004863: dropping instead of replacing
    // would have deleted «настройка и оптимизация внутренней рекламы» — a real
    // requirement — from the rubric the recruiter was about to review.
    const config = {
      required: [{ name: 'настройка и оптимизация внутренней рекламы', weight: 3 }],
      preferred: [],
    };
    const violations = [{
      field: 'required',
      name: 'настройка и оптимизация внутренней рекламы',
      source: 'llm',
      suggestion: 'Настройка внутренней рекламы WB: ставки, ДРР, поисковая выдача',
    }];
    const res = applyCriteriaGuard(config, violations);
    expect(res.config.required).toHaveLength(1);
    expect(res.config.required[0].name).toContain('ДРР');
    expect(res.config.required[0].weight).toBe(3);
    expect(res.replaced).toHaveLength(1);
    expect(res.dropped).toHaveLength(0);
  });

  it('drops only what has no usable replacement', () => {
    const config = {
      required: [{ name: 'аналитический склад ума', weight: 1.5 }],
      preferred: [{ name: 'понимание товара и трендов', weight: 1.5 }],
    };
    const violations = [
      { field: 'required', name: 'аналитический склад ума' },
      { field: 'preferred', name: 'понимание товара и трендов', suggestion: '   ' },
    ];
    const res = applyCriteriaGuard(config, violations);
    expect(res.config.required).toHaveLength(0);
    expect(res.config.preferred).toHaveLength(0);
    expect(res.dropped.map(d => d.name).sort()).toEqual(['аналитический склад ума', 'понимание товара и трендов']);
  });

  it('leaves untouched criteria alone', () => {
    const config = { required: [{ name: 'опыт работы с Wildberries от 2 лет', weight: 3 }], preferred: [] };
    const res = applyCriteriaGuard(config, []);
    expect(res.config.required[0].name).toBe('опыт работы с Wildberries от 2 лет');
  });
});
