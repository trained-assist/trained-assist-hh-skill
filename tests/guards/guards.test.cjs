'use strict';

// L3 — Guards: static mirrors of the core CI gates. Cheap tripwires that fail the
// build if a forbidden pattern re-enters src/ or the harness. They do not replace
// L1/L2; they stop the regressions those behavioral layers might not observe.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else if (entry.isFile() && abs.endsWith('.js')) out.push(abs);
  }
  return out;
}

const source = walk(SRC).map((file) => ({ file, rel: path.relative(ROOT, file), text: fs.readFileSync(file, 'utf8') }));

// HTML/page renderers embed client-side browser JS (fetch to same-origin
// endpoints), not server-side outbound calls — the timeout guard does not apply.
const isHtmlRenderer = (rel) => /(-html|-page)\.js$/.test(rel);

test('quick-action tools never spawn Claude / runner.js', () => {
  for (const { rel, text } of source) {
    assert.ok(!/require\(\s*['"]child_process['"]\s*\)|from\s+['"]child_process['"]/.test(text),
      `${rel} must not spawn external processes (quick-action tools never launch Claude)`);
    assert.ok(!/runner\.js/.test(text), `${rel} references runner.js`);
    assert.ok(!/\b(execFileSync|execFile|spawnSync|spawn)\s*\(\s*['"]claude['"]/.test(text), `${rel} spawns claude`);
  }
});

test('every outbound HTTP/fetch source declares a timeout', () => {
  const usesHttp = /(?:^|[^\w.])fetch\s*\(|https?\.(?:request|get)\s*\(/;
  const declaresTimeout = /AbortSignal\.timeout|\.setTimeout\(\s*\d|timeout\s*:/;
  for (const { rel, text } of source) {
    if (isHtmlRenderer(rel) || !usesHttp.test(text)) continue;
    assert.ok(declaresTimeout.test(text), `${rel} performs outbound HTTP without a timeout`);
  }
});

test('credential-looking files are written with mode 0o600', () => {
  const writeCall = /(?:writeFileSync|writeFile)\s*\(([\s\S]{0,240}?)\)\s*;?/g;
  for (const { rel, text } of source) {
    for (const match of text.matchAll(writeCall)) {
      const call = match[1];
      const target = call.split(',')[0];
      if (!/token|secret|credential|password/i.test(target)) continue;
      assert.ok(/mode\s*:\s*0o600/.test(call), `${rel} writes a credential file without mode 0o600`);
    }
  }
});

test('secrets are never logged', () => {
  const logCall = /console\.(?:log|error|warn|info)\s*\(([^\n]*)\)/g;
  for (const { rel, text } of source) {
    for (const match of text.matchAll(logCall)) {
      assert.ok(!/\b(token|secret|password|apiKey|api_key)\b/i.test(match[1]), `${rel} logs a secret-like value: ${match[0]}`);
    }
  }
});

test('profile paths go through the resolver, not hardcoded homes', () => {
  for (const { rel, text } of source) {
    if (rel === path.join('src', 'data-paths.js')) continue;
    assert.ok(!/os\.homedir\s*\(/.test(text), `${rel} hardcodes os.homedir() — use src/data-paths.js`);
    assert.ok(!/process\.env\.HOME\s*\|\|/.test(text), `${rel} builds a home fallback — use src/data-paths.js`);
    assert.ok(!/['"`]\/home\/[A-Za-z]|['"`]\/Users\/[A-Za-z]/.test(text), `${rel} bakes an absolute home path`);
  }
});

test('the test harness does not mock the MCP registry', () => {
  const harness = [
    'tests/helpers/mcp.js',
    'tests/helpers/hh-behavior-fixture.js',
    'tests/behavior/tools.test.cjs',
    'tests/behavior/fake-provider.test.cjs',
    'tests/contract/mcp-manifest.test.cjs',
  ].map((rel) => path.join(ROOT, rel)).filter((file) => fs.existsSync(file));
  for (const file of harness) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!/src\/mcp-skills\/registry/.test(text), `${path.relative(ROOT, file)} imports (and could mock) the registry`);
  }
});
