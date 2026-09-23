// Unit tests for resolveHhPublicBase() in src/hh-quick.js — Cold Search Stage 4
// (multi-tenant stabilization, 2026-09-23): the public base URL used to build
// Cold Search / vacancy / review / ATS-editor links was previously read inline
// at 9 call sites via `process.env.AGENT_PUBLIC_URL || '<hardcoded default>'` —
// one global value shared by every tenant, no way for a single agency to publish
// under their own domain. This resolver adds a per-username file override on top
// of the existing HH_PLATFORM_URL / AGENT_PUBLIC_URL / default precedence chain.
//
// Isolation rigor mirrors tests/hh-proactive-multi-user-isolation.test.js: two
// distinct usernames, one with an override file and one without, asserting the
// override never leaks onto the other user.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function freshModule() {
  const resolved = require.resolve('../../src/hh-quick.js');
  if (require.cache[resolved]) delete require.cache[resolved];
  return require('../../src/hh-quick.js');
}

const ALICE = 'publish-domain-alice';
const BOB = 'publish-domain-bob';

let tokensDir;

beforeEach(() => {
  tokensDir = mkdtempSync(join(tmpdir(), 'hh-publish-domain-'));
  process.env.AGENT_TOKENS_DIR = tokensDir;
  // The ambient shell/CI env may already export AGENT_PUBLIC_URL / HH_PLATFORM_URL
  // (e.g. for a real deployment) — clear both so precedence-chain tests start clean.
  delete process.env.AGENT_PUBLIC_URL;
  delete process.env.HH_PLATFORM_URL;
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.AGENT_TOKENS_DIR;
  delete process.env.HH_PLATFORM_URL;
  delete process.env.AGENT_PUBLIC_URL;
  try { rmSync(tokensDir, { recursive: true, force: true }); } catch {}
});

describe('resolveHhPublicBase — precedence chain', () => {
  it('falls back to the caller-supplied default when nothing is configured', () => {
    const { resolveHhPublicBase } = freshModule();
    expect(resolveHhPublicBase(ALICE, 'https://default.example.test')).toBe('https://default.example.test');
  });

  it('AGENT_PUBLIC_URL overrides the default', () => {
    process.env.AGENT_PUBLIC_URL = 'https://agent.example.test/';
    const { resolveHhPublicBase } = freshModule();
    expect(resolveHhPublicBase(ALICE, 'https://default.example.test')).toBe('https://agent.example.test');
  });

  it('HH_PLATFORM_URL overrides AGENT_PUBLIC_URL', () => {
    process.env.AGENT_PUBLIC_URL = 'https://agent.example.test';
    process.env.HH_PLATFORM_URL = 'https://platform.example.test/';
    const { resolveHhPublicBase } = freshModule();
    expect(resolveHhPublicBase(ALICE, 'https://default.example.test')).toBe('https://platform.example.test');
  });

  it('per-username override file beats HH_PLATFORM_URL and AGENT_PUBLIC_URL', () => {
    process.env.AGENT_PUBLIC_URL = 'https://agent.example.test';
    process.env.HH_PLATFORM_URL = 'https://platform.example.test';

    const dir = join(tokensDir, ALICE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hh-publish-domain'), 'https://coldsearch.alice-agency.ru/\n');

    const { resolveHhPublicBase } = freshModule();
    expect(resolveHhPublicBase(ALICE, 'https://default.example.test')).toBe('https://coldsearch.alice-agency.ru');
  });

  it('trims whitespace and strips a trailing slash from the override file', () => {
    const dir = join(tokensDir, ALICE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hh-publish-domain'), '  https://coldsearch.alice-agency.ru/  \n');

    const { resolveHhPublicBase } = freshModule();
    expect(resolveHhPublicBase(ALICE, 'https://default.example.test')).toBe('https://coldsearch.alice-agency.ru');
  });

  it('an empty override file is treated as not set (falls through the chain)', () => {
    process.env.AGENT_PUBLIC_URL = 'https://agent.example.test';
    const dir = join(tokensDir, ALICE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hh-publish-domain'), '   \n');

    const { resolveHhPublicBase } = freshModule();
    expect(resolveHhPublicBase(ALICE, 'https://default.example.test')).toBe('https://agent.example.test');
  });

  it('no username given falls straight to env/default (no crash)', () => {
    process.env.AGENT_PUBLIC_URL = 'https://agent.example.test';
    const { resolveHhPublicBase } = freshModule();
    expect(resolveHhPublicBase(undefined, 'https://default.example.test')).toBe('https://agent.example.test');
  });
});

describe('resolveHhPublicBase — per-username isolation', () => {
  it('Alice\'s override file never leaks onto Bob, who falls through to env/default', () => {
    process.env.AGENT_PUBLIC_URL = 'https://agent.example.test';

    const aliceDir = join(tokensDir, ALICE);
    mkdirSync(aliceDir, { recursive: true });
    writeFileSync(join(aliceDir, 'hh-publish-domain'), 'https://coldsearch.alice-agency.ru');

    const { resolveHhPublicBase } = freshModule();

    expect(resolveHhPublicBase(ALICE, 'https://default.example.test')).toBe('https://coldsearch.alice-agency.ru');
    expect(resolveHhPublicBase(BOB, 'https://default.example.test')).toBe('https://agent.example.test');
    expect(resolveHhPublicBase(BOB, 'https://default.example.test')).not.toBe('https://coldsearch.alice-agency.ru');
  });

  it('two usernames with distinct override files each resolve to their own domain', () => {
    const aliceDir = join(tokensDir, ALICE);
    const bobDir = join(tokensDir, BOB);
    mkdirSync(aliceDir, { recursive: true });
    mkdirSync(bobDir, { recursive: true });
    writeFileSync(join(aliceDir, 'hh-publish-domain'), 'https://coldsearch.alice-agency.ru');
    writeFileSync(join(bobDir, 'hh-publish-domain'), 'https://jobs.bob-recruiting.ru');

    const { resolveHhPublicBase } = freshModule();

    expect(resolveHhPublicBase(ALICE, 'https://default.example.test')).toBe('https://coldsearch.alice-agency.ru');
    expect(resolveHhPublicBase(BOB, 'https://default.example.test')).toBe('https://jobs.bob-recruiting.ru');
  });
});

describe('savePublishDomain / loadPublishDomain', () => {
  it('round-trips a saved domain for one user without touching another', () => {
    const { savePublishDomain, loadPublishDomain } = freshModule();

    expect(loadPublishDomain(ALICE)).toBeNull();

    // savePublishDomain trims like hh-rejection-template does, but doesn't strip a
    // trailing slash on write — normalization to a canonical base happens at read
    // time in resolveHhPublicBase (see the test below), same division of concerns
    // as the rest of this file (hhBase() etc. normalize at the call site, not at write).
    savePublishDomain(ALICE, 'https://coldsearch.alice-agency.ru');
    expect(loadPublishDomain(ALICE)).toBe('https://coldsearch.alice-agency.ru');
    expect(loadPublishDomain(BOB)).toBeNull();

    const file = join(tokensDir, ALICE, 'hh-publish-domain');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('https://coldsearch.alice-agency.ru');
  });

  it('saved domain is picked up by resolveHhPublicBase over env vars', () => {
    process.env.AGENT_PUBLIC_URL = 'https://agent.example.test';
    const { savePublishDomain, resolveHhPublicBase } = freshModule();

    savePublishDomain(ALICE, 'https://coldsearch.alice-agency.ru');
    expect(resolveHhPublicBase(ALICE, 'https://default.example.test')).toBe('https://coldsearch.alice-agency.ru');
  });
});
