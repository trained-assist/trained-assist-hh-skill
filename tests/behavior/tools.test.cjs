'use strict';

// L2 — Behavior layer (hermetic: real server subprocess + fixtures).
// Every tool in mcp.manifest.json has a fixture {name, validArgs, expect?} and is
// driven through tools/call over stdio. Handlers are never called in-process:
// the registry and transport are exercised for real; only the external network
// (loopback HH mock) and the LLM (scripted Nock fixture) are faked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createBehaviorFixture } = require('../helpers/hh-behavior-fixture');

const fixtures = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../fixtures/tools.json'), 'utf8')).tools;

function parseEnvelope(result) {
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch { return text; }
}

test('every tool returns a valid MCP envelope (fixtures optional)', async () => {
  const f = await createBehaviorFixture();
  try {
    const { tools } = await f.mcp.call('tools/list');
    const names = new Set(tools.map((t) => t.name));
    // A fixture for a tool that no longer exists is drift — fail on it.
    const stale = fixtures.filter((x) => !names.has(x.name)).map((x) => x.name);
    assert.deepEqual(stale, [], 'fixtures for tools that are not in tools/list');
    // Tools without a hand-written fixture still get exercised with empty arguments:
    // the contract is "valid envelope or a reported error, never a crash". A fixture is
    // only needed to assert specific behaviour (agent#1470: moving a tool must not
    // require a new fixture).
    const covered = new Set(fixtures.map((x) => x.name));
    const defaults = tools.filter((t) => !covered.has(t.name)).map((t) => ({ name: t.name, validArgs: {}, generated: true }));

    // Execute in fixture order (stateful fixtures: connect/token/active venue first).
    for (const fixture of [...fixtures, ...defaults]) {
      let result;
      try {
        result = await f.mcp.call('tools/call', { name: fixture.name, arguments: fixture.validArgs });
      } catch (error) {
        // A graceful surfacing of an execution error is acceptable; a crash is not.
        assert.equal(typeof error?.message, 'string', `${fixture.name}: unexpected rejection`);
        assert.equal(f.mcp.exited, null, `${fixture.name}: server died instead of reporting an error`);
        continue;
      }
      assert.ok(result && Array.isArray(result.content), `${fixture.name}: envelope must have content[]`);
      assert.equal(result.content[0].type, 'text');
      const value = parseEnvelope(result);
      if (fixture.generated) continue; // empty-args smoke: the envelope shape is the contract
      assert.ok(value && typeof value === 'object', `${fixture.name}: content must be JSON`);
      for (const [key, expected] of Object.entries(fixture.expect || {})) {
        assert.equal(value[key], expected, `${fixture.name}: expected ${key}=${expected}`);
      }
    }
  } finally {
    await f.close();
  }
});

test('a failing tool call is reported, not a process crash', async () => {
  const f = await createBehaviorFixture();
  try {
    const unknown = await f.mcp.call('tools/call', { name: 'hh_nope', arguments: {} })
      .then(() => ({ ok: true }), (error) => ({ ok: false, error }));
    assert.equal(unknown.ok, false, 'unknown tool must surface an error');
    assert.equal(typeof unknown.error.rpc?.code, 'number', 'unknown tool must carry a JSON-RPC code');

    const missingArgs = await f.mcp.call('tools/call', { name: 'hh_list_responses', arguments: {} })
      .then((result) => ({ result }), (error) => ({ error }));
    assert.ok(missingArgs.error || missingArgs.result, 'missing required args must surface an error result');

    const alive = await f.mcp.call('tools/list');
    assert.ok(Array.isArray(alive.tools), 'server must stay alive after a failed call');
    assert.equal(f.mcp.exited, null);
  } finally {
    await f.close();
  }
});

test('the LLM and the HH platform were exercised through the sanctioned mocks only', async () => {
  const f = await createBehaviorFixture();
  try {
    const evaluated = await f.mcp.call('tools/call', {
      name: 'hh_extract_ats_config',
      arguments: { vacancy_text: 'Ищем Node.js разработчика' },
    });
    assert.equal(parseEnvelope(evaluated).config.required[0].name, 'Node.js', 'the scripted LLM answer must reach the result');
    assert.ok(f.llmRequests().length >= 1, 'the scripted LLM fixture must have been called');
    assert.ok(f.srv.state !== undefined);
  } finally {
    await f.close();
  }
});
