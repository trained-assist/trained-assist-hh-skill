'use strict';
// L1/L3 — credential readers for trained-assist-hh-skill
// (trained-assist-agent#1939, C4 rollout шаг 1).
//
// Every credential file this skill owns lives under agent-tokens, so the one-time
// migration (scripts/encrypt-tokens.mjs) will encrypt it. Contract (epic #1789
// P0 C4, #1819):
//   - legacy plaintext files pass through transparently;
//   - an encrypted (v2 base64 envelope) file is decrypted;
//   - a base64 stub is NEVER returned as a value;
//   - a missing CRED_ENCRYPTION_KEY degrades to plaintext WITH a warning —
//     never a hard failure in legacy-compatible mode;
//   - target strict mode rejects plaintext and missing/invalid keys;
//   - `.meta` sidecars are bookkeeping, not services, not env values.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-cred-'));
const savedEnv = {
  AGENT_TOKENS_DIR: process.env.AGENT_TOKENS_DIR,
  AGENT_TOKENS_ROOT: process.env.AGENT_TOKENS_ROOT,
  CRED_ENCRYPTION_KEY: process.env.CRED_ENCRYPTION_KEY,
  CRED_ENCRYPTION_REQUIRED: process.env.CRED_ENCRYPTION_REQUIRED,
  USER_ID: process.env.USER_ID,
};
process.env.AGENT_TOKENS_DIR = root;
process.env.AGENT_TOKENS_ROOT = root;
process.env.USER_ID = 'hh-user';
delete process.env.CRED_ENCRYPTION_KEY;

const store = require('../../src/credential-store');
const { readHhToken, readHhTokenFile, readCredentialFileSafe, hhTokenPath } = require('../../src/hh-utils');
const { readState, writeState, statePath } = require('../../src/hh-autoscan');
const { loadBaseOverride, BASE_PROMPT_FILENAME } = require('../../src/hh-message-prompts');
const { loadUserTokens, listConnectedServices, revokeService } = require('../../src/user-tokens');

const MASTER_KEY = 'f'.repeat(64); // valid 64-hex → 32-byte AES-256 key
const PROFILE = 'hh-user';
const profileDir = () => path.join(root, PROFILE);
const hhFile = () => hhTokenPath(PROFILE);
const autoscanFile = () => statePath(PROFILE);
const basePromptFile = () => path.join(root, PROFILE, BASE_PROMPT_FILENAME);

function reset(t) {
  const saved = process.env.CRED_ENCRYPTION_KEY;
  const savedRequired = process.env.CRED_ENCRYPTION_REQUIRED;
  delete process.env.CRED_ENCRYPTION_KEY;
  delete process.env.CRED_ENCRYPTION_REQUIRED;
  store._resetMasterKey();
  fs.rmSync(profileDir(), { recursive: true, force: true });
  t.after(() => {
    if (saved === undefined) delete process.env.CRED_ENCRYPTION_KEY;
    else process.env.CRED_ENCRYPTION_KEY = saved;
    if (savedRequired === undefined) delete process.env.CRED_ENCRYPTION_REQUIRED;
    else process.env.CRED_ENCRYPTION_REQUIRED = savedRequired;
    store._resetMasterKey();
  });
}

function withKey() {
  process.env.CRED_ENCRYPTION_KEY = MASTER_KEY;
  store._resetMasterKey();
}

function captureWarn(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try { return { result: fn(), warnings }; }
  finally { console.warn = original; }
}

test.after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  store._resetMasterKey();
  fs.rmSync(root, { recursive: true, force: true });
});

test('legacy plaintext reads through: hh token, autoscan state, base prompt', (t) => {
  reset(t);
  fs.mkdirSync(profileDir(), { recursive: true });
  fs.writeFileSync(hhFile(), JSON.stringify({ access_token: 'hh-legacy', refresh_token: 'r' }), 'utf8');
  fs.writeFileSync(autoscanFile(), JSON.stringify({ enabled: true, intervalMinutes: 30 }), 'utf8');
  fs.writeFileSync(basePromptFile(), 'Персональный базовый промпт.', 'utf8');

  assert.deepEqual(readHhToken(PROFILE), { access_token: 'hh-legacy', refresh_token: 'r' });
  assert.deepEqual(readHhTokenFile(hhFile()), { access_token: 'hh-legacy', refresh_token: 'r' });
  assert.equal(readCredentialFileSafe(hhFile()), JSON.stringify({ access_token: 'hh-legacy', refresh_token: 'r' }));

  const state = readState(PROFILE);
  assert.equal(state.enabled, true);
  assert.equal(state.intervalMinutes, 30);

  assert.equal(loadBaseOverride(root, PROFILE), 'Персональный базовый промпт.');
});

test('missing CRED_ENCRYPTION_KEY → plaintext write with a warning, never a failure', (t) => {
  reset(t);
  const { warnings } = captureWarn(() => writeState(PROFILE, { enabled: true }));

  const onDisk = JSON.parse(fs.readFileSync(autoscanFile(), 'utf8'));
  assert.equal(onDisk.enabled, true, 'stored plaintext when no key is set');
  assert.ok(warnings.some(w => /PLAINTEXT/.test(w)), `expected a plaintext warning, got: ${warnings.join(' | ')}`);
  assert.equal(readState(PROFILE).enabled, true, 'the state we just wrote is readable');
  assert.equal(fs.statSync(autoscanFile()).mode & 0o777, 0o600, 'credential file must stay 0o600');
});

test('strict target mode rejects missing or invalid encryption keys before writing', (t) => {
  reset(t);
  process.env.CRED_ENCRYPTION_REQUIRED = 'true';
  assert.throws(() => store.writeCredentialFile(hhFile(), 'private-token'), /CRED_ENCRYPTION_KEY is required/);
  assert.equal(fs.existsSync(hhFile()), false, 'missing key must not create a plaintext credential');

  process.env.CRED_ENCRYPTION_KEY = 'not-a-valid-key';
  store._resetMasterKey();
  assert.throws(() => store.writeCredentialFile(hhFile(), 'private-token'), /must be 64 hex chars/);
  assert.equal(fs.existsSync(hhFile()), false, 'invalid key must not create a plaintext credential');
});

test('strict target mode rejects plaintext reads and wrong-key fallback, while valid ciphertext round-trips', (t) => {
  reset(t);
  process.env.CRED_ENCRYPTION_REQUIRED = 'true';
  withKey();

  fs.mkdirSync(profileDir(), { recursive: true });
  fs.writeFileSync(hhFile(), JSON.stringify({ access_token: 'legacy-plaintext' }), { mode: 0o600 });
  assert.throws(() => store.readCredentialFile(hhFile()), /is plaintext while CRED_ENCRYPTION_REQUIRED=true/);

  store.writeCredentialFile(hhFile(), JSON.stringify({ access_token: 'encrypted-target-token' }));
  const ciphertext = fs.readFileSync(hhFile(), 'utf8');
  assert.ok(store.isEncrypted(ciphertext));
  assert.equal(ciphertext.includes('encrypted-target-token'), false);
  assert.deepEqual(JSON.parse(store.readCredentialFile(hhFile())), { access_token: 'encrypted-target-token' });

  fs.rmSync(`${hhFile()}.meta`, { force: true });
  process.env.CRED_ENCRYPTION_KEY = '0'.repeat(64);
  store._resetMasterKey();
  assert.throws(() => store.readCredentialFile(hhFile()));
});

test('double read: with a key the files are encrypted at rest and still read back', (t) => {
  reset(t);
  withKey();
  captureWarn(() => {
    store.writeCredentialFile(hhFile(), JSON.stringify({ access_token: 'hh-encrypted' }));
    writeState(PROFILE, { enabled: true, intervalMinutes: 45 });
    store.writeCredentialFile(basePromptFile(), 'Зашифрованный промпт.');
  });

  for (const file of [hhFile(), autoscanFile(), basePromptFile()]) {
    assert.ok(store.isEncrypted(fs.readFileSync(file, 'utf8')), `${file} must be a v2 envelope at rest`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, `${file} must stay 0o600`);
  }

  assert.deepEqual(readHhToken(PROFILE), { access_token: 'hh-encrypted' });
  assert.deepEqual(readHhTokenFile(hhFile()), { access_token: 'hh-encrypted' });
  assert.equal(readState(PROFILE).enabled, true);
  assert.equal(readState(PROFILE).intervalMinutes, 45);
  assert.equal(loadBaseOverride(root, PROFILE), 'Зашифрованный промпт.');
});

test('a base64 stub is never returned as a value', (t) => {
  reset(t);
  withKey();
  captureWarn(() => {
    store.writeCredentialFile(hhFile(), JSON.stringify({ access_token: 'hh-stub' }));
    writeState(PROFILE, { enabled: true });
    store.writeCredentialFile(basePromptFile(), 'Заглушка.');
  });

  const hhBlob = fs.readFileSync(hhFile(), 'utf8');
  assert.ok(store.isEncrypted(hhBlob), 'precondition: the hh file on disk is a base64 stub');

  // Key withdrawn (deploy without CRED_ENCRYPTION_KEY): nothing may hand the
  // stub to the HH API, to the autoscan loop or into a prompt.
  delete process.env.CRED_ENCRYPTION_KEY;
  store._resetMasterKey();

  assert.throws(() => store.readCredentialFile(hhFile()),
    /CRED_ENCRYPTION_KEY/, 'store-level: loud, no base64 garbage');
  const { warnings } = captureWarn(() => {
    assert.equal(readHhToken(PROFILE), null, 'hh token degrades to "not connected"');
    assert.equal(readHhTokenFile(hhFile()), null, 'route chokepoint degrades to null');
    assert.equal(readCredentialFileSafe(hhFile()), null, 'safe reader never returns the stub');
    assert.equal(readState(PROFILE).enabled, false, 'autoscan falls back to the OFF default');
    assert.equal(loadBaseOverride(root, PROFILE), null, 'base prompt falls back to the default');
  });
  assert.ok(warnings.some(w => /treating the credential as absent/.test(w)),
    `expected a loud warning, got: ${warnings.join(' | ')}`);
});

test('user-tokens: .meta sidecars are neither services nor env values', (t) => {
  reset(t);
  fs.mkdirSync(profileDir(), { recursive: true });
  fs.writeFileSync(path.join(profileDir(), 'github'), 'ghp_legacy_plain', 'utf8');
  fs.writeFileSync(path.join(profileDir(), 'github.meta'),
    JSON.stringify({ service: 'github', version: 2, created_at: 'now' }), 'utf8');
  fs.writeFileSync(path.join(profileDir(), 'weeek'), 'weeek-plain', 'utf8');
  fs.writeFileSync(path.join(root, '.index.json'), JSON.stringify({ [PROFILE]: ['github'] }), 'utf8');

  const services = listConnectedServices(PROFILE).map(s => s.file).sort();
  assert.deepEqual(services, ['github', 'weeek'], '.meta must not be listed as a connected service');

  const extra = loadUserTokens(PROFILE);
  assert.equal(extra.GH_TOKEN, 'ghp_legacy_plain', 'plaintext token still reaches the engine env');
  assert.equal(Object.prototype.hasOwnProperty.call(extra, 'GITHUB_META'), false,
    'a .meta sidecar must never be exported as an env value');

  assert.equal(revokeService(PROFILE, 'github'), 'github');
  assert.equal(fs.existsSync(path.join(profileDir(), 'github')), false, 'credential file removed');
  assert.equal(fs.existsSync(path.join(profileDir(), 'github.meta')), false, 'sidecar removed with it');
  const index = JSON.parse(fs.readFileSync(path.join(root, '.index.json'), 'utf8'));
  assert.equal(index[PROFILE], undefined, 'the cross-user index entry is dropped too');
});

test('an unreadable credential never reaches the engine env', (t) => {
  reset(t);
  withKey();
  captureWarn(() => store.writeCredentialFile(path.join(profileDir(), 'openrouter'), 'sk-or-secret'));
  delete process.env.CRED_ENCRYPTION_KEY;
  store._resetMasterKey();

  const { warnings } = captureWarn(() => {
    const extra = loadUserTokens(PROFILE);
    assert.equal(extra.OPENROUTER, undefined, 'the stub must not be exported');
  });
  assert.ok(warnings.some(w => /cannot read/.test(w)),
    `expected a loud warning, got: ${warnings.join(' | ')}`);
});
