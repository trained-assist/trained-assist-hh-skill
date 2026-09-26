'use strict';

// Scripted LLM boundary for L2 behavior and replay tests. This is a recorded
// HTTP fixture (Nock), not a network call: it stands in for exactly one of the
// two sanctioned mock boundaries (the LLM). The HH platform is the other one
// (tests/helpers/mock-hh-server.js). The MCP server, registry and handlers all
// run for real.
//
// Response shape is chosen from the prompt, deterministically:
//   ATS extraction  -> a config object
//   candidate ATS   -> a scored rubric object
//   query generation-> a JSON array of strings
//   proactive score -> the plus/risk tags object
//   anything else   -> a plain message string

const fs = require('node:fs');
const nock = require('nock');

function reply(_uri, body) {
  try {
    if (process.env.FIXTURE_LLM_LOG) fs.appendFileSync(process.env.FIXTURE_LLM_LOG, JSON.stringify(body) + '\n');
  } catch { /* logging is best-effort */ }
  const text = JSON.stringify(body && body.messages ? body.messages.map(m => m && m.content).join('\n') : '');
  let content;
  if (/ATS-конфиг/.test(text)) {
    content = JSON.stringify({
      vacancy_title: 'Инженер Node.js',
      vacancy_context: 'fixture',
      knockout: [],
      required: [{ name: 'Node.js', weight: 2 }],
      preferred: [],
      filters: { min_experience_years: 1, remote_ok: true, salary_max_rub: null },
      pass_threshold: 6.5,
      review_threshold: 4,
    });
  } else if (/РУБРИКА ОЦЕНКИ|ATS-система/.test(text)) {
    content = JSON.stringify({
      knockout_failed: [],
      filters_ok: { experience_years_ok: true, location_ok: true, salary_ok: true },
      criteria: [{ name: 'Node.js', score: 3, evidence: 'fixture' }],
      reasoning: 'Опыт соответствует тестовой вакансии',
    });
  } else if (/JSON-массив строк/.test(text)) {
    content = JSON.stringify(['Инженер Node.js']);
  } else if (/plus_tags|risk_tags|summary_why/.test(text)) {
    content = JSON.stringify({ plus_tags: ['Node.js'], risk_tags: [], summary_why: 'Опыт соответствует тестовой вакансии', summary_pitch: 'Backend' });
  } else {
    content = 'Тестовое сообщение для кандидата.';
  }
  return { choices: [{ message: { content } }] };
}

nock('https://openrouter.ai', { reqheaders: { authorization: 'Bearer fixture-llm-only' } })
  .persist().post('/api/v1/chat/completions').reply(200, reply);
nock('https://openrouter.ai').persist().post('/api/v1/chat/completions').reply(200, reply);
