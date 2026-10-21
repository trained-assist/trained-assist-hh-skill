'use strict';

// The tools directory is scanned by file name. macOS writes AppleDouble
// metadata next to a file as `._name.js` — it ends with .js and is not
// JavaScript, so requiring it throws a syntax error and takes the whole tool
// surface down. The scan must skip dot-files.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const TOOLS_DIR = path.join(REPO, 'src', 'mcp-skills', 'tools');

function freshRegistry() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}mcp-skills${path.sep}`)) delete require.cache[key];
  }
  return require(path.join(REPO, 'src', 'mcp-skills', 'registry'));
}

test('the tool scan ignores macOS metadata files', () => {
  const junk = path.join(TOOLS_DIR, '._zz-appledouble-test.js');
  fs.writeFileSync(junk, 'not javascript at all\n');
  try {
    const registry = freshRegistry();
    const names = registry.listTools().map(tool => tool.name);
    assert.ok(names.length > 0, 'the registry must still expose its tools');
    assert.ok(!names.some(name => name.includes('appledouble')), 'the metadata file must not become a tool');
  } finally {
    fs.unlinkSync(junk);
  }
});

test('the tool surface is the same with and without a metadata file', () => {
  const before = freshRegistry().listTools().map(tool => tool.name).sort();
  const junk = path.join(TOOLS_DIR, '._zz-appledouble-test.js');
  fs.writeFileSync(junk, 'not javascript at all\n');
  try {
    const after = freshRegistry().listTools().map(tool => tool.name).sort();
    assert.deepEqual(after, before);
  } finally {
    fs.unlinkSync(junk);
  }
});
