'use strict';

// The worker serves many profiles in one process, and the skill's tool modules
// capture the profile (USER_ID) when they load. Two things must hold:
//   1. the profile is in the environment BEFORE the registry is loaded —
//      otherwise the worker exposes no HH tools at all;
//   2. the profile-scoped modules are re-loaded per call — otherwise the first
//      profile answers every later call.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const HH_TOOL = 'hh_generate_message_to_applicant';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hh-worker-scope-'));
}

async function withEnv(overrides, fn) {
  const previous = { ...process.env };
  Object.assign(process.env, overrides);
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

function loadRegistry() {
  return require(path.join(REPO, 'src/mcp-skills/registry'));
}

function hasHhTool(registry) {
  return registry.listTools().some(tool => tool.name === HH_TOOL);
}

test('the profile-scoped modules are dropped from the require cache', async () => {
  const root = tempRoot();
  try {
    const tokens = path.join(root, 'agent-tokens');
    fs.mkdirSync(path.join(tokens, 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(tokens, 'alpha', 'hh'), JSON.stringify({ access_token: 'test-token' }));

    const { purgeProfileScopedModules } = require(path.join(REPO, 'src/hh-worker-host'));
    await withEnv({ AGENT_TOKENS_DIR: tokens }, () => {
      purgeProfileScopedModules();
      process.env.USER_ID = 'alpha';
      assert.ok(hasHhTool(loadRegistry()), 'a profile with a credential must see the HH tools');

      // The cached module still answers for the first profile — the leak the
      // purge prevents.
      process.env.USER_ID = 'beta';
      assert.ok(hasHhTool(loadRegistry()), 'without the purge the cached module still answers');

      purgeProfileScopedModules();
      assert.ok(!hasHhTool(loadRegistry()), 'after the purge the profile is read again');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the worker host calls the tool of the profile it was given', async () => {
  const root = tempRoot();
  try {
    const tokens = path.join(root, 'agent-tokens');
    fs.mkdirSync(path.join(tokens, 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(tokens, 'alpha', 'hh'), JSON.stringify({ access_token: 'test-token' }));

    const { createHost, purgeProfileScopedModules } = require(path.join(REPO, 'src/hh-worker-host'));
    await withEnv({
      AGENT_TOKENS_DIR: tokens,
      USERS_DIR: path.join(root, 'users'),
      AGENT_DATA_DIR: path.join(root, 'data'),
    }, async () => {
      purgeProfileScopedModules();
      const ctx = createHost({ env: process.env });

      const alpha = await ctx.runMcpTool({
        tool: HH_TOOL,
        params: { negotiation_id: '1' },
        username: 'alpha',
        timeoutMs: 15_000,
      });
      assert.ok(!/Unknown tool/.test(String(alpha)), `the HH tool must be found for a profile with a credential: ${alpha}`);

      // A profile without a credential has no HH tools — and the profile of the
      // previous call must not leak into it.
      await assert.rejects(
        () => ctx.runMcpTool({
          tool: HH_TOOL,
          params: { negotiation_id: '1' },
          username: 'beta',
          timeoutMs: 15_000,
        }),
        /Unknown tool/,
        'a profile without a credential must not see the HH tools',
      );
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
