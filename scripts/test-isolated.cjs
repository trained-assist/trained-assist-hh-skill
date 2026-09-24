'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-ci-'));
const repo = path.resolve(__dirname, '..');
const suites = {
  unit: [['node_modules/vitest/vitest.mjs', 'run'], ['--test', 'tests/*.run.cjs']],
  contract: [['--test', 'tests/contract/*.test.cjs']],
  staging: [['node_modules/@playwright/test/cli.js', 'test']],
};
const selected = process.argv[2] || 'all';
const commands = selected === 'all' ? Object.values(suites).flat() : suites[selected];
if (!commands) throw new Error(`Unknown suite: ${selected}`);
// Allowlist, not a spread of the developer/service environment: no real credentials.
const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root, NODE_ENV: 'test',
  USER_ID: 'fixture', AGENT_USER_ID: 'fixture', USERS_DIR: path.join(root, 'users'),
  AGENT_DATA_DIR: path.join(root, 'data'), AGENT_TOKENS_DIR: path.join(root, 'agent-tokens'),
  AGENT_TOKENS_ROOT: path.join(root, 'agent-tokens'),
  NODE_OPTIONS: `--require=${path.join(repo, 'tests/support/network-guard.cjs')}`,
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache/ms-playwright'),
};
if (process.env.CI) env.CI = 'true';
let status = 0;
try {
  for (const command of commands) {
    const args = command.flatMap(arg => {
      if (!arg.includes('*')) return [arg];
      const dir = path.dirname(arg), suffix = path.basename(arg).slice(1);
      const files = fs.readdirSync(path.join(repo, dir)).filter(f => f.endsWith(suffix)).sort();
      if (!files.length) throw new Error(`No tests match ${arg}`);
      return files.map(f => path.join(dir, f));
    });
    const result = spawnSync(process.execPath, args, { cwd: repo, env, stdio: 'inherit', timeout: 300_000 });
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) { status = result.status || 1; break; }
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
process.exitCode = status;
