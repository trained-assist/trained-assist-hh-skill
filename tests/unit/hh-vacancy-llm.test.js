// Vacancy generation must run on OUR ladder, on the default rung — never a direct
// OpenRouter call with a per-user key (that path is what died in production), and
// never the Claude/Sonnet tier that made vacancy generation the single most
// expensive call site in the 2026-09-22 cost audit.
//
// The ladder endpoint is intercepted with nock (no real network) and the request body
// tells us which ladder was requested.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nock from 'nock';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { generateVacancyFromMessages } = require('../../src/hh-vacancy.js');

const LADDER = 'https://llm-ladder.trainedassist.store';
const DRAFT = { name: 'Backend Developer', description_md: 'Node.js' };

let sentModel;

beforeEach(() => {
  sentModel = null;
  process.env.LLM_LADDER_TOKEN = 'test-ladder-token';
});

afterEach(() => {
  nock.cleanAll();
  delete process.env.LLM_LADDER_TOKEN;
});

function mockLadder() {
  nock(LADDER)
    .post('/v1/chat/completions', body => { sentModel = body.model; return true; })
    .reply(200, (_uri, _body) => ({ model: sentModel, choices: [{ message: { content: JSON.stringify(DRAFT) } }] }));
}

describe('generateVacancyFromMessages LLM routing', () => {
  it('asks the DEFAULT ladder, never claude/sonnet', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-vac-llm-'));
    mockLadder();
    try {
      // No credentials passed: the ladder token is the only credential the skill needs.
      const reply = await generateVacancyFromMessages(workDir, ['Ищем бэкенд-разработчика']);
      expect(sentModel).toBe('service');
      expect(sentModel).not.toMatch(/claude|sonnet/i);
      expect(reply).toContain('Backend Developer');
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('reports a ladder failure instead of falling back to a dead key', async () => {
    nock(LADDER).post('/v1/chat/completions').reply(500, { error: { message: 'all rungs down' } });
    await expect(generateVacancyFromMessages('/tmp/hh-vac-llm-fail', ['x']))
      .rejects.toThrow(/llm-ladder HTTP 500/);
  });
});