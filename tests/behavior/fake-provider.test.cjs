'use strict';

// Smoke test for the vendored deterministic external-provider fake
// (fixtures/providers/fake-provider-mcp.js). It is the sanctioned way to stand
// in for an external MCP provider — never the registry/service under test.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startMcp } = require('../helpers/mcp');

const FAKE = path.resolve(__dirname, '../../fixtures/providers/fake-provider-mcp.js');

test('fake provider answers initialize / tools/list / tools/call deterministically', async () => {
  const mcp = await startMcp({ entrypoint: FAKE });
  try {
    const { tools } = await mcp.call('tools/list');
    assert.deepEqual(tools.map((t) => t.name), ['marker_read']);
    const result = await mcp.call('tools/call', { name: 'marker_read', arguments: { q: 'x' } });
    assert.equal(JSON.parse(result.content[0].text).marker, 'x');
  } finally {
    await mcp.stop();
  }
});

test('fake provider can simulate a tool failure without crashing', async () => {
  const mcp = await startMcp({ entrypoint: FAKE, args: ['--fail-tool'] });
  try {
    const result = await mcp.call('tools/call', { name: 'marker_read', arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(mcp.exited, null);
  } finally {
    await mcp.stop();
  }
});
