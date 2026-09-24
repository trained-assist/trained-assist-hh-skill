import { it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
const require = createRequire(import.meta.url);
const saved = { ...process.env };
let root;
afterEach(() => {
  for (const key of ['USER_ID', 'AGENT_SECRET', 'AGENT_DATA_DIR', 'USERS_DIR', 'AGENT_PUBLIC_URL', 'HH_COLD_SEARCH_PUBLIC_URL']) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  if (root) rmSync(root, { recursive: true, force: true });
});
it('MCP view and scheduled digest keep signed vacancy links on the public domain despite legacy infrastructure URL', async () => {
  root = mkdtempSync(join(tmpdir(), 'cold-public-url-'));
  Object.assign(process.env, { USER_ID: 'alice', AGENT_SECRET: 'test-only', AGENT_DATA_DIR: root, USERS_DIR: root, AGENT_PUBLIC_URL: 'https://old.sslip.io/agent', HH_COLD_SEARCH_PUBLIC_URL: '' });
  const dir = join(root, 'hh/alice/proactive');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'search-results-test.json'), JSON.stringify({ vacancy_id: 'v1', candidates: [], searched_at: '2026-09-24' }));
  const tool = require('../src/mcp-skills/tools/92-hh-proactive.js').tools.hh_proactive_view;
  const result = await tool.handler({ vacancy_id: 'v1' });
  const expected = `https://recruiter-assistant.ru/hh/proactive?username=alice&token=${createHmac('sha256', 'test-only').update('alice').digest('hex').slice(0, 16)}&vacancy_id=v1`;
  expect(result.url).toBe(expected);
  expect(require('../src/hh-autoscan').proactiveUrlFor('alice', 'v1')).toBe(expected);
  process.env.HH_COLD_SEARCH_PUBLIC_URL = 'https://recruiting.example.test/';
  expect((await tool.handler({ vacancy_id: 'v1' })).url).toBe(expected.replace('https://recruiter-assistant.ru', 'https://recruiting.example.test'));
});
