'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { McpClient } = require('./mcp-client.cjs');
const USER = 'fixture';
const VACANCY = { id: '100', name: 'Инженер Node.js', area: { id: '2', name: 'Санкт-Петербург' }, manager: { full_name: 'Тестовый рекрутер' }, counters: { responses: 2 } };
const candidates = [
  { id: 'r100', title: 'Инженер Node.js', total_experience: { months: 60 }, skill_set: ['Node.js'], area: VACANCY.area, alternate_url: 'https://hh.ru/resume/r100' },
  { id: 'r200', title: 'Разработчик Backend', total_experience: { months: 36 }, skill_set: ['Node.js'], area: VACANCY.area, alternate_url: 'https://hh.ru/resume/r200' },
];
async function createFixture({ connected = true, llm = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-stage-'));
  const workDir = path.join(root, 'users', USER);
  const ctx = path.join(workDir, 'contexts', 'hh'); fs.mkdirSync(ctx, { recursive: true });
  const tokenDir = path.join(root, 'agent-tokens', USER); fs.mkdirSync(tokenDir, { recursive: true });
  if (connected) fs.writeFileSync(path.join(tokenDir, 'hh'), JSON.stringify({ access_token: 'fixture-only', employer_id: 'emp-fixture' }));
  const put = (key, value) => fs.writeFileSync(path.join(ctx, key + '.json'), JSON.stringify({ value }));
  put('active_vacancy', VACANCY); put('active_vacancies', [VACANCY]);
  put('ats_config:100', { vacancy_id: '100', vacancy_title: VACANCY.name, required: [{ name: 'Node.js', weight: 5 }], preferred: [] });
  const requests = []; let searchStatus = 200; const unexpected = [];
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://localhost');
      requests.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), auth: req.headers.authorization });
      res.setHeader('Content-Type', 'application/json');
      const send = (status, body) => { res.writeHead(status); res.end(JSON.stringify(body)); };
      if (req.method === 'GET' && u.pathname === '/employers/emp-fixture/vacancies/active') return send(200, { found: 1, items: [VACANCY] });
      if (req.method === 'GET' && u.pathname === '/resumes') return send(searchStatus, searchStatus === 200 ? { found: 2, pages: 1, items: candidates } : { errors: [{ type: 'forbidden' }] });
      if (req.method === 'GET' && u.pathname === '/hh/proactive') {
        const { createHmac } = require('node:crypto');
        if (u.searchParams.get('username') !== USER || u.searchParams.get('token') !== createHmac('sha256', 'fixture-secret').update(USER).digest('hex').slice(0, 16) || u.searchParams.get('vacancy_id') !== '100') return send(403, { error: 'Bad signed URL' });
        const dir = path.join(root, 'data', 'hh', USER, 'proactive');
        const snapshots = fs.readdirSync(dir).filter(f => f.startsWith('search-results-') && f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f))));
        const snapshot = snapshots.find(s => s.vacancy_id === '100');
        if (!snapshot) return send(404, { error: 'No snapshot' });
        const { generateProactivePageHtml } = require('../../src/hh-proactive-page');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(generateProactivePageHtml(snapshot, USER, baseUrl, u.searchParams.get('token'), {}, { vacancyId: '100', activeVacancies: [VACANCY] }));
      }
      // This adapter models core's HTTP boundary; actual provider executes behind MCP.
      if (req.method === 'POST' && u.pathname === '/api/hh/proactive/search') {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        if (body.username !== USER || body.vacancy_id !== '100' || !body.token) return send(400, { error: 'Bad core callback contract' });
        return send(200, await client.call('hh_proactive_search', { vacancy_id: body.vacancy_id }));
      }
      unexpected.push(`${req.method} ${u.pathname}`); send(500, { error: 'Unexpected fixture request' });
    } catch (error) { unexpected.push(error.message); res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const repo = path.resolve(__dirname, '../..');
  const env = { ...process.env, HOME: root, USER_ID: USER, AGENT_USER_ID: USER,
    USERS_DIR: path.join(root, 'users'), AGENT_TOKENS_DIR: path.join(root, 'agent-tokens'),
    AGENT_TOKENS_ROOT: path.join(root, 'agent-tokens'), AGENT_DATA_DIR: path.join(root, 'data'),
    HH_API_BASE_URL: baseUrl, HH_COLD_SEARCH_PUBLIC_URL: baseUrl, AGENT_SECRET: 'fixture-secret',
    OPENROUTER_API_KEY: llm ? 'fixture-llm-only' : '', FIXTURE_LLM_LOG: path.join(root, 'llm.jsonl'),
  };
  let client = new McpClient(process.execPath, [...(llm ? ['--require', path.join(repo, 'tests/support/llm-fixture.cjs')] : []), path.join(repo, 'src/mcp-skills/index.js')], { cwd: workDir, env });
  return { root, get client() { return client; }, requests, unexpected, baseUrl,
    restart: async () => {
      await client.close();
      client = new McpClient(process.execPath, [...(llm ? ['--require', path.join(repo, 'tests/support/llm-fixture.cjs')] : []), path.join(repo, 'src/mcp-skills/index.js')], { cwd: workDir, env });
    },
    setSearchStatus: status => { searchStatus = status; },
    llmRequests: () => fs.existsSync(env.FIXTURE_LLM_LOG) ? fs.readFileSync(env.FIXTURE_LLM_LOG, 'utf8').trim().split('\n').map(JSON.parse) : [],
    close: async () => { await client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); },
  };
}
module.exports = { createFixture };
