'use strict';

// L1 — Contract layer (hermetic: no network, no LLM).
//   * mcp.manifest.json validates against contracts/mcp-skill-sources.schema.json
//   * revision is a real 40-hex commit, artifactDigest is sha256 and recomputes
//   * identity is consistent with the approved provider manifest
//   * tool-name parity between the manifest and the real server's tools/list
//   * namespacing / policy and no collision with a core-owned MCP server

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { validate } = require('../helpers/json-schema');
const { startMcp } = require('../helpers/mcp');
const artifact = require('../../scripts/mcp-artifact');
const { ActionProviderRegistry } = require('../../contracts/core/action-provider-registry.cjs');

const ROOT = path.resolve(__dirname, '../..');
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/mcp-skill-sources.schema.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'mcp.manifest.json'), 'utf8'));

const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;

test('mcp.manifest.json conforms to the mcp-skill-sources schema', () => {
  const errors = validate(schema, manifest);
  assert.deepEqual(errors, [], `schema errors:\n${errors.join('\n')}`);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.sources.length, 1);
});

test('source revision is a real 40-hex commit and artifactDigest is deterministic sha256', () => {
  const [source] = manifest.sources;
  assert.match(source.revision, HEX40, 'revision must be a 40-hex SHA');
  execFileSync('git', ['cat-file', '-e', `${source.revision}^{commit}`], { cwd: ROOT }); // throws if absent

  assert.match(source.artifactDigest, HEX64, 'artifactDigest must be sha256 hex');
  assert.equal(source.artifactDigest, artifact.artifactDigest(), 'artifactDigest does not match recomputed artifact');
  assert.equal(source.entrypoint, artifact.ENTRYPOINT);
  assert.equal(source.manifest, artifact.MANIFEST_PATH);
});

test('manifest identity is internally consistent', () => {
  const [source] = manifest.sources;
  assert.equal(source.manifestVersion, source.approvedManifest.version);
  assert.equal(source.providerId, source.approvedManifest.providerId);
  assert.equal(source.providerId, 'hh');
  assert.equal(source.mcpServerId, 'hh-skills', 'mcpServerId must preserve the existing client name');
  assert.equal(source.repository, artifact.REPOSITORY);
  assert.equal(source.enabled, true);
  assert.ok(source.profiles.length > 0, 'profiles allowlist must not be empty');
  // The embedded approved manifest must be the core-valid v1 descriptor.
  const actionManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'action-provider-manifest.json'), 'utf8'));
  assert.deepEqual(source.approvedManifest, actionManifest, 'embedded approvedManifest drifted from action-provider-manifest.json');
  // ...and it must stay consistent with the MCP-facing catalog (descriptions dropped).
  const providerManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'provider-manifest.json'), 'utf8'));
  const withoutDescriptions = { ...providerManifest, actions: providerManifest.actions.map(({ description, ...a }) => a) };
  assert.deepEqual(actionManifest, withoutDescriptions, 'action manifest must mirror provider manifest minus descriptions');
  // The real core consumer must accept what we ship as the approved source.
  new ActionProviderRegistry().register(source.approvedManifest);
});

// Two tools predate the hh_ namespacing and are pinned in core's approved
// action snapshot (contracts/action-v1/hh-tools.snapshot.json). Renaming them
// would break core consumers, so they are an explicit, frozen allowlist.
const LEGACY_NAMES = new Set(['cold_message_generate', 'rejection_with_feedback']);

test('manifest actions are namespaced and policy-valid', () => {
  const [source] = manifest.sources;
  const names = source.approvedManifest.actions.map((a) => a.name);
  assert.equal(new Set(names).size, names.length, 'duplicate action names');
  for (const action of source.approvedManifest.actions) {
    assert.ok(/^hh_[a-z0-9_]*$/.test(action.name) || LEGACY_NAMES.has(action.name),
      `${action.name} must be namespaced hh_* (or a frozen legacy name)`);
    assert.equal(action.inputSchema.type, 'object');
    if (action.effect === 'read') assert.equal(action.retrySafety, 'read_only');
    else assert.notEqual(action.retrySafety, 'read_only');
    if (action.effect === 'destructive' || action.effect === 'external_message') assert.equal(action.requiresApproval, true);
  }
  for (const reserved of ['playwright', 'trained-skills']) {
    assert.notEqual(source.mcpServerId, reserved, 'mcpServerId collides with a core server');
  }
});

test('tool-name parity: manifest actions == real server tools/list', async () => {
  const [source] = manifest.sources;
  const manifestNames = source.approvedManifest.actions.map((a) => a.name).sort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-manifest-'));
  const tokenDir = path.join(root, 'agent-tokens', 'manifest-parity');
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(path.join(tokenDir, 'hh'), JSON.stringify({ access_token: 'fixture-only', employer_id: 'fixture' }));
  const mcp = await startMcp({
    userId: 'manifest-parity',
    env: {
      HOME: root, TMPDIR: root, USERS_DIR: path.join(root, 'users'),
      AGENT_TOKENS_DIR: path.join(root, 'agent-tokens'), AGENT_TOKENS_ROOT: path.join(root, 'agent-tokens'),
      AGENT_DATA_DIR: path.join(root, 'data'),
    },
  });
  try {
    const { tools } = await mcp.call('tools/list');
    const serverNames = tools.map((t) => t.name).sort();
    assert.deepEqual(serverNames, manifestNames, 'tools/list drifted from mcp.manifest.json');
  } finally {
    await mcp.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
