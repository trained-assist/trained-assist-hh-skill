'use strict';

// L2 — the real MCP server must never return an empty tools/call text to the
// model (agent#1481). The registry is stubbed via a --require preload so the
// probe tool can return undefined/''/[]/{}/null; the server and transport are real.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startMcp } = require('../helpers/mcp');

const PRELOAD = path.resolve(__dirname, '../helpers/stub-registry-preload.cjs');

const EMPTY_CASES = [
  ['absent (undefined)', {}],
  ['empty string', { value: '' }],
  ['whitespace string', { value: '   ' }],
  ['empty array', { value: [] }],
  ['empty object', { value: {} }],
  ['null', { value: null }],
];

test('tools/call never returns a blank text for empty results', async () => {
  const mcp = await startMcp({ nodeArgs: ['--require', PRELOAD] });
  try {
    const { tools } = await mcp.call('tools/list');
    assert.deepEqual(tools.map((t) => t.name), ['probe'], 'stub registry must be active');

    for (const [label, args] of EMPTY_CASES) {
      const result = await mcp.call('tools/call', { name: 'probe', arguments: args });
      const text = result?.content?.[0]?.text;
      assert.equal(typeof text, 'string', `${label}: content[0].text must be a string`);
      assert.ok(text.trim(), `${label}: text must not be blank`);
      assert.match(text, /пустой результат/, `${label}: must carry the empty-result marker`);
      assert.match(text, /probe/, `${label}: marker must name the tool`);
    }

    const ok = await mcp.call('tools/call', { name: 'probe', arguments: { value: { ok: 1 } } });
    const okText = ok?.content?.[0]?.text;
    assert.deepEqual(JSON.parse(okText), { ok: 1 }, 'non-empty result must pass through as JSON');
    assert.doesNotMatch(okText, /пустой результат/);

    assert.match(mcp.stderr, /\[mcp\] tool probe returned an empty result/);
  } finally {
    await mcp.stop();
  }
});
