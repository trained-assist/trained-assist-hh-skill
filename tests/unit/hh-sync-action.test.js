/**
 * hh_sync_messages extraction (issue #1209 / PR 2b) — parity + safety tests.
 *
 * syncMessagesAction (hh-sync-action.js) does not reimplement sync: it calls the
 * same fetchAllHhNegotiations/syncHhMessagesToHistory the background scoring loop
 * (runHhScoringForVacancy in hh-negotiations.js) already uses, through a scoped
 * capability (hh-capability.js) instead of a raw (dataDir, username) pair. These
 * tests prove that wiring is equivalent, not just that each piece works alone:
 *
 *   1. The action's own argument validation (missing vacancy_id, no token).
 *   2. Happy path — writes the candidate history file HH's message thread implies.
 *   3. PARITY — running the background loop's own syncHhMessagesToHistory against
 *      the same capability.dataRoot/userId afterwards is idempotent (0 new
 *      messages, same synced candidate) — both paths agree on where the file
 *      lives and what "already synced" means.
 *   4. The manifest classifies hh_sync_messages as declared in action-manifest.js
 *      (write/idempotent, cron+durable_task eligible) — the whole point of the
 *      extraction is that this action, unlike the other 37, can run outside a
 *      user-triggered call.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createHhCapability } = require('../../src/hh-capability');
const { syncMessagesAction } = require('../../src/hh-sync-action');
const { createHhNegotiations } = require('../../src/hh-negotiations');
const { createMockHhServer, DEFAULT_NEGOTIATIONS } = require('../helpers/mock-hh-server.js');
const { buildManifest, POLICY } = require('../../src/action-manifest');

const TEST_USER = 'hh-sync-action-test-88123';
const TOKEN_DIR = join(homedir(), 'agent-tokens', TEST_USER);
const DATA_DIR = process.env.AGENT_DATA_DIR || join(homedir(), 'agent-data');
const CAND_DIR = join(DATA_DIR, 'hh', TEST_USER, 'candidates');

// neg-001 has a seeded reply on the mock server's /negotiations/neg-001/messages
// route regardless of override content — give it counters.messages so the sync
// filter (`(n.counters?.messages || 0) > 0`) actually picks it up, matching what
// the real HH API reports for a negotiation with an unread thread.
const NEGOTIATIONS_WITH_MESSAGES = DEFAULT_NEGOTIATIONS.map(n =>
  n.id === 'neg-001' ? { ...n, counters: { ...n.counters, messages: 1 } } : n,
);

let mockHh;

beforeAll(async () => {
  mockHh = createMockHhServer({ negotiations: NEGOTIATIONS_WITH_MESSAGES });
  await mockHh.start();
  process.env.HH_API_BASE_URL = mockHh.baseUrl;

  mkdirSync(TOKEN_DIR, { recursive: true });
  writeFileSync(join(TOKEN_DIR, 'hh'), JSON.stringify({ access_token: 'test-token-fake', employer_id: 'emp-001' }), { mode: 0o600 });
});

afterAll(async () => {
  await mockHh.stop();
  delete process.env.HH_API_BASE_URL;
  try { rmSync(TOKEN_DIR, { recursive: true, force: true }); } catch {}
  try { rmSync(CAND_DIR, { recursive: true, force: true }); } catch {}
});

describe('syncMessagesAction — argument validation', () => {
  it('rejects a missing vacancy_id without touching HH', async () => {
    const capability = createHhCapability({ userId: TEST_USER });
    const result = await syncMessagesAction(capability, {});
    expect(result).toEqual({ ok: false, error: 'vacancy_id обязателен.' });
  });

  it('rejects a profile with no connected HH token', async () => {
    const capability = createHhCapability({ userId: 'hh-sync-action-no-token-user' });
    const result = await syncMessagesAction(capability, { vacancy_id: 'vac-001' });
    expect(result).toEqual({ ok: false, error: 'HH не подключён.' });
  });
});

describe('syncMessagesAction — happy path', () => {
  it('syncs the HH message thread into the same candidate history file the background loop writes', async () => {
    const capability = createHhCapability({ userId: TEST_USER });
    const result = await syncMessagesAction(capability, { vacancy_id: 'vac-001' });

    expect(result.ok).toBe(true);
    expect(result.synced).toBeGreaterThanOrEqual(1);
    expect(result.new_messages).toBeGreaterThanOrEqual(1);

    const history = JSON.parse(readFileSync(capability.candidateHistoryPath('neg-001'), 'utf8'));
    expect(history.messages.some(m => m.text === 'Здравствуйте, Алексей!' && m.role === 'employer')).toBe(true);
  });
});

describe('syncMessagesAction — parity with the background scoring loop', () => {
  it('is idempotent against runHhScoringForVacancy\'s own syncHhMessagesToHistory call on the same files', async () => {
    const capability = createHhCapability({ userId: TEST_USER });
    const before = JSON.parse(readFileSync(capability.candidateHistoryPath('neg-001'), 'utf8'));

    // Exactly the call shape runHhScoringForVacancy makes (hh-negotiations.js:219),
    // reusing the module's own factory the same way hh-sync-action.js does — not a
    // reimplementation, so this proves the two entry points agree on file location
    // (dataRoot/userId vs dataDir/username) and on "already synced" semantics.
    const bg = createHhNegotiations({ refreshHhToken: async () => null, readChatId: () => null, getSecretsCache: () => ({}) });
    const negotiations = await bg.fetchAllHhNegotiations('vac-001', 'test-token-fake');
    const bgResult = await bg.syncHhMessagesToHistory(capability.dataRoot, capability.userId, negotiations, 'test-token-fake', {
      incremental: false, cap: 15, maxConcurrent: 4,
    });

    expect(bgResult.synced).toBeGreaterThanOrEqual(1);
    expect(bgResult.newMessages).toBe(0); // already synced by the action call above — no duplicate messages

    const after = JSON.parse(readFileSync(capability.candidateHistoryPath('neg-001'), 'utf8'));
    expect(after).toEqual(before);
  });
});

describe('review-page incremental history sync', () => {
  it('does not starve a changed conversation after the first 15 negotiations', async () => {
    const root = join(DATA_DIR, 'hh-sync-incremental-test');
    const candidates = Array.from({ length: 20 }, (_, i) => ({
      id: i === 19 ? 'neg-001' : `review-extra-${i}`,
      updated_at: new Date(Date.now() - 60_000).toISOString(),
      counters: { messages: 1 },
    }));
    const bg = createHhNegotiations({ refreshHhToken: async () => null, readChatId: () => null, getSecretsCache: () => ({}) });

    try {
      const result = await bg.syncHhMessagesToHistory(root, TEST_USER, candidates, 'test-token-fake', {
        incremental: true,
        maxConcurrent: 4,
      });

      expect(result.synced).toBe(20);
      const history = JSON.parse(readFileSync(join(root, 'hh', TEST_USER, 'candidates', 'neg-001.json'), 'utf8'));
      expect(history.messages.some(m => m.text === 'Здравствуйте, Алексей!' && m.role === 'employer')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('action-manifest — hh_sync_messages classification', () => {
  it('declares hh_sync_messages as write/idempotent and cron+durable_task eligible', () => {
    expect(POLICY.hh_sync_messages).toEqual({
      effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: ['user', 'cron', 'durable_task'],
    });
  });

  it('includes hh_sync_messages in the built provider manifest for a connected profile', () => {
    // registry.js snapshots readiness at require() time (each tool module reads
    // USER_ID into a module-level const), so a manifest built under an ambient
    // process with no USER_ID would silently see only setup tools — buildManifest
    // is only meaningful when built inside a process that already has USER_ID
    // (and, for hh_sync_messages specifically, a connected token) set, exactly
    // like every other per-user mcp-skills/index.js child process in production
    // (mcp-action.js spawns one per call). Force a clean require here so this
    // test isn't at the mercy of whichever module happened to load first.
    const toolsDir = join(__dirname, '..', '..', 'src', 'mcp-skills', 'tools');
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(toolsDir) || key.endsWith('/mcp-skills/registry.js') || key.endsWith('/src/action-manifest.js')) {
        delete require.cache[key];
      }
    }
    process.env.USER_ID = TEST_USER;
    try {
      const manifest = require('../../src/action-manifest').buildManifest('hh');
      const action = manifest.actions.find(a => a.name === 'hh_sync_messages');
      expect(action).toBeTruthy();
      expect(action.allowedTriggers).toContain('cron');
      expect(manifest.actions.length).toBeGreaterThanOrEqual(38); // 37 pre-existing HH tools + this one
    } finally {
      delete process.env.USER_ID;
    }
  });
});
