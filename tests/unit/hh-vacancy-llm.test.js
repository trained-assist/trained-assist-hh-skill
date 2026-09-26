// Ported from core #1142: vacancy generation must never call the Claude/Sonnet
// tier on OpenRouter. Primary is GigaChat-Ultra; the OpenRouter fallback is the
// cheap FALLBACK_MODEL. OpenRouter is intercepted with nock (no real network).

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nock from 'nock';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { generateVacancyFromMessages } = require('../../src/hh-vacancy.js');
const { FALLBACK_MODEL } = require('../../src/hh-scoring.js');

const DRAFT = { name: 'Backend Developer', description: 'Node.js' };

afterEach(() => nock.cleanAll());

describe('generateVacancyFromMessages LLM routing', () => {
  it('falls back to the cheap OpenRouter model, never claude-sonnet', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-vac-llm-'));
    let sentModel;
    nock('https://openrouter.ai')
      .post('/api/v1/chat/completions', body => { sentModel = body.model; return true; })
      .reply(200, { choices: [{ message: { content: JSON.stringify(DRAFT) } }] });
    try {
      // No username → no GigaChat key lookup → OpenRouter fallback.
      const reply = await generateVacancyFromMessages(workDir, ['Ищем бэкенд-разработчика'], 'or-test-key');
      expect(sentModel).toBe(FALLBACK_MODEL);
      expect(sentModel).not.toMatch(/claude|sonnet/i);
      expect(reply).toContain('Backend Developer');
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('fails clearly when neither GigaChat nor OpenRouter credentials exist', async () => {
    const prev = process.env.GIGACHAT_API_KEY;
    delete process.env.GIGACHAT_API_KEY;
    try {
      await expect(generateVacancyFromMessages('/nonexistent', ['x'], null, 'no-such-user'))
        .rejects.toThrow(/Neither GIGACHAT nor OPENROUTER/);
    } finally {
      if (prev !== undefined) process.env.GIGACHAT_API_KEY = prev;
    }
  });
});
