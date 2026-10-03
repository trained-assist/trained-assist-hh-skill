// One LLM entry point for the whole HH skill — and a guard that keeps it that way.
//
// Production incident this encodes: every module had its own OpenRouter/GigaChat copy
// and its own key resolver. The resolvers returned the PER-USER key file whenever it
// existed, so one dead personal key (401 «User not found») shadowed the working shared
// credential and silently killed background scoring, the message guard and the criteria
// guard — each in its own copy, each logging a different symptom.
//
// Routing (owner 2026-10-01): messages → 'conversation', primitive evaluations →
// 'free', everything else → 'service'.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hhLlm, ladderFor } = require('../../src/hh-llm');

const SRC = join(process.cwd(), 'src');

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...sourceFiles(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

describe('hh-llm routing', () => {
  it('routes by purpose', () => {
    expect(ladderFor('message')).toBe('conversation');
    expect(ladderFor('score')).toBe('free');
    expect(ladderFor('default')).toBe('service');
    // An unknown purpose must never silently pick the model tier.
    expect(ladderFor('something-else')).toBe('service');
    expect(ladderFor(undefined)).toBe('service');
  });

  it('sends the ladder name as the model field and returns content', async () => {
    let sent = null;
    const fetchImpl = async (url, init) => {
      sent = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ model: sent.model, choices: [{ message: { content: 'ок' } }] }) };
    };
    process.env.LLM_LADDER_TOKEN = 'test-token';
    try {
      const text = await hhLlm({ messages: [{ role: 'user', content: 'x' }], purpose: 'score', fetchImpl });
      expect(text).toBe('ок');
      expect(sent.model).toBe('free');
    } finally {
      delete process.env.LLM_LADDER_TOKEN;
    }
  });
});

describe('no direct LLM transports left in the skill', () => {
  const files = sourceFiles(SRC);
  const offenders = [];

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    // The single ladder client is the only allowed place to know the ladder host.
    if (file.endsWith(join('src', 'llm-ladder.js')) || file.endsWith(join('src', 'hh-llm.js'))) continue;
    if (/openrouter\.ai|gigachat|ngw\.devices\.sberbank|api\.openai\.com/.test(text)) {
      offenders.push(`${file.replace(process.cwd() + '/', '')}: direct provider host`);
    }
    // Reading a per-user OpenRouter key file is the exact failure: the file existed but
    // the key inside was dead, so the working shared credential was never reached.
    if (/openrouter'\)/.test(text)) {
      offenders.push(`${file.replace(process.cwd() + '/', '')}: per-user openrouter key file`);
    }
  }

  it('finds no direct provider call or per-user key read', () => {
    expect(offenders).toEqual([]);
  });
});