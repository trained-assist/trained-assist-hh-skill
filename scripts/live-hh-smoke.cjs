'use strict';
// Deliberately outside PR CI: read-only, no token persistence/refresh, no resume contacts.
async function run({ token = process.env.HH_SMOKE_TOKEN, request = fetch } = {}) {
  if (!token) throw new Error('HH_SMOKE_TOKEN is required; live smoke did not run');
  async function get(path) {
    const response = await request(`https://api.hh.ru${path}`, { method: 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'HH-User-Agent': 'trained-assist-ci/1.0 (support@recruiter-assistant.ru)' },
      signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`HH ${path.split('?')[0]} returned ${response.status}`);
    return response.json();
  }
  const me = await get('/me');
  if (!me.employer?.id) throw new Error('Employer access required');
  const vacancies = await get(`/employers/${encodeURIComponent(me.employer.id)}/vacancies/active?per_page=1&page=0`);
  if (!Array.isArray(vacancies.items) || !Number.isFinite(vacancies.found)) throw new Error('Invalid vacancies response');
  return { ok: true, vacancies: vacancies.found }; // no names, resumes or credential output
}
module.exports = { run };
if (require.main === module) run().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
