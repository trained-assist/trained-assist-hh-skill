import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const manifest = require('../provider-manifest.json');
const { buildManifest } = require('../scripts/build-manifest.cjs');

describe('static approved HH manifest', () => {
  it('matches the complete declared catalog independently of credential readiness', () => {
    expect(manifest).toEqual(buildManifest());
    expect(manifest.providerId).toBe('hh');
    expect(manifest.actions.length).toBeGreaterThan(30);
    expect(new Set(manifest.actions.map(a => a.name)).size).toBe(manifest.actions.length);
    for (const a of manifest.actions) {
      expect(a.description).toBeTruthy();
      expect(a.inputSchema.type).toBe('object');
      if (['external_message', 'destructive'].includes(a.effect)) expect(a.requiresApproval).toBe(true);
      if (a.effect === 'read') expect(a.retrySafety).toBe('read_only');
    }
  });
  it('keeps connection tools available without credentials while metadata includes connected actions', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-manifest-'));
    try {
      const result = spawnSync(process.execPath, ['src/mcp-skills/index.js'], {
        env: { HOME: home, PATH: process.env.PATH, USER_ID: 'isolated', USERS_DIR: home },
        input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n', encoding: 'utf8', timeout: 5000,
      });
      expect(result.status).toBe(0);
      const tools = JSON.parse(result.stdout.trim()).result.tools;
      expect(tools.map(t => t.name)).toContain('hh_connect');
      expect(tools.map(t => t.name)).not.toContain('hh_search_resumes');
      expect(manifest.actions.map(t => t.name)).toContain('hh_search_resumes');
      for (const t of tools) expect(manifest.actions.find(a => a.name === t.name)?.inputSchema).toEqual(t.inputSchema);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});
