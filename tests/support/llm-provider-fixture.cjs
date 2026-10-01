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
  if (/ОЦЕНКА ИНТЕРВЬЮ ПО ТРЕБОВАНИЯМ ПОРТРЕТА/.test(text)) {
    // hh_interview_evaluate (#89): per-requirement 0-5 + evidence, coverage via n/a,
    // communication as a parallel axis. ids match the portrait the behavior fixture writes.
    content = JSON.stringify({
      requirements: [
        { id: 'req-1', score: 4, evidence: '«Мы внедряли Node.js в продакшен три года подряд» [реплика 2]', comment: 'подтверждено примерами' },
        { id: 'req-2', score: 3, evidence: '«Опыт от трёх лет, у меня больше» [реплика 4]', comment: 'соответствует' },
      ],
      communication: {
        style: { score: 4, evidence: 'спокойный деловой тон, без лишнего' },
        politeness: { score: 5, evidence: 'здоровается, благодарит, отвечает по делу' },
        vocabulary: { score: 4, evidence: 'профессиональная лексика без канцелярита' },
        structure: { score: 3, evidence: 'иногда отвечает длинно, но по существу' },
      },
    });
  } else if (/ATS-конфиг/.test(text)) {
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
  } else if (/ПОРТРЕТ КАНДИДАТА/.test(text)) {
    content = JSON.stringify({
      company: { name: 'Fixture Company', industry: 'IT', site: 'https://fixture.ru', founded_headcount: '2020, 10 человек', about: 'fixture', office_address: 'Москва', notable_clients: ['Клиент А'], contact_person: 'Иван' },
      vacancy: { title: 'Маркетолог', headcount: 1, work_format: 'Удалённо', location: 'Москва', reason: 'Расширение', workplace_address: 'Удаленно', reports_to: 'Собственнику', manages: null, responsibilities: ['Ведение кабинетов Wildberries'], programs: ['Excel'], expected_results: ['Рост продаж'], training: 'Да', career_growth: 'Да', probation_months: 3, salary_trial: '70000 ₽', salary_after: '100000 ₽', salary_total: '100000 ₽', schedule: '5/2', weekend_work: 'нет', business_trips: 'нет', employment_type: 'ТК РФ', perks: ['бонусы'] },
      requirements: { age: '25-35', gender: 'не важно', marital_status: 'не важно', education: 'не важно', experience: 'от 2 лет в маркетинге', stop_factors: ['пассивность'], photo_required: false, hard_skills: ['SEO карточек', 'Аналитика'], soft_skills: ['Самостоятельность'], additional_info: 'ISTJ', selection_stages: ['Телефонное интервью'] },
    });
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
// llm-ladder worker: same scripted answers for everything now routed through
// src/conversation-generation.js / src/llm-ladder.js (writing, evaluation, planner).
nock('https://llm-ladder.trainedassist.store')
  .persist().post('/v1/chat/completions').reply(200, (_uri, body) => ({ ...reply(_uri, body), model: body.model }));
