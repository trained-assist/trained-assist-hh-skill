'use strict';

// Behavior harness: a real MCP server subprocess talking to the loopback HH
// mock and a scripted LLM fixture. This mocks exactly the two sanctioned
// boundaries (external network, LLM) — the registry, handlers and transport run
// for real. Every data root lives in a temp dir so nothing touches a real HOME.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockHhServer } = require('./mock-hh-server');
const { startMcp } = require('./mcp');

const USER = 'fixture';
const VACANCY = { id: 'vac-001', title: 'Backend Developer (Node.js)', name: 'Backend Developer (Node.js)', area: { id: '1', name: 'Москва' } };
const ATS = {
  vacancy_id: 'vac-001',
  vacancy_title: VACANCY.name,
  vacancy_context: 'fixture',
  knockout: [],
  required: [{ name: 'Node.js', weight: 2 }],
  preferred: [],
  filters: {},
  pass_threshold: 6.5,
  review_threshold: 4,
};
const LLM_FIXTURE = path.resolve(__dirname, '../support/llm-provider-fixture.cjs');

async function createBehaviorFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-behavior-'));
  const workDir = path.join(root, 'users', USER);
  const srv = createMockHhServer();
  await srv.start();

  const tokenDir = path.join(root, 'agent-tokens', USER);
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(path.join(tokenDir, 'hh'), JSON.stringify({ access_token: 'fixture-only', employer_id: 'emp-001' }));

  const ctxDir = path.join(workDir, 'contexts', 'hh');
  fs.mkdirSync(ctxDir, { recursive: true });
  const put = (key, value) => fs.writeFileSync(path.join(ctxDir, key + '.json'), JSON.stringify({ value }));
  put('active_vacancy', VACANCY);
  put('active_vacancies', [VACANCY]);
  put('ats_config', ATS);
  put('ats_config:vac-001', ATS);

  const env = {
    HOME: root, TMPDIR: root, NODE_ENV: 'test',
    USERS_DIR: path.join(root, 'users'), USER_ID: USER, AGENT_USER_ID: USER,
    AGENT_TOKENS_DIR: path.join(root, 'agent-tokens'), AGENT_TOKENS_ROOT: path.join(root, 'agent-tokens'),
    AGENT_DATA_DIR: path.join(root, 'data'),
    HH_API_BASE_URL: srv.baseUrl, HH_COLD_SEARCH_PUBLIC_URL: srv.baseUrl,
    AGENT_PUBLIC_URL: srv.baseUrl, AGENT_SECRET: 'fixture-secret',
    OPENROUTER_API_KEY: 'fixture-llm-only', FIXTURE_LLM_LOG: path.join(root, 'llm.jsonl'),
  };

  const mcp = await startMcp({ userId: USER, workDir, env, nodeArgs: ['--require', LLM_FIXTURE] });
  return {
    mcp, srv, root,
    llmRequests: () => fs.existsSync(env.FIXTURE_LLM_LOG)
      ? fs.readFileSync(env.FIXTURE_LLM_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      : [],
    close: async () => {
      await mcp.stop();
      await srv.stop();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

module.exports = { createBehaviorFixture, USER, VACANCY, ATS };
