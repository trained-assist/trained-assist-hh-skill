'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Ajv = require('ajv');
const { createFixture } = require('../support/hh-fixture.cjs');
const { ActionProviderRegistry } = require('../../contracts/core/action-provider-registry.cjs');
const manifest = require('../../provider-manifest.json');
const actionManifest = require('../../action-provider-manifest.json');

test('real core consumer accepts manifest, rejects incompatible data and policies', () => {
  assert.deepEqual(actionManifest, require('../../scripts/build-manifest.cjs').buildActionManifest());
  assert.deepEqual(actionManifest.actions, manifest.actions.map(({ description, ...action }) => action));
  const registry = new ActionProviderRegistry();
  assert.equal(registry.register(actionManifest).length, manifest.actions.length);
  assert.equal(registry.validateCall('hh_proactive_search', { vacancy_id: '100' }, 'user').providerId, 'hh');
  assert.throws(() => registry.validateCall('hh_proactive_search', { vacancy_id: 100 }, 'user'), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => registry.validateCall('hh_send_message', {}, 'cron'), { code: 'FORBIDDEN' });
  for (const mutate of [
    m => { m.actions[0].inputSchema = { type: 'nonsense' }; },
    m => { m.actions.push(m.actions[0]); },
    m => { m.actions.find(a => a.name === 'hh_send_message').requiresApproval = false; },
    m => { m.actions.find(a => a.effect === 'read').retrySafety = 'unsafe'; },
  ]) {
    const invalid = structuredClone(actionManifest); mutate(invalid);
    const isolated = new ActionProviderRegistry();
    assert.throws(() => isolated.register(invalid));
    assert.equal(isolated.list().length, 0, 'rejected registration must not leak actions');
  }
});

for (const connected of [false, true]) test(`MCP executable discovery, schemas and calls (connected=${connected})`, async () => {
  const f = await createFixture({ connected });
  try {
    const init = await f.client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ci', version: '1' } });
    assert.deepEqual(init.result.capabilities.tools, {});
    f.client.notify('notifications/initialized');
    const reply = await f.client.request('tools/list');
    const tools = reply.result.tools;
    assert.equal(new Set(tools.map(t => t.name)).size, tools.length);
    assert(tools.some(t => t.name === 'hh_connect'));
    assert.equal(tools.some(t => t.name === 'hh_proactive_search'), connected);
    if (connected) assert.deepEqual(tools.map(t => t.name).sort(), manifest.actions.map(t => t.name).sort());
    for (const tool of tools) {
      assert(tool.description?.trim());
      assert.deepEqual(tool.inputSchema, manifest.actions.find(a => a.name === tool.name).inputSchema);
      new Ajv({ strict: false }).compile(tool.inputSchema);
    }
    if (connected) {
      const result = await f.client.call('hh_list_vacancies');
      assert.equal(result.total, 1);
      assert.deepEqual(result.vacancies.map(v => [v.id, v.name, v.manager]), [['100', 'Инженер Node.js', 'Тестовый рекрутер']]);
      assert.equal(f.requests[0].auth, 'Bearer fixture-only');
    } else assert.equal((await f.client.call('hh_status')).connected, false);
    const bad = await f.client.request('tools/call', { name: 'does_not_exist', arguments: {} });
    assert.equal(typeof bad.error?.code, 'number'); assert(!bad.result);
    assert.equal((await f.client.request('nonexistent')).error.code, -32601);
    assert((await f.client.request('tools/list')).result.tools.length, 'errors must not kill provider');
    assert.deepEqual(f.unexpected, []);
  } finally { await f.close(); }
});

// The refusal wording depends on which guard is preloaded: Nock's
// disableNetConnect in per-layer CI jobs, or scripts/staging/isolation-guard.cjs
// in the replay gate. Either way the outbound attempt must be denied.
const DENIED = /Disallowed net connect|STAGING_OUTBOUND_BLOCKED/;
test('network canary: both fetch and Node HTTP are denied without a fixture', async () => {
  await assert.rejects(fetch('https://api.hh.ru/me'), DENIED);
  await assert.rejects(new Promise((resolve, reject) => http.get('http://api.hh.ru/me', resolve).on('error', reject)), DENIED);
});

test('live smoke fails without secret, uses only GET, exposes no private content', async () => {
  const { run } = require('../../scripts/live-hh-smoke.cjs');
  await assert.rejects(run({ token: '' }), /required/);
  const calls = [];
  const result = await run({ token: 'fake', request: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.endsWith('/me') ? { employer: { id: '123' }, email: 'private@example.invalid' } : { found: 4, items: [{ name: 'private vacancy' }] } };
  } });
  assert.deepEqual(result, { ok: true, vacancies: 4 });
  assert.equal(calls.length, 2); assert(calls.every(c => c.options.method === 'GET' && c.options.redirect === 'error'));
  await assert.rejects(run({ token: 'fake', request: async () => ({ ok: false, status: 403 }) }), /403/);
});
