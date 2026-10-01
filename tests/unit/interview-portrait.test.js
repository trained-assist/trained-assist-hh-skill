// Unit tests for src/mcp-skills/tools/99b-interview-portrait.js (#89) — интервью →
// требования портрета: балл 0-5 с evidence, покрытие, ось коммуникации, итог
// Σ(s×w)/Σ(5×w), veto must-have ≤1. Канон оценки — спека #91, эпик #83 фаза 3.
// LLM перехватывается nock'ом на https://llm-ladder.trainedassist.store (ветка с
// маркером системного промпта — там же tests/support/llm-provider-fixture.cjs).

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import nock from 'nock';

const require = createRequire(import.meta.url);
const tool = require('../../src/mcp-skills/tools/99b-interview-portrait.js');
const {
  PROMPT_MARKER, SYSTEM_PROMPT, buildDialogue, buildRequirements, buildUserPrompt,
  normalizeRequirements, normalizeCommunication, computeTotals, decideVerdict,
  buildCoverage, renderMarkdown, evalFile, evalMdFile, structureFile, interviewDir,
} = tool;

const LADDER = 'https://llm-ladder.trainedassist.store';
const TOKEN = 'fixture-ladder-token';
const STRUCTURE_FIXTURE = require.resolve('../../fixtures/interviews/video-interveu-primer-2-structure.json');
const TRANSCRIPT_FIXTURE = require.resolve('../../fixtures/interviews/video-interveu-primer-2-transcript.txt');

const ENV_KEYS = ['USER_ID', 'AGENT_DATA_DIR', 'AGENT_TOKENS_DIR', 'AGENT_TOKENS_ROOT', 'LLM_LADDER_TOKEN', 'USERS_DIR'];

const COMM = {
  style: { score: 5, evidence: 'деловой тон' },
  politeness: { score: 5, evidence: 'здоровается и благодарит' },
  vocabulary: { score: 5, evidence: 'профессиональная лексика' },
  structure: { score: 5, evidence: 'отвечает по пунктам' },
};

// Требования фикстурного портрета (см. writePortrait ниже): 5 пунктов.
function portraitFixture() {
  return {
    vacancy: { title: 'Инженер Node.js' },
    requirements: {
      hard_skills: ['Node.js', 'PostgreSQL'],
      soft_skills: ['Коммуникация'],
      experience: 'от 3 лет с backend',
      education: 'высшее техническое',
    },
  };
}

// required: Node.js/PostgreSQL → 2 (must-have), preferred: Коммуникация → 1.
function atsFixture() {
  return {
    vacancy_id: 'v-1',
    vacancy_title: 'Инженер Node.js',
    required: [{ name: 'Node.js', weight: 2 }, { name: 'PostgreSQL', weight: 2 }],
    preferred: [{ name: 'Коммуникация', weight: 1 }],
    pass_threshold: 6.5,
    review_threshold: 4,
  };
}

function evalResponse(scores) {
  return JSON.stringify({
    requirements: scores.map((s, i) => (typeof s === 'object'
      ? { id: `req-${i + 1}`, ...s }
      : { id: `req-${i + 1}`, score: s, evidence: `цитата №${i + 1} из транскрипта [реплика ${i + 1}]` })),
    communication: COMM,
  });
}

let tmp;
let workDir;
let origCwd;
let llmCalls;

function writeCtx(key, value) {
  mkdirSync(join(workDir, 'contexts', 'hh'), { recursive: true });
  writeFileSync(join(workDir, 'contexts', 'hh', `${key}.json`), JSON.stringify({ value }));
}

function writePortrait(p = portraitFixture()) {
  const { writePortrait: write } = require('../../src/hh-portrait.js');
  write(workDir, 'v-1', p);
}

function writeStructure(overrides = {}) {
  const dir = interviewDir('primer-2');
  mkdirSync(dir, { recursive: true });
  const base = JSON.parse(readFileSync(STRUCTURE_FIXTURE, 'utf8'));
  writeFileSync(structureFile('primer-2'), JSON.stringify({ ...base, ...overrides }, null, 2));
}

function mockLadder(content) {
  return nock(LADDER)
    .post('/v1/chat/completions')
    .reply(200, (_uri, body) => {
      llmCalls.push(body);
      return { choices: [{ message: { content } }], model: 'fixture-model' };
    });
}

beforeAll(() => {
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
});

afterAll(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hh-interview-eval-'));
  workDir = join(tmp, 'users', 'itv-test');
  mkdirSync(workDir, { recursive: true });
  origCwd = process.cwd();
  process.chdir(workDir);
  process.env.USER_ID = 'itv-test';
  process.env.AGENT_DATA_DIR = join(tmp, 'data');
  process.env.AGENT_TOKENS_DIR = join(tmp, 'agent-tokens');
  process.env.AGENT_TOKENS_ROOT = join(tmp, 'agent-tokens');
  process.env.LLM_LADDER_TOKEN = TOKEN;
  llmCalls = [];
});

afterEach(() => {
  process.chdir(origCwd);
  nock.cleanAll();
  rmSync(tmp, { recursive: true, force: true });
  for (const k of ENV_KEYS) delete process.env[k];
});

// ── Промпт: канон оценки зафиксирован в тексте ────────────────────────────────

describe('системный промпт', () => {
  it('держит маркер фикстуры, анкоры 0/3/5, n/a ≠ 0 и запрет выдумок', () => {
    expect(SYSTEM_PROMPT).toContain(PROMPT_MARKER);
    expect(SYSTEM_PROMPT).toMatch(/0 — явное несоответствие/);
    expect(SYSTEM_PROMPT).toMatch(/3 — соответствует/);
    expect(SYSTEM_PROMPT).toMatch(/5 — превосходит/);
    expect(SYSTEM_PROMPT).toMatch(/НЕ СТАВЬ 0 за молчание/);
    expect(SYSTEM_PROMPT).toMatch(/evidence ОБЯЗАТЕЛЕН/);
    expect(SYSTEM_PROMPT).toMatch(/Не|не выдумывай|Ничего не выдумывай/);
    expect(SYSTEM_PROMPT).toMatch(/communication — ОТДЕЛЬНАЯ ось/);
    expect(SYSTEM_PROMPT).toMatch(/НЕ входит в итоговый скор требований/);
    expect(SYSTEM_PROMPT).toMatch(/ТОЛЬКО валидный JSON/);
  });

  it('пользовательский промпт перечисляет требования с весами и честно пишет про роли', () => {
    const requirements = buildRequirements(portraitFixture(), atsFixture());
    const roles = buildDialogue({ speakers_detected: false, turns: [{ text: 'Привет' }] });
    const prompt = buildUserPrompt(requirements, roles);
    expect(prompt).toContain('req-1 [hard_skill · вес 2 · must-have] Node.js');
    expect(prompt).toContain('req-3 [soft_skill · вес 1] Коммуникация');
    expect(prompt).toContain('Роли НЕ распознаны');
    expect(prompt).toContain('Привет');
  });
});

// ── Требования ────────────────────────────────────────────────────────────────

describe('buildRequirements', () => {
  it('веса из ats_config: required=2 must-have, preferred=1; опыт/образование из портрета', () => {
    const items = buildRequirements(portraitFixture(), atsFixture());
    expect(items.map(i => i.id)).toEqual(['req-1', 'req-2', 'req-3', 'req-4', 'req-5']);
    expect(items.map(i => i.label)).toEqual(['Node.js', 'PostgreSQL', 'Коммуникация', 'Опыт работы: от 3 лет с backend', 'Образование: высшее техническое']);
    expect(items.map(i => i.weight)).toEqual([2, 2, 1, 2, 1]);
    expect(items.map(i => i.must_have)).toEqual([true, true, false, true, false]);
  });

  it('без ats_config — правила портрета (hard/опыт = 2, soft/образование = 1)', () => {
    const items = buildRequirements(portraitFixture(), null);
    expect(items.map(i => i.weight)).toEqual([2, 2, 1, 2, 1]);
    expect(items.map(i => i.must_have)).toEqual([true, true, false, true, false]);
  });

  it('критерии, добавленные только в АТС, не теряются', () => {
    const ats = atsFixture();
    ats.required.push({ name: 'Docker', weight: 3 });
    const items = buildRequirements(portraitFixture(), ats);
    expect(items.find(i => i.label === 'Docker')).toMatchObject({ weight: 3, must_have: true });
  });

  it('пустой портрет и пустая АТС → пустой список (честная ошибка в хендлере)', () => {
    expect(buildRequirements({ requirements: {} }, null)).toEqual([]);
  });
});

// ── Диалог ────────────────────────────────────────────────────────────────────

describe('buildDialogue', () => {
  it('роли распознаны → пары вопрос/ответ с метками времени', () => {
    const d = buildDialogue({
      speakers_detected: true,
      turns: [
        { speaker: 'Владимир', role: 'recruiter', text: 'Расскажите об опыте', t: 2 },
        { speaker: 'Кандидат', role: 'candidate', text: '5 лет в Node.js', t: 32 },
        { speaker: 'Владимир', role: 'recruiter', text: 'А B2B?', t: 73 },
        { speaker: 'Кандидат', role: 'candidate', text: 'Продавали франшизы', t: 77 },
      ],
    });
    expect(d.roles_detected).toBe(true);
    expect(d.qa).toHaveLength(2);
    expect(d.qa[0].question).toBe('Расскажите об опыте');
    expect(d.qa[0].answers[0].text).toBe('5 лет в Node.js');
    expect(d.lines.join('\n')).toMatch(/\[1\] Вопрос \(0:02\): Расскажите об опыте/);
    expect(d.lines.join('\n')).toMatch(/Ответ \(0:32\): 5 лет/);
  });

  it('speakers_detected:false → без ролей, честно, без выдуманного «первого вопроса»', () => {
    const d = buildDialogue({
      speakers_detected: false,
      turns: [{ speaker: 'A', text: 'Здравствуйте', t: 0 }, { speaker: 'B', text: 'Здравствуйте', t: 3 }],
    });
    expect(d.roles_detected).toBe(false);
    expect(d.qa).toEqual([]);
    expect(d.lines.join('\n')).not.toMatch(/Вопрос|Ответ/);
    expect(d.lines.join('\n')).toContain('[1] A (0:00): Здравствуйте');
  });

  it('speakers_detected:true, но ролей в репликах нет → всё равно без ролей', () => {
    const d = buildDialogue({ speakers_detected: true, turns: [{ text: 'Просто текст' }] });
    expect(d.roles_detected).toBe(false);
  });
});

// ── Нормализация ответа модели ───────────────────────────────────────────────

describe('normalizeRequirements / normalizeCommunication', () => {
  const reqs = [
    { id: 'req-1', kind: 'hard_skill', label: 'Node.js', weight: 2, must_have: true },
    { id: 'req-2', kind: 'soft_skill', label: 'Коммуникация', weight: 1, must_have: false },
    { id: 'req-3', kind: 'experience', label: 'Опыт работы: от 3 лет', weight: 2, must_have: true },
  ];

  it('n/a → не оценено (не 0), неизвестные id отбрасываются с предупреждением', () => {
    const { items, warnings } = normalizeRequirements({
      requirements: [
        { id: 'req-1', score: 4, evidence: 'цитата [реплика 1]' },
        { id: 'req-2', score: 'n/a', evidence: 'не прозвучало' },
        { id: 'req-99', score: 5, evidence: 'мусор' },
      ],
    }, reqs);
    expect(items[0].score).toBe(4);
    expect(items[1].score).toBeNull();
    expect(items[1].reason).toBe('не прозвучало в интервью');
    expect(items[2].score).toBeNull(); // модель не вернула req-3
    expect(warnings.join(' ')).toContain('req-99');
    expect(warnings.join(' ')).toContain('req-3');
  });

  it('балл без evidence не засчитывается — честно понижается до n/a с предупреждением', () => {
    const { items, warnings } = normalizeRequirements({
      requirements: [{ id: 'req-1', score: 5, evidence: '' }],
    }, reqs);
    expect(items[0].score).toBeNull();
    expect(items[0].reason).toMatch(/нет цитаты/);
    expect(warnings.join(' ')).toMatch(/без evidence/);
  });

  it('балл вне шкалы зажимается в 0–5, мусор не превращается в 0', () => {
    const { items } = normalizeRequirements({
      requirements: [
        { id: 'req-1', score: 9, evidence: 'x' },
        { id: 'req-2', score: 'очень хорошо', evidence: 'x' },
      ],
    }, reqs);
    expect(items[0].score).toBe(5);
    expect(items[1].score).toBeNull();
    expect(items[1].reason).toMatch(/некорректный/);
  });

  it('communication: каждая ось 0–5 с цитатой, без цитаты — n/a', () => {
    const comm = normalizeCommunication({ communication: { ...COMM, structure: { score: 4 } } });
    expect(comm.style.score).toBe(5);
    expect(comm.structure.score).toBeNull();
    expect(comm.structure.reason).toMatch(/нет цитаты/);
    expect(Object.keys(comm).sort()).toEqual(['politeness', 'structure', 'style', 'vocabulary']);
  });
});

// ── Итоги ─────────────────────────────────────────────────────────────────────

describe('computeTotals / decideVerdict / buildCoverage', () => {
  const items = [
    { id: 'req-1', label: 'Node.js', weight: 2, must_have: true, score: 4 },
    { id: 'req-2', label: 'Коммуникация', weight: 1, must_have: false, score: 5 },
    { id: 'req-3', label: 'Docker', weight: 2, must_have: true, score: null, reason: 'не прозвучало в интервью' },
  ];

  it('Σ(s×w)/Σ(5×w) → percent + 0–10, n/a не входит ни в числитель, ни в знаменатель', () => {
    const t = computeTotals(items);
    expect(t.sum_sw).toBe(4 * 2 + 5 * 1);
    expect(t.sum_5w).toBe(5 * 2 + 5 * 1); // req-3 не участвует
    expect(t.percent).toBe(Math.round((13 / 15) * 100));
    expect(t.score_10).toBe(Math.round(Math.round((13 / 15) * 100)) / 10);
    expect(t.counted).toBe(2);
    expect(t.na).toBe(1);
    expect(t.total).toBe(3);
  });

  it('пороги 6.5 / 4.0 → ПРОПУСТИТЬ / УТОЧНИТЬ / ОТКЛОНИТЬ', () => {
    const th = { pass: 6.5, review: 4 };
    const make = score10 => ({ score_10: score10, percent: score10 * 10 });
    expect(decideVerdict(make(7.0), items, th).verdict).toBe('ПРОПУСТИТЬ');
    expect(decideVerdict(make(5.0), items, th).verdict).toBe('УТОЧНИТЬ');
    expect(decideVerdict(make(3.9), items, th).verdict).toBe('ОТКЛОНИТЬ');
  });

  it('veto: must-have с баллом ≤1 → ОТКЛОНИТЬ независимо от суммы', () => {
    const vetoItems = [
      { id: 'req-1', label: 'Node.js', weight: 2, must_have: true, score: 1 },
      { id: 'req-2', label: 'Soft', weight: 1, must_have: false, score: 5 },
    ];
    const totals = computeTotals(vetoItems);
    const d = decideVerdict(totals, vetoItems, { pass: 6.5, review: 4 });
    expect(d.veto).toBe(true);
    expect(d.verdict).toBe('ОТКЛОНИТЬ');
    expect(d.veto_requirements).toEqual([{ id: 'req-1', label: 'Node.js', score: 1 }]);
  });

  it('coverage делит требования на было / не прозвучало', () => {
    const c = buildCoverage(items);
    expect(c.covered_count).toBe(2);
    expect(c.missing_count).toBe(1);
    expect(c.missing[0].label).toBe('Docker');
    expect(c.percent).toBe(67);
  });
});

// ── Фикстуры реального интервью (#88) ────────────────────────────────────────

describe('fixtures/interviews', () => {
  it('structure.json построен по транскрипту: 19 реплик, роли, метки времени', () => {
    const s = JSON.parse(readFileSync(STRUCTURE_FIXTURE, 'utf8'));
    expect(s.speakers_detected).toBe(true);
    expect(s.turns).toHaveLength(19);
    expect(new Set(s.turns.map(t => t.role))).toEqual(new Set(['recruiter', 'candidate']));
    expect(s.turns.every(t => t.text.trim().length > 0)).toBe(true);
    expect(s.turns.map(t => t.t)).toEqual([...s.turns.map(t => t.t)].sort((a, b) => a - b));
    expect(s.turns[0].role).toBe('recruiter');
    expect(s.turns[1].role).toBe('candidate');
  });

  it('транскрипт на месте и содержит каждую метку времени structure.json', () => {
    const transcript = readFileSync(TRANSCRIPT_FIXTURE, 'utf8');
    const s = JSON.parse(readFileSync(STRUCTURE_FIXTURE, 'utf8'));
    for (const t of s.turns) {
      const label = `[${Math.floor(t.t / 60)}:${String(t.t % 60).padStart(2, '0')}]`;
      expect(transcript).toContain(label);
    }
  });

  it('диалог из фикстуры собирается в пары вопрос/ответ', () => {
    const d = buildDialogue(JSON.parse(readFileSync(STRUCTURE_FIXTURE, 'utf8')));
    expect(d.roles_detected).toBe(true);
    expect(d.qa.length).toBeGreaterThan(5);
    expect(d.qa.every(q => q.question)).toBe(true);
  });
});

// ── Хендлеры (LLM → nock) ────────────────────────────────────────────────────

describe('hh_interview_evaluate', () => {
  it('оценивает требования, считает итог, держит communication отдельно, пишет кэш и MD', async () => {
    writePortrait();
    writeCtx('ats_config:v-1', atsFixture());
    writeStructure();
    mockLadder(evalResponse([4, 4, 5, 3, 'n/a', { id: 'req-99', score: 5, evidence: 'мусор' }]));

    const tools = require('../../src/mcp-skills/tools/99b-interview-portrait.js').tools;
    const out = await tools.hh_interview_evaluate.handler({ slug: 'primer-2', vacancy_id: 'v-1' });

    expect(out.error).toBeUndefined();
    expect(out.ok).toBe(true);
    expect(out.cached).toBe(false);
    expect(out.roles_detected).toBe(true);
    expect(out.requirements).toHaveLength(5);
    expect(out.requirements.map(r => r.score)).toEqual([4, 4, 5, 3, null]);
    // Итог только по требованиям: Σ=4·2+4·2+5·1+3·2=27; n/a (req-5) не входит ни в
    // числитель, ни в знаменатель → Σ(5w)=35 → 77% → 7.7/10
    expect(out.totals.sum_sw).toBe(27);
    expect(out.totals.sum_5w).toBe(35);
    expect(out.totals.percent).toBe(77);
    expect(out.totals.score_10).toBe(7.7);
    expect(out.totals.na).toBe(1);
    expect(out.verdict).toBe('ПРОПУСТИТЬ');
    expect(out.veto).toBe(false);
    // communication — параллельная ось: баллы есть, но в totals не попали (sum_5w считается только по требованиям)
    expect(out.communication.style.score).toBe(5);
    expect(out.coverage.missing.map(m => m.label)).toEqual(['Образование: высшее техническое']);
    expect(out.coverage.covered_count).toBe(4);
    expect(out.warnings.join(' ')).toContain('req-99');

    // Запрос в лестницу: default-ladder (service), temperature 0.2, JSON-only-промпт
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0].model).toBe('service');
    expect(llmCalls[0].temperature).toBe(0.2);
    expect(llmCalls[0].max_tokens).toBe(4000);
    const sent = llmCalls[0].messages.map(m => m.content).join('\n');
    expect(sent).toContain(PROMPT_MARKER);

    // Кэш и markdown
    expect(existsSync(evalFile('primer-2'))).toBe(true);
    const md = readFileSync(evalMdFile('primer-2'), 'utf8');
    expect(md).toContain('## Покрытие интервью');
    expect(md).toContain('Не прозвучало (1)');
    expect(md).toContain('## Коммуникация — отдельная ось, в итоговый скор не входит');
    expect(md).toContain('**Итог: 77% · 7.7 / 10 — ПРОПУСТИТЬ**');
    expect(md).toContain('n/a');
  });

  it('идемпотентно: повтор читает кэш без LLM, force пересчитывает', async () => {
    writePortrait();
    writeCtx('ats_config:v-1', atsFixture());
    writeStructure();
    mockLadder(evalResponse([4, 4, 5, 3, 'n/a']));
    const { tools } = require('../../src/mcp-skills/tools/99b-interview-portrait.js');

    const first = await tools.hh_interview_evaluate.handler({ slug: 'primer-2', vacancy_id: 'v-1' });
    expect(first.cached).toBe(false);
    expect(llmCalls).toHaveLength(1);

    const second = await tools.hh_interview_evaluate.handler({ slug: 'primer-2', vacancy_id: 'v-1' });
    expect(second.cached).toBe(true);
    expect(second.totals.percent).toBe(77);
    expect(llmCalls).toHaveLength(1); // кэш — без нового вызова

    mockLadder(evalResponse([1, 5, 5, 5, 5]));
    const forced = await tools.hh_interview_evaluate.handler({ slug: 'primer-2', vacancy_id: 'v-1', force: true });
    expect(forced.cached).toBe(false);
    expect(llmCalls).toHaveLength(2);
    expect(forced.requirements[0].score).toBe(1);
    expect(forced.verdict).toBe('ОТКЛОНИТЬ'); // must-have ≤1 → veto
    expect(forced.veto).toBe(true);
  });

  it('ошибка: портрета нет → подсказка собрать портрет, без LLM-вызова', async () => {
    writeStructure();
    const { tools } = require('../../src/mcp-skills/tools/99b-interview-portrait.js');
    const out = await tools.hh_interview_evaluate.handler({ slug: 'primer-2', vacancy_id: 'v-1' });
    expect(out.error).toMatch(/Портрет для вакансии «v-1» не найден/);
    expect(out.error).toMatch(/hh_portrait_extract/);
    expect(llmCalls).toHaveLength(0);
  });

  it('ошибка: портрет без требований → честно «не оценивать в пустоту»', async () => {
    writePortrait({ vacancy: { title: 'Инженер Node.js' }, requirements: {} });
    writeStructure();
    const { tools } = require('../../src/mcp-skills/tools/99b-interview-portrait.js');
    const out = await tools.hh_interview_evaluate.handler({ slug: 'primer-2', vacancy_id: 'v-1' });
    expect(out.error).toMatch(/нет требований/);
    expect(llmCalls).toHaveLength(0);
  });

  it('ошибка: structure.json нет → показывает ожидаемый путь', async () => {
    writePortrait();
    const { tools } = require('../../src/mcp-skills/tools/99b-interview-portrait.js');
    const out = await tools.hh_interview_evaluate.handler({ slug: 'primer-2', vacancy_id: 'v-1' });
    expect(out.error).toMatch(/Структура интервью не найдена/);
    expect(out.error).toContain(join('interviews', 'primer-2', 'structure.json'));
    expect(llmCalls).toHaveLength(0);
  });

  it('speakers_detected:false → оценка идёт, но роли честно помечены как нераспознанные', async () => {
    writePortrait();
    writeCtx('ats_config:v-1', atsFixture());
    writeStructure({ speakers_detected: false });
    mockLadder(evalResponse([4, 4, 5, 3, 'n/a']));
    const { tools } = require('../../src/mcp-skills/tools/99b-interview-portrait.js');
    const out = await tools.hh_interview_evaluate.handler({ slug: 'primer-2', vacancy_id: 'v-1' });
    expect(out.ok).toBe(true);
    expect(out.roles_detected).toBe(false);
    expect(out.roles_note).toMatch(/роли не выдумывались/);
    const sent = llmCalls[0].messages.map(m => m.content).join('\n');
    expect(sent).toContain('Роли НЕ распознаны');
    expect(sent).not.toContain('Вопрос (');
  });

  it('без slug — честная ошибка схемы', async () => {
    const { tools } = require('../../src/mcp-skills/tools/99b-interview-portrait.js');
    const out = await tools.hh_interview_evaluate.handler({});
    expect(out.error).toMatch(/slug обязателен/);
  });
});

describe('hh_interview_coverage', () => {
  it('после оценки возвращает было/не прозвучало без LLM-вызова', async () => {
    writePortrait();
    writeCtx('ats_config:v-1', atsFixture());
    writeStructure();
    mockLadder(evalResponse([4, 4, 5, 3, 'n/a']));
    const { tools } = require('../../src/mcp-skills/tools/99b-interview-portrait.js');
    await tools.hh_interview_evaluate.handler({ slug: 'primer-2', vacancy_id: 'v-1' });
    const before = llmCalls.length;

    const out = await tools.hh_interview_coverage.handler({ slug: 'primer-2', vacancy_id: 'v-1' });
    expect(out.ok).toBe(true);
    expect(out.coverage.covered_count).toBe(4);
    expect(out.missing_topics).toEqual(['Образование: высшее техническое']);
    expect(out.hint).toMatch(/следующий этап/);
    expect(llmCalls).toHaveLength(before);
  });

  it('без оценки — ошибка с подсказкой запустить hh_interview_evaluate', async () => {
    const { tools } = require('../../src/mcp-skills/tools/99b-interview-portrait.js');
    const out = await tools.hh_interview_coverage.handler({ slug: 'primer-2', vacancy_id: 'v-1' });
    expect(out.error).toMatch(/hh_interview_evaluate/);
  });

  it('кэш от другой вакансии не выдаётся за текущий', async () => {
    writePortrait();
    writeCtx('ats_config:v-1', atsFixture());
    writeStructure();
    mockLadder(evalResponse([4, 4, 5, 3, 'n/a']));
    const { tools } = require('../../src/mcp-skills/tools/99b-interview-portrait.js');
    await tools.hh_interview_evaluate.handler({ slug: 'primer-2', vacancy_id: 'v-1' });
    const out = await tools.hh_interview_coverage.handler({ slug: 'primer-2', vacancy_id: 'v-2' });
    expect(out.error).toMatch(/для вакансии «v-1»/);
  });
});

describe('renderMarkdown', () => {
  it('покрывает итог, покрытие и отдельный блок коммуникации', () => {
    const items = [
      { id: 'req-1', label: 'Node.js', kind: 'hard_skill', weight: 2, must_have: true, score: 4, evidence: 'цитата [реплика 1]' },
      { id: 'req-2', label: 'Docker', kind: 'hard_skill', weight: 2, must_have: true, score: null, reason: 'не прозвучало в интервью' },
    ];
    const md = renderMarkdown({
      slug: 'primer-2', vacancy_id: 'v-1', roles_detected: false,
      requirements: items, totals: computeTotals(items), coverage: buildCoverage(items),
      ...decideVerdict(computeTotals(items), items, { pass: 6.5, review: 4 }),
      communication: normalizeCommunication({ communication: COMM }),
      warnings: [],
    });
    expect(md).toContain('## Покрытие интервью');
    expect(md).toContain('## Коммуникация — отдельная ось, в итоговый скор не входит');
    expect(md).toContain('НЕ распознаны');
    expect(md).toContain('Не прозвучало (1)');
    expect(md).toContain('Docker (не прозвучало в интервью)');
  });
});
