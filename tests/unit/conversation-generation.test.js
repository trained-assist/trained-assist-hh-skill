// Unit tests for the conversation-generation layer (src/conversation-generation.js)
// and its ladder client (src/llm-ladder.js) — the abstraction every candidate-message
// write goes through. Two things are pinned here:
//   1. model selection — ladder name + optional rung pin travel in the request body,
//      read from env at call time (HH_CONVERSATION_LADDER / HH_CONVERSATION_RUNG);
//   2. the last N question/answer exchanges are kept — in memory AND as JSONL —
//      which is what the future bench replays.
// All LLM traffic → nock interception (https://llm-ladder.trainedassist.store).

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import nock from 'nock';

const require = createRequire(import.meta.url);
const conv = require('../../src/conversation-generation.js');
const { ladderChat, ladderToken } = require('../../src/llm-ladder.js');

const TOKEN = 'fixture-ladder-token';
const LADDER = 'https://llm-ladder.trainedassist.store';

let tmp;
let historyFile;
const ENV_KEYS = ['LLM_LADDER_TOKEN', 'HH_CONVERSATION_LADDER', 'HH_CONVERSATION_RUNG',
  'HH_CONVERSATION_HISTORY_LIMIT', 'HH_CONVERSATION_HISTORY_FILE', 'AGENT_DATA_DIR'];

function mockLadder(content, { model = 'openrouter/google/gemini-3.1-flash-lite-preview', status = 200, body = null, reqheaders = null } = {}) {
  return nock(LADDER, reqheaders ? { reqheaders } : {})
    .post('/v1/chat/completions')
    .reply(status, (_uri, reqBody) => {
      if (status !== 200) return body ?? { error: { message: 'boom', type: 'ladder_error' } };
      if (typeof content === 'function') return content(reqBody);
      return { choices: [{ message: { content } }], model, usage: { prompt_tokens: 1, completion_tokens: 2 } };
    });
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hh-convg-'));
  historyFile = join(tmp, 'conversation-history.jsonl');
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
});

afterAll(() => {
  nock.cleanAll();
  nock.enableNetConnect();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.LLM_LADDER_TOKEN = TOKEN;
  process.env.AGENT_DATA_DIR = join(tmp, 'data'); // keeps the default history path out of the real HOME
  delete process.env.HH_CONVERSATION_LADDER;
  delete process.env.HH_CONVERSATION_RUNG;
  delete process.env.HH_CONVERSATION_HISTORY_LIMIT;
  process.env.HH_CONVERSATION_HISTORY_FILE = historyFile;
  conv.clearConversationHistory();
  rmSync(historyFile, { force: true }); // each test owns its file — the JSONL assertions are exact
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  nock.cleanAll();
});

const MSG = (q) => [{ role: 'system', content: 'sys' }, { role: 'user', content: q }];

describe('model selection', () => {
  it('sends the default conversations ladder, token and attribution', async () => {
    let seen;
    // auth + attribution ride as required headers: no match → no interceptor → the call fails
    mockLadder((body) => { seen = body; return { choices: [{ message: { content: 'Здравствуйте!' } }], model: 'openrouter/google/gemini-3.1-flash-lite-preview' }; },
      { reqheaders: { authorization: `Bearer ${TOKEN}`, 'x-ladder-app': 'hh-test' } });

    const out = await conv.generateConversation({ messages: MSG('q1'), source: 'hh-test' });

    expect(out).toBe('Здравствуйте!');
    expect(seen.model).toBe('conversations');
    expect(seen.ladder_rung).toBeUndefined();
    expect(seen.messages).toEqual(MSG('q1'));
    expect(seen.temperature).toBe(0.7);
    expect(seen.max_tokens).toBe(800);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('HH_CONVERSATION_LADDER swaps the ladder (plug another one in)', async () => {
    process.env.HH_CONVERSATION_LADDER = 'free-ladder';
    let seen;
    mockLadder((body) => { seen = body; return { choices: [{ message: { content: 'ok' } }], model: 'free' }; });

    await conv.generateConversation({ messages: MSG('q') });

    expect(seen.model).toBe('free-ladder');
  });

  it('HH_CONVERSATION_RUNG pins one model in the body (per-call switch / bench)', async () => {
    process.env.HH_CONVERSATION_RUNG = 'openrouter/google/gemini-2.5-flash';
    let seen;
    mockLadder((body) => { seen = body; return { choices: [{ message: { content: 'ok' } }], model: 'openrouter/google/gemini-2.5-flash' }; });

    await conv.generateConversation({ messages: MSG('q') });

    expect(seen.model).toBe('conversations');
    expect(seen.ladder_rung).toBe('openrouter/google/gemini-2.5-flash');
  });

  it('per-call ladder/rung arguments win over env', async () => {
    process.env.HH_CONVERSATION_LADDER = 'service';
    let seen;
    mockLadder((body) => { seen = body; return { choices: [{ message: { content: 'ok' } }], model: 'x' }; });

    await conv.generateConversation({ messages: MSG('q'), ladder: 'conversations', rung: 'opencode-go/mimo-v2.6-flash' });

    expect(seen.model).toBe('conversations');
    expect(seen.ladder_rung).toBe('opencode-go/mimo-v2.6-flash');
  });

  it('no token → refuses before any network', async () => {
    delete process.env.LLM_LADDER_TOKEN;
    await expect(conv.generateConversation({ messages: MSG('q') })).rejects.toThrow(/no token/);
  });

  it('worker error → throws with attempts, and the exchange is NOT recorded', async () => {
    mockLadder(null, { status: 502, body: { error: { message: 'ladder down', type: 'ladder_error', attempts: [{ model: 'openrouter/google/gemini-3.1-flash-lite-preview', outcome: 'error' }] } } });

    await expect(conv.generateConversation({ messages: MSG('q') })).rejects.toThrow(/HTTP 502: ladder down/);
    expect(conv.conversationHistory()).toHaveLength(0);
    expect(existsSync(historyFile)).toBe(false);
  });

  it('empty content → throws, nothing recorded', async () => {
    mockLadder('   ');
    await expect(conv.generateConversation({ messages: MSG('q') })).rejects.toThrow(/empty content/);
    expect(conv.conversationHistory()).toHaveLength(0);
  });
});

describe('Q/A history for the bench', () => {
  it('keeps each question and answer with the serving rung', async () => {
    mockLadder('Ответ 1', { model: 'openrouter/google/gemini-3.1-flash-lite-preview' });
    await conv.generateConversation({ messages: MSG('Вопрос 1') });

    const h = conv.conversationHistory();
    expect(h).toHaveLength(1);
    expect(h[0].messages).toEqual(MSG('Вопрос 1'));
    expect(h[0].answer).toBe('Ответ 1');
    expect(h[0].model).toBe('openrouter/google/gemini-3.1-flash-lite-preview');
    expect(h[0].ladder).toBe('conversations');
    expect(h[0].temperature).toBe(0.7);
    expect(Date.parse(h[0].ts)).not.toBeNaN();
  });

  it('holds only the last N exchanges (ring, oldest dropped)', async () => {
    process.env.HH_CONVERSATION_HISTORY_LIMIT = '3';
    for (let i = 1; i <= 5; i++) {
      mockLadder(`Ответ ${i}`);
      await conv.generateConversation({ messages: MSG(`Вопрос ${i}`) });
    }

    const h = conv.conversationHistory();
    expect(h).toHaveLength(3);
    expect(h.map(e => e.messages[1].content)).toEqual(['Вопрос 3', 'Вопрос 4', 'Вопрос 5']);
    expect(h.map(e => e.answer)).toEqual(['Ответ 3', 'Ответ 4', 'Ответ 5']);
  });

  it('appends every exchange to the JSONL file (what the bench reads)', async () => {
    mockLadder('Ответ 1');
    await conv.generateConversation({ messages: MSG('Вопрос 1') });
    mockLadder('Ответ 2');
    await conv.generateConversation({ messages: MSG('Вопрос 2') });

    expect(conv.conversationHistoryFile()).toBe(historyFile);
    const lines = readFileSync(historyFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const rows = lines.map(l => JSON.parse(l));
    expect(rows[1].messages).toEqual(MSG('Вопрос 2'));
    expect(rows[1].answer).toBe('Ответ 2');
    expect(rows[1].model).toBe('openrouter/google/gemini-3.1-flash-lite-preview');
    expect(rows.every(r => typeof r.ts === 'string')).toBe(true);
  });

  it('clearConversationHistory drops the buffer but never the file', async () => {
    mockLadder('Ответ 1');
    await conv.generateConversation({ messages: MSG('Вопрос 1') });

    conv.clearConversationHistory();
    expect(conv.conversationHistory()).toHaveLength(0);
    expect(readFileSync(historyFile, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('llm-ladder client', () => {
  it('token resolves from env', () => {
    expect(ladderToken()).toBe(TOKEN);
  });

  it('messages are required', async () => {
    await expect(ladderChat({ messages: [], ladder: 'conversations' })).rejects.toThrow(/messages required/);
  });

  it('unreachable worker → wrapped error', async () => {
    await expect(ladderChat({ messages: MSG('q'), fetchImpl: async () => { throw new Error('network down'); } }))
      .rejects.toThrow(/llm-ladder unreachable: network down/);
  });
});
