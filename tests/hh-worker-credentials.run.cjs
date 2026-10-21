'use strict';
// The explicit profile binding of the worker's credentials (#187 step 3): the
// bound copy follows a re-login, and the worker must be able to read and to
// rewrite it (the HH token refresh writes a new value back).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadBindings,
  syncBoundCredentials,
  verifyBoundCredentials,
  targetPath,
} = require('../src/hh-worker-credentials');

function freshEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-worker-cred-'));
  const sourceDir = path.join(dir, 'source');
  const tokensDir = path.join(dir, 'tokens');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(tokensDir, { recursive: true });
  const source = path.join(sourceDir, 'hh');
  fs.writeFileSync(source, '{"access_token":"a","refresh_token":"r"}', { mode: 0o600 });
  const bindings = path.join(dir, 'bindings.json');
  fs.writeFileSync(bindings, JSON.stringify({
    version: 1,
    profiles: [{ profile: 'tes-recruiter', credential: 'hh', source }],
  }), { mode: 0o600 });
  return { env: { AGENT_TOKENS_DIR: tokensDir, HH_WORKER_BINDINGS: bindings }, source, tokensDir, bindings };
}

test('the binding file names the profile and its credential', () => {
  const { env } = freshEnv();
  const bindings = loadBindings({ env });
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].profile, 'tes-recruiter');
  assert.equal(bindings[0].credential, 'hh');
});

test('the bound copy is created from the source', () => {
  const { env, tokensDir } = freshEnv();
  const result = syncBoundCredentials({ env });
  assert.equal(result[0].action, 'refreshed');
  const target = path.join(tokensDir, 'tes-recruiter', 'hh');
  assert.ok(fs.existsSync(target));
  assert.ok(JSON.parse(fs.readFileSync(target, 'utf8')).refresh_token);
});

test('an unchanged source is not copied again', () => {
  const { env } = freshEnv();
  syncBoundCredentials({ env });
  const second = syncBoundCredentials({ env });
  assert.equal(second[0].action, 'unchanged');
});

test('a rotated source replaces the bound copy', () => {
  const { env, source, tokensDir } = freshEnv();
  syncBoundCredentials({ env });
  fs.writeFileSync(source, '{"access_token":"b","refresh_token":"r2"}', { mode: 0o600 });
  fs.utimesSync(source, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  const result = syncBoundCredentials({ env });
  assert.equal(result[0].action, 'refreshed');
  const target = path.join(tokensDir, 'tes-recruiter', 'hh');
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).access_token, 'b');
});

test('a missing source is reported instead of failing silently', () => {
  const { env, source } = freshEnv();
  fs.unlinkSync(source);
  const result = syncBoundCredentials({ env });
  assert.equal(result[0].action, 'source_missing');
});

test('the verification checks reading and writing', () => {
  const { env } = freshEnv();
  syncBoundCredentials({ env });
  const checks = verifyBoundCredentials({ env });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].ok, true);
});

test('a missing copy is reported as missing', () => {
  const { env } = freshEnv();
  const checks = verifyBoundCredentials({ env });
  assert.equal(checks[0].ok, false);
  assert.equal(checks[0].reason, 'missing');
});

test('the target path follows the profile binding', () => {
  const { env } = freshEnv();
  const binding = loadBindings({ env })[0];
  assert.equal(targetPath(binding, env), path.join(env.AGENT_TOKENS_DIR, 'tes-recruiter', 'hh'));
});
