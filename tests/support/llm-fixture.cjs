'use strict';
const fs = require('node:fs');
const nock = require('nock');
const PORTRAIT = JSON.stringify({ company: { name: 'Fixture Company', industry: 'IT', site: 'https://fixture.ru', founded_headcount: '2020, 10 человек', about: 'fixture', office_address: 'Москва', notable_clients: ['Клиент А'], contact_person: 'Иван' }, vacancy: { title: 'Маркетолог', headcount: 1, work_format: 'Удалённо', location: 'Москва', reason: 'Расширение', workplace_address: 'Удаленно', reports_to: 'Собственнику', manages: null, responsibilities: ['Ведение кабинетов Wildberries'], programs: ['Excel'], expected_results: ['Рост продаж'], training: 'Да', career_growth: 'Да', probation_months: 3, salary_trial: '70000 ₽', salary_after: '100000 ₽', salary_total: '100000 ₽', schedule: '5/2', weekend_work: 'нет', business_trips: 'нет', employment_type: 'ТК РФ', perks: ['бонусы'] }, requirements: { age: '25-35', gender: 'не важно', marital_status: 'не важно', education: 'не важно', experience: 'от 2 лет в маркетинге', stop_factors: ['пассивность'], photo_required: false, hard_skills: ['SEO карточек', 'Аналитика'], soft_skills: ['Самостоятельность'], additional_info: 'ISTJ', selection_stages: ['Телефонное интервью'] } });
nock('https://openrouter.ai', { reqheaders: { authorization: 'Bearer fixture-llm-only' } })
  .persist().post('/api/v1/chat/completions').reply(200, (_uri, body) => {
    fs.appendFileSync(process.env.FIXTURE_LLM_LOG, JSON.stringify(body) + '\n');
    const text = body.messages.map(m => m && m.content).join('\n');
    const query = text.includes('JSON-массив строк');
    const portrait = text.includes('ПОРТРЕТ КАНДИДАТА');
    const content = portrait ? PORTRAIT : JSON.stringify(query ? ['Инженер Node.js'] : { plus_tags: ['Node.js'], risk_tags: [], summary_why: 'Опыт соответствует тестовой вакансии', summary_pitch: 'Backend' });
    return { choices: [{ message: { content } }] };
  });
nock('https://llm-ladder.trainedassist.store')
  .persist().post('/v1/chat/completions').reply(200, (_uri, body) => {
    fs.appendFileSync(process.env.FIXTURE_LLM_LOG, JSON.stringify(body) + '\n');
    const query = body.messages[0].content.includes('JSON-массив строк');
    return { choices: [{ message: { content: JSON.stringify(query ? ['Инженер Node.js'] : { plus_tags: ['Node.js'], risk_tags: [], summary_why: 'Опыт соответствует тестовой вакансии', summary_pitch: 'Backend' }) } }], model: body.model };
  });
