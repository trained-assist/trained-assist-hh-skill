// Profile skills gating (trained-assist-agent #1537/#1470): core's catalog addresses
// this repo's modules as 'hh-skills/<file>'; hidden ones are not registered.
import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const names = env => {
  const r = spawnSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./src/mcp-skills/registry.js').listTools().map(t=>t.name)))"],
    { cwd: root, encoding: 'utf8', env: { ...process.env, USER_ID: 'u1', ...env } });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
};

it('a hidden hh-skills module is not registered; a bare core name never hides it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-gating-'));
  const file = path.join(dir, 'effective.json');
  fs.writeFileSync(file, JSON.stringify({ hidden: { modules: ['hh-skills/98-demo.js', '94-calltips.js'] } }));
  const all = names({ HOME: dir });
  const gated = names({ HOME: dir, SKILLS_RESOLVED: file });
  expect(all).toContain('demo_status');
  expect(gated).not.toContain('demo_status');
  expect(gated).toContain('calltips_get_login');
});
