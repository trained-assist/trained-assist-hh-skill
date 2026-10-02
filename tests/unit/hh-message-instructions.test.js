// Epic #112 — per-vacancy «Инструкция для сообщений кандидатам»:
//   * the empty instruction leaves the (cached-draft) signature byte-identical
//     to the pre-#112 one, so a deploy does not churn every cached draft;
//   * a changed instruction invalidates cached drafts of THAT vacancy only;
//   * resolution order: vacancy field → recruiter template → default;
//   * the instruction reaches both the system prompt and the user message,
//     always below the funnel action (which is what decides the letter).
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  buildMessageSystemPrompt,
  resolveMessageInstructions,
  loadInstructionsTemplate,
  DEFAULT_MESSAGE_INSTRUCTIONS,
} = require('../../src/hh-message-prompts.js');
const { buildDraftUserMessage, historySignature, isDraftStale } = require('../../src/hh-draft-message.js');

const THREAD = [
  { hh_id: '1', role: 'employer', text: 'Здравствуйте, Сергей!' },
  { hh_id: '2', role: 'applicant', text: 'добрый день' },
];
const INSTR = 'Если в резюме нет деталей по обязательным требованиям — уточни именно их.';

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-instructions-'));
});

describe('resolveMessageInstructions — per-vacancy, never cross-vacancy', () => {
  it('the vacancy field wins', () => {
    expect(resolveMessageInstructions({ tokensBase: root, username: 'u', atsConfig: { message_instructions: 'Моя инструкция' } }))
      .toBe('Моя инструкция');
  });

  it('an empty field falls back to the recruiter template', () => {
    fs.mkdirSync(path.join(root, 'u'), { recursive: true });
    fs.writeFileSync(path.join(root, 'u', 'hh-message-instructions-template'), 'Шаблон рекрутера');
    expect(resolveMessageInstructions({ tokensBase: root, username: 'u', atsConfig: {} })).toBe('Шаблон рекрутера');
  });

  it('no template, no field → the default (owner-specified process)', () => {
    expect(resolveMessageInstructions({ tokensBase: root, username: 'u', atsConfig: {} })).toBe(DEFAULT_MESSAGE_INSTRUCTIONS);
    expect(DEFAULT_MESSAGE_INSTRUCTIONS).toMatch(/готов ли кандидат выполнить тестовое задание/);
  });

  it('template is per-recruiter: one recruiter override never reads another\'s', () => {
    fs.mkdirSync(path.join(root, 'a'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a', 'hh-message-instructions-template'), 'Строгие правила А');
    expect(resolveMessageInstructions({ tokensBase: root, username: 'b', atsConfig: {} })).toBe(DEFAULT_MESSAGE_INSTRUCTIONS);
    expect(resolveMessageInstructions({ tokensBase: root, username: 'a', atsConfig: {} })).toBe('Строгие правила А');
  });

  it('loadInstructionsTemplate reads the plaintext file transparently', () => {
    fs.mkdirSync(path.join(root, 'a'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a', 'hh-message-instructions-template'), 'Только тон и процесс');
    expect(loadInstructionsTemplate(root, 'a')).toBe('Только тон и процесс');
    expect(loadInstructionsTemplate(root, 'nobody')).toBeNull();
  });
});

describe('buildMessageSystemPrompt — instruction is its own section, funnel stays on top', () => {
  it('adds the «## Инструкция для этой вакансии» section', () => {
    const p = buildMessageSystemPrompt({ vacancyContext: 'V', vacancyInstruction: INSTR });
    expect(p).toContain('## Инструкция для этой вакансии');
    expect(p.indexOf('## Инструкция для этой вакансии')).toBeGreaterThan(p.indexOf('## Контекст вакансии'));
    expect(p).toContain(INSTR);
  });

  it('empty instruction → no section', () => {
    expect(buildMessageSystemPrompt({})).not.toContain('Инструкция для этой вакансии');
  });

  it('warns that the funnel action outranks this free text', () => {
    const p = buildMessageSystemPrompt({ vacancyInstruction: INSTR });
    expect(p).toMatch(/Приоритет над этим текстом.*воронки/);
  });
});

describe('buildDraftUserMessage — instruction reaches the writer, below the action', () => {
  it('a non-empty instruction is included in the user message', () => {
    const msg = buildDraftUserMessage({ history: THREAD, messageType: 'reply', action: 'propose_test', vacancyInstruction: INSTR });
    expect(msg).toContain('Инструкция для этой вакансии');
    expect(msg).toContain(INSTR);
  });

  it('no instruction → nothing added', () => {
    const msg = buildDraftUserMessage({ history: THREAD, messageType: 'reply', action: 'propose_test' });
    expect(msg).not.toContain('Инструкция для этой вакансии');
  });
});

describe('historySignature — an edited instruction invalidates cached drafts', () => {
  it('empty instruction keeps the pre-#112 signature byte-identical', () => {
    expect(historySignature(THREAD)).toBe(historySignature(THREAD, ''));
  });

  it('the same instruction keeps a cached draft fresh', () => {
    const h = {
      messages: THREAD,
      ats_result: { score: 7.5, verdict: 'ПРОПУСТИТЬ', draft_message: 'Спасибо!', draft_history_sig: historySignature(THREAD, INSTR) },
    };
    expect(isDraftStale(h, INSTR)).toBe(false);
  });

  it('a changed instruction makes the same thread stale', () => {
    const h = {
      messages: THREAD,
      ats_result: { score: 7.5, verdict: 'ПРОПУСТИТЬ', draft_message: 'Спасибо!', draft_history_sig: historySignature(THREAD, 'Старый процесс') },
    };
    expect(isDraftStale(h, INSTR)).toBe(true);
  });
});
// Issue #121: the writer was told "ask only about must-haves" but was never told what
// they ARE. vacancyContext came from the raw HH description (a field the ATS editor does
// not write), so a vacancy with 4 required criteria produced a prompt with zero of them.
// buildMessageSystemPrompt now always appends the criteria block, from the same config
// the planner reads.
describe('required criteria reach the writer system prompt (#121)', () => {
  const ARRAY_CFG = {
    required: [
      { name: 'опыт работы с карточками детской одежды на WB от 2 лет', weight: 3 },
      { name: 'настройка и оптимизация внутренней рекламы WB', weight: 3 },
    ],
    preferred: [{ name: 'работа в MPStats или Moneyplace', weight: 1.5 }],
  };
  // The shape the legacy singleton on disk actually uses.
  const ITEM_CFG = {
    required: { item: [{ name: 'опыт работы с Wildberries от 2 лет', weight: '3' }] },
    preferred: { item: [{ name: 'понимание товара и трендов', weight: '1.5' }] },
  };

  it('includes every required criterion, even with no vacancyContext', () => {
    const p = buildMessageSystemPrompt({ atsConfig: ARRAY_CFG });
    expect(p).toContain('## Обязательные требования вакансии');
    expect(p).toContain('опыт работы с карточками детской одежды на WB от 2 лет');
    expect(p).toContain('настройка и оптимизация внутренней рекламы WB');
    expect(p).toContain('работа в MPStats или Moneyplace');
  });

  it('reads the legacy {item:[…]} shape the same way the planner does', () => {
    const p = buildMessageSystemPrompt({ atsConfig: ITEM_CFG });
    expect(p).toContain('опыт работы с Wildberries от 2 лет');
    expect(p).toContain('понимание товара и трендов');
  });

  it('keeps the block when the config is empty — an empty list is a fact, not a hole', () => {
    const p = buildMessageSystemPrompt({});
    expect(p).toContain('## Обязательные требования вакансии');
    expect(p).toContain('(не указано)');
  });

  it('the criteria block is independent of vacancyContext and precedes identity/style', () => {
    const p = buildMessageSystemPrompt({
      vacancyContext: 'RAW HH TEXT', recruiterCtx: 'ID', commStyle: 'STYLE',
      vacancyInstruction: 'INSTR', atsConfig: ARRAY_CFG,
    });
    expect(p).toContain('RAW HH TEXT');
    expect(p).toContain('## Обязательные требования вакансии');
    expect(p.indexOf('## Контекст вакансии')).toBeLessThan(p.indexOf('## Обязательные требования вакансии'));
    expect(p.indexOf('## Обязательные требования вакансии')).toBeLessThan(p.indexOf('## Идентичность рекрутера'));
    expect(p.indexOf('## Идентичность рекрутера')).toBeLessThan(p.indexOf('## Инструкция для этой вакансии'));
  });
});
