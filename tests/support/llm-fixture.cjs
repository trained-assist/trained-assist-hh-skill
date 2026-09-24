'use strict';
const fs = require('node:fs');
const nock = require('nock');
nock('https://openrouter.ai', { reqheaders: { authorization: 'Bearer fixture-llm-only' } })
  .persist().post('/api/v1/chat/completions').reply(200, (_uri, body) => {
    fs.appendFileSync(process.env.FIXTURE_LLM_LOG, JSON.stringify(body) + '\n');
    const query = body.messages[0].content.includes('JSON-массив строк');
    return { choices: [{ message: { content: JSON.stringify(query ? ['Инженер Node.js'] : { plus_tags: ['Node.js'], risk_tags: [], summary_why: 'Опыт соответствует тестовой вакансии', summary_pitch: 'Backend' }) } }] };
  });
