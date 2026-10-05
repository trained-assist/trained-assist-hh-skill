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
  guardPlannerAction,
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
    // The test means "no key" — an OPENROUTER_API_KEY exported in the shell would
    // otherwise turn it into a real network call with a different outcome.
    const prevKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const res = await checkCriteria(
        { required: [{ name: 'аналитический склад ума' }, { name: 'настройка рекламы WB' }] },
        { useLlm: true, apiKey: null, username: 'nobody-without-a-token' },
      );
      expect(res.degraded).toBe(true);
      // regex still did its job
      expect(res.violations.map(v => v.name)).toEqual(['аналитический склад ума']);
    } finally {
      if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevKey;
    }
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
    expect(userMsg).toContain('спросить, готов ли кандидат');
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

describe('funnel — a promised test task is not blocked by our own silence', () => {
  const TASK = 'Откройте витрину бренда и сверьте её с гайдом по карточкам.';

  it('sends the assignment we already promised', () => {
    // Live regression, 01.10.2026 / vacancy 138004863: our last message was
    // «Супер, пришлю задание», the funnel answered `wait` (we spoke last, no
    // reply), and the assignment the candidate was waiting for was never sent.
    const step = deterministicStep({
      history: [
        { role: 'applicant', text: 'Готов выполнить', timestamp: iso(3600 * 1000) },
        { role: 'employer', text: 'Супер, пришлю задание', timestamp: iso(1800 * 1000) },
      ],
      atsResult: { verdict: 'ПРОПУСТИТЬ', score: 8.5 },
      atsConfig: { pass_threshold: 6.5, test_task: TASK },
    });
    expect(step.action).toBe('send_test');
  });

  it('still waits when no promise was made', () => {
    const step = deterministicStep({
      history: [{ role: 'employer', text: 'Какие у вас метрики?', timestamp: iso(3600 * 1000) }],
      atsResult: { verdict: 'ПРОПУСТИТЬ', score: 8.5 },
      atsConfig: { pass_threshold: 6.5, test_task: TASK },
    });
    expect(step.action).toBe('wait');
  });

  it('never re-sends an assignment that already went out', () => {
    const step = deterministicStep({
      history: [
        { role: 'employer', text: 'Супер, пришлю задание', timestamp: iso(2 * DAY) },
        { role: 'employer', text: `Тестовое задание.\n\n${TASK}`, timestamp: iso(2 * DAY - 1000) },
      ],
      atsResult: { verdict: 'ПРОПУСТИТЬ', score: 8.5 },
      atsConfig: { pass_threshold: 6.5, test_task: TASK },
    });
    expect(step.action).not.toBe('send_test');
  });

  it('offers nothing when the vacancy has no assignment', () => {
    const step = deterministicStep({
      history: [{ role: 'employer', text: 'Супер, пришлю задание', timestamp: iso(3600 * 1000) }],
      atsResult: { verdict: 'ПРОПУСТИТЬ', score: 8.5 },
      atsConfig: { pass_threshold: 6.5, test_task: '' },
    });
    expect(step.action).not.toBe('send_test');
  });
});

// ── Outward steps are gated by code, not by the planner's reading of the score ──
//
// Live finding 01.10.2026 (vacancy 138004863, production key): the planner returned
// `reject` for a candidate scored 8.5 against a 7.5 pass threshold, verdict
// ПРОПУСТИТЬ, on 2 of 3 runs of the same thread. A refusal leaves the system for
// good and cannot be unsent, so the recruiter's own thresholds — not a prompt line —
// must decide it. Same for `send_test`: the assignment only exists if the config
// carries it.

describe('funnel — the planner cannot refuse a passing candidate', () => {
  const PASSING = { verdict: 'ПРОПУСТИТЬ', score: 8.5, gaps: [], matched: [] };

  it('turns a refusal into silence when the candidate is above the pass threshold', () => {
    const guarded = guardPlannerAction({ action: 'reject', reason: 'не подходит' }, {
      history: [], atsResult: PASSING, atsConfig: { pass_threshold: 7.5, review_threshold: 5 },
    });
    expect(guarded.action).not.toBe('reject');
    expect(guarded.action).toBe('wait');
    expect(guarded.guarded).toBe('reject');
  });

  it('turns a refusal into silence when the verdict says the candidate passes', () => {
    // The trap of the original bug: score 6.0 sits above review_threshold 5, so the
    // candidate is ПРОПУСТИТЬ — the model read "низкий скор" and refused anyway.
    const guarded = guardPlannerAction({ action: 'reject', reason: 'скор низкий' }, {
      history: [], atsResult: { verdict: 'ПРОПУСТИТЬ', score: 6.0 },
      atsConfig: { pass_threshold: 7.5, review_threshold: 5 },
    });
    expect(guarded.action).not.toBe('reject');
  });

  it('turns a refusal into silence when the candidate has no score yet', () => {
    const guarded = guardPlannerAction({ action: 'reject', reason: '...' }, {
      history: [], atsResult: { verdict: 'ПРОПУСТИТЬ', score: null }, atsConfig: {},
    });
    expect(guarded.action).not.toBe('reject');
  });

  it('still refuses on the ATS verdict the thresholds produced', () => {
    const guarded = guardPlannerAction({ action: 'reject', reason: 'ниже порога' }, {
      history: [], atsResult: { verdict: 'ОТКЛОНИТЬ', score: 3 },
      atsConfig: { pass_threshold: 7.5, review_threshold: 5 },
    });
    expect(guarded.action).toBe('reject');
    expect(guarded.by).toBe('llm');
  });

  it('a refusal survives the full planner path, not just the helper', async () => {
    const llmCall = async () => JSON.stringify({ action: 'reject', reason: 'не подходит' });
    const plan = await planNextStep({
      history: [{ role: 'applicant', text: 'Готов задание', timestamp: iso(3600 * 1000) }],
      atsResult: PASSING,
      atsConfig: { pass_threshold: 7.5, review_threshold: 5 },
      apiKey: 'k',
      llmFn: llmCall,
    });
    expect(plan.action).not.toBe('reject');
  });

  it('never sends an assignment the vacancy does not contain', async () => {
    const llmCall = async () => JSON.stringify({ action: 'send_test', reason: 'отправляю' });
    const plan = await planNextStep({
      history: [{ role: 'applicant', text: 'Готов', timestamp: iso(3600 * 1000) }],
      atsResult: PASSING,
      atsConfig: { pass_threshold: 7.5, review_threshold: 5, test_task: '' },
      apiKey: 'k',
      llmFn: llmCall,
    });
    expect(plan.action).not.toBe('send_test');
  });

  it('redirects ask_skills for a passing candidate — the «что уточняем» rule (02.10.2026)', () => {
    // Used to be «leaves a legitimate step alone»: asking a candidate who already
    // clears the must-haves is exactly the filler-question defect the owner
    // reported (vacancy 138004863, negotiation 5620089198, 9.5/ПРОПУСТИТЬ).
    const noTest = guardPlannerAction({ action: 'ask_skills', reason: 'уточнить' }, {
      history: [], atsResult: PASSING, atsConfig: { pass_threshold: 7.5 },
    });
    expect(noTest.action).toBe('invite_call');
    expect(noTest.guarded).toBe('ask_skills');

    const withTest = guardPlannerAction({ action: 'ask_skills', reason: 'уточнить' }, {
      history: [], atsResult: PASSING, atsConfig: { pass_threshold: 7.5, test_task: 'Задание 1.' },
    });
    expect(withTest.action).toBe('propose_test');
    expect(withTest.guarded).toBe('ask_skills');
  });

  it('leaves a legitimate step alone', () => {
    // clarify_answer is still legitimate for a passing candidate: it re-asks what
    // we already asked, it does not invent new questions.
    const guarded = guardPlannerAction({ action: 'clarify_answer', reason: 'уточнить' }, {
      history: [], atsResult: PASSING, atsConfig: { pass_threshold: 7.5 },
    });
    expect(guarded.action).toBe('clarify_answer');
    expect(guarded.guarded).toBeUndefined();
  });
});

// ── Owner's rule 02.10.2026: what we clarify, and when we stop ──────────────
//
// Live defect: vacancy 138004863, negotiation 5620089198 — Екатерина, 9.5/10,
// verdict ПРОПУСТИТЬ, gaps «пересечение периодов» / «rich-контент отдельно не
// выделен» (not must-haves) — and the draft asked three clarification questions
// plus her name and a call time: «спрашиваем просто так, у кандидата всё есть,
// а мы его гоняем». The rule: clarify ONLY must-haves missing from the data;
// verdict ПРОПУСТИТЬ ⇒ no questions at all → next step of the process.

describe('funnel — «что уточняем»: only missing must-haves, pass → next step', () => {
  const PASS = {
    verdict: 'ПРОПУСТИТЬ',
    score: 9.5,
    matched: ['снижение ДРР с 10% до 4,5%'],
    gaps: ['Совпадение периодов в Mimibaby и Monifique — стоит уточнить параллельную занятость'],
  };
  const WB_CONFIG = {
    pass_threshold: 7.5,
    test_task: 'Тестовое задание (на 1–2 часа).\nЗадание 1. Сверьте витрину с гайдом.',
    required: [{ name: 'настройка и оптимизация внутренней рекламы WB', weight: 3 }],
    preferred: [{ name: 'проверка гипотез по карточкам', weight: 1 }],
  };

  it('first contact with a passing verdict goes straight to the test task — no questions (rule, no LLM)', () => {
    const step = deterministicStep({
      history: [{ role: 'applicant', text: 'Здравствуйте, откликаюсь на вакансию', timestamp: iso(1000) }],
      atsResult: PASS,
      atsConfig: WB_CONFIG,
    });
    expect(step).toMatchObject({ action: 'propose_test', by: 'rule' });
  });

  it('an empty thread with a passing verdict also proposes the test, not ask_skills', () => {
    const step = deterministicStep({ history: [], atsResult: PASS, atsConfig: WB_CONFIG });
    expect(step?.action).toBe('propose_test');
  });

  it('pass without a test task in the process falls through to the planner', () => {
    const step = deterministicStep({ history: [], atsResult: PASS, atsConfig: { pass_threshold: 7.5 } });
    expect(step).toBeNull();
  });

  it('a candidate who did not pass is left to the planner — and the planner sees must-haves only', async () => {
    let seen = '';
    const plan = await planNextStep({
      history: [{ role: 'applicant', text: 'отклик', timestamp: iso(1000) }],
      atsResult: { verdict: 'УТОЧНИТЬ', score: 6, gaps: ['нет подтверждённых метрик'] },
      atsConfig: WB_CONFIG,
      apiKey: 'k',
      llmFn: async (_key, messages) => {
        seen = messages[1].content;
        return JSON.stringify({ action: 'ask_skills', reason: 'нет мастхева', missing_skills: ['настройка и оптимизация внутренней рекламы WB'] });
      },
    });
    expect(plan.action).toBe('ask_skills');
    expect(seen).toContain('Обязательные требования (мастхевы');
    expect(seen).toContain('настройка и оптимизация внутренней рекламы WB');
    expect(seen).toContain('Желательные (не уточнять');
    expect(seen).toContain('Порог прохода: 7.5');
    expect(seen).toContain('вопросов к нему не задавай');
  });

  it('the writer for ask_skills is limited to the list — no name, no time, no nice-to-haves', () => {
    const instruction = buildActionInstruction('ask_skills', { missingSkills: ['SEO-оптимизация карточки'] });
    expect(instruction).toContain('ТОЛЬКО по этому списку');
    expect(instruction).toContain('не имя');
    expect(instruction).toContain('SEO-оптимизация карточки');
  });

  it('the writer for propose_test opens with the match conclusion and asks nothing else', () => {
    const instruction = buildActionInstruction('propose_test');
    expect(instruction).toContain('мы изучили профиль');
    expect(instruction).toContain('Больше НИЧЕГО не спрашивай');
    expect(instruction).toContain('Сам текст задания НЕ приводи');
  });

  it('the funnel action outranks style question mandates in the writer prompt', () => {
    const msg = buildDraftUserMessage({
      messageType: 'initial',
      firstName: 'Екатерина',
      history: [],
      action: 'propose_test',
      testTask: 'Задание 1.',
    });
    expect(msg).toContain('приоритетно над наборами правил стиля');
    expect(msg).toContain('ask_skills/clarify_answer');
  });

  // Требование сдвинулось вместе с версией: версия должна быть ТЕКУЩЕЙ, иначе
  // кэш черновиков не инвалидируется. funnel-v2 → funnel-v3 (02.10.2026): в письмо
  // добавлен блок «Факты из резюме» и гейт «не переспрашивай» — старые черновики
  // с дефектом обязаны устареть.
  it('bumps the logic version so drafts written by older logic go stale', () => {
    expect(FUNNEL_LOGIC_VERSION).toBe('funnel-v4');
  });
});

// Live defect #182 (05.10.2026, vacancy 138004863, negotiation 5619614258):
// «Бурданова Ольга» — we proposed the test, she replied «Да, конечно. Присылайте
// задание.», and the funnel answered null (the promise was read only from the
// LAST message, which was hers). The planner then asked about readiness a second
// time. A pending assignment is a state of the thread, not of who spoke last.
describe('funnel — a pending assignment survives the candidate answering (#182)', () => {
  const TASK = 'Тестовое задание: сверьте витрину с гайдом, три пункта по 3–5 предложений.';
  const cfg = { test_task: TASK, pass_threshold: 7.5 };
  const ats = { score: 7.5, verdict: 'ПРОПУСТИТЬ' };
  const PROPOSE = 'Ольга, добрый день! На текущем этапе отбора мы предлагаем выполнить короткое тестовое задание, которое занимает 1–2 часа. Пришлём задание.';
  const AGREE = 'Владимир, здравствуйте! Да, конечно. Присылайте задание.';
  const live = [
    { role: 'applicant', text: 'Здравствуйте! Имею опыт работы с Wildberries с оборотом 40+ млн ₽ в месяц.', timestamp: '2026-10-01T16:21:02+0300' },
    { role: 'employer', text: PROPOSE, timestamp: '2026-10-05T17:30:09+0300' },
    { role: 'applicant', text: AGREE, timestamp: '2026-10-05T18:29:55+0300' },
  ];

  it('sends the assignment instead of asking readiness again', () => {
    const step = deterministicStep({ history: live, atsResult: ats, atsConfig: cfg });
    expect(step).toBeTruthy();
    expect(step.action).toBe('send_test');
    expect(step.by).toBe('rule');
  });

  it('still sends while WE spoke last with a promise (the original 01.10 fix holds)', () => {
    const promisedOnly = [live[0], { role: 'employer', text: 'Ольга, добрый день! Смотрю ваш опыт, пришлю тестовое задание.', timestamp: '2026-10-05T17:30:09+0300' }];
    const step = deterministicStep({ history: promisedOnly, atsResult: ats, atsConfig: cfg });
    expect(step.action).toBe('send_test');
  });

  it('forces send_test when the planner proposes a second readiness question', () => {
    const plan = guardPlannerAction({ action: 'propose_test', reason: 'модель решила спросить снова' },
      { history: live, atsResult: ats, atsConfig: cfg });
    expect(plan.action).toBe('send_test');
    expect(plan.guarded).toBe('propose_test');
    expect(plan.reason).toContain('согласился');
  });

  it('does not downgrade a consented send when the model asks skills', () => {
    const plan = guardPlannerAction({ action: 'ask_skills', reason: 'модель решила уточнить' },
      { history: live, atsResult: ats, atsConfig: cfg });
    expect(plan.action).toBe('send_test');
    expect(plan.guarded).toBe('ask_skills');
  });

  it('answers the question a candidate asks together with the consent', () => {
    const withQuestion = [...live];
    withQuestion[2] = { role: 'applicant', text: 'Да, конечно. Присылайте задание. А зарплата какая?', timestamp: '2026-10-05T18:29:55+0300' };
    const step = deterministicStep({ history: withQuestion, atsResult: ats, atsConfig: cfg });
    expect(step.action).toBe('send_test');
    expect(step.reason).toContain('вопрос');
    const plan = guardPlannerAction({ action: 'propose_test', reason: 'x' }, { history: withQuestion, atsResult: ats, atsConfig: cfg });
    // The guard must NOT swallow the question: the planner stays free to answer it.
    expect(plan.action).toBe('propose_test');
  });

  it('never sends after a refusal — «не готов» is not consent', () => {
    const refused = [...live, { role: 'applicant', text: 'Спасибо, но не готова сейчас, совсем нет времени.', timestamp: '2026-10-05T19:00:00+0300' }];
    const step = deterministicStep({ history: refused, atsResult: ats, atsConfig: cfg });
    expect(step === null || step.action !== 'send_test').toBe(true);
    const plan = guardPlannerAction({ action: 'propose_test', reason: 'x' }, { history: refused, atsResult: ats, atsConfig: cfg });
    expect(plan.action).not.toBe('send_test');
  });

  it('leaves the thread alone once a recruiter wrote after the agreement', () => {
    const withFollowUp = [...live, { role: 'employer', text: 'Ольга, добрый вечер! Задание пришлю завтра утром.', timestamp: '2026-10-05T19:30:00+0300' }];
    const plan = guardPlannerAction({ action: 'propose_test', reason: 'x' }, { history: withFollowUp, atsResult: ats, atsConfig: cfg });
    expect(plan.action).toBe('propose_test');
    const step = deterministicStep({ history: withFollowUp, atsResult: ats, atsConfig: cfg });
    expect(step === null || step.action !== 'send_test').toBe(true);
  });

  it('does not repeat the task once it is actually in the thread', () => {
    const delivered = [...live, { role: 'employer', text: TASK, timestamp: '2026-10-06T10:00:00+0300' }];
    const step = deterministicStep({ history: delivered, atsResult: ats, atsConfig: cfg });
    expect(step === null || step.action !== 'send_test').toBe(true);
    const plan = guardPlannerAction({ action: 'propose_test', reason: 'x' }, { history: delivered, atsResult: ats, atsConfig: cfg });
    expect(plan.action).not.toBe('send_test');
  });

  it('requires an actual assignment to promise anything', () => {
    const noTaskCfg = { pass_threshold: 7.5 };
    const step = deterministicStep({ history: live, atsResult: ats, atsConfig: noTaskCfg });
    expect(step === null || step.action !== 'send_test').toBe(true);
  });

  it('the send_test letter is assembled, not written (words-for-words promise)', () => {
    expect(buildTestTaskMessage(TASK)).toBe(TASK);
    const plan = guardPlannerAction({ action: 'send_test', reason: 'ok' }, { history: live, atsResult: ats, atsConfig: cfg });
    expect(plan.action).toBe('send_test');
  });
});
