'use strict';

// Preload (node --require) for tests/behavior/empty-result.test.cjs: replaces the
// real src/mcp-skills/registry.js in require.cache with a stub exposing one
// `probe` tool that echoes args.value verbatim (undefined when absent), so the
// real MCP server's tools/call envelope can be driven with arbitrary results.

const path = require('path');
const Module = require('module');

const registryPath = path.resolve(__dirname, '../../src/mcp-skills/registry.js');
const stub = new Module(registryPath, module);
stub.filename = registryPath;
stub.loaded = true;
stub.exports = {
  listTools: () => [{ name: 'probe', description: 'probe', inputSchema: { type: 'object' } }],
  callTool: async (name, args) => args.value,
};
require.cache[registryPath] = stub;
