/**
 * Location must be a per-vacancy parameter of proactive cold search, not an
 * implicit constant. Before this fix, hhResumeSearch() in
 * src/hh-proactive-search.js hardcoded `area: '1'` (Moscow) into every HH
 * resume-search request regardless of what city/region the active vacancy
 * was actually posted in — a recruiter running cold search for a
 * Novosibirsk vacancy silently got Moscow candidates back (or nothing, if
 * the pool had no Moscow-area matches).
 *
 * Owner requirement (2026-09-23): if the recruiter's vacancy has a location,
 * it must reach the HH resumes search request. If no location is known,
 * that must fall back to an explicit, documented default (whole Russia,
 * HH area id '113') — never a silent narrowing to Moscow.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import { createMockHhServer } from './helpers/mock-hh-server.js';

const USERNAME = 'loc-test-user';

const tokensDir = mkdtempSync(join(tmpdir(), 'hh-loc-tokens-'));
const dataDir = mkdtempSync(join(tmpdir(), 'hh-loc-data-'));

const mockHh = createMockHhServer({
  coldResumes: [
    // Matches the vacancy's own area (SPb, area id '2') — must be found when
    // the active vacancy specifies that location.
    {
      id: 'res-spb', alternate_url: 'https://hh.ru/resume/res-spb',
      first_name: 'Анна', last_name: 'Смирнова', title: 'Финансовый советник',
      area: { name: 'Санкт-Петербург' }, total_experience: { months: 40 },
      experience: [{ company: 'Банк СПб', position: 'Финансовый советник', start: '2021-01', end: null, description: 'Инвестиционное консультирование клиентов' }],
      _professional_role_id: '70', _area_id: '2',
    },
    // Decoy — same criteria match, but sitting in Moscow (area id '1'). If the
    // search still silently hardcodes area='1', ONLY this decoy comes back and
    // the SPb candidate above is invisible.
    {
      id: 'res-moscow-decoy', alternate_url: 'https://hh.ru/resume/res-moscow-decoy',
      first_name: 'Игорь', last_name: 'Кузнецов', title: 'Финансовый советник',
      area: { name: 'Москва' }, total_experience: { months: 50 },
      experience: [{ company: 'Банк Москвы', position: 'Финансовый советник', start: '2020-01', end: null, description: 'Инвестиционное консультирование клиентов' }],
      _professional_role_id: '70', _area_id: '1',
    },
    // Only reachable under the documented "no location known" fallback
    // (whole Russia, area id '113') — proves the no-location path isn't
    // silently narrowed to Moscow either.
    {
      id: 'res-russia-wide', alternate_url: 'https://hh.ru/resume/res-russia-wide',
      first_name: 'Мария', last_name: 'Орлова', title: 'Финансовый советник',
      area: { name: 'Екатеринбург' }, total_experience: { months: 45 },
      experience: [{ company: 'Инвестбанк', position: 'Финансовый советник', start: '2019-01', end: null, description: 'Инвестиционное консультирование клиентов' }],
      _professional_role_id: '70', _area_id: '113',
    },
  ],
});

await mockHh.start();

process.env.AGENT_TOKENS_DIR = tokensDir;
process.env.AGENT_DATA_DIR = dataDir;
process.env.HH_API_BASE_URL = mockHh.baseUrl;
delete process.env.OPENROUTER_API_KEY;

mkdirSync(join(tokensDir, USERNAME), { recursive: true });
writeFileSync(join(tokensDir, USERNAME, 'hh'), JSON.stringify({ access_token: `tok-${USERNAME}` }));

afterAll(async () => {
  await mockHh.stop();
  rmSync(tokensDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

const require = createRequire(import.meta.url);
const {
  runProactiveSearch, atsConfigHash, getSearchExclusions, saveStoredQueries,
} = require('../src/hh-proactive-search.js');

function setUpWorkDir(vacancyId, vacancyTitle, activeVacancyExtra) {
  const workDir = mkdtempSync(join(tmpdir(), `hh-loc-work-${vacancyId}-`));
  const ctxDir = join(workDir, 'contexts', 'hh');
  mkdirSync(ctxDir, { recursive: true });
  const atsConfig = {
    vacancy_id: vacancyId,
    vacancy_title: vacancyTitle,
    required: [{ name: 'Финансовый советник', weight: 5 }],
    preferred: [],
    knockout: [],
    filters: { min_experience_years: 1 },
  };
  writeFileSync(join(ctxDir, 'ats_config.json'), JSON.stringify({ value: atsConfig }));
  writeFileSync(join(ctxDir, 'active_vacancy.json'), JSON.stringify({
    value: { id: vacancyId, title: vacancyTitle, ...activeVacancyExtra },
  }));

  const exclusions = getSearchExclusions(USERNAME);
  const hash = atsConfigHash(atsConfig, exclusions);
  saveStoredQueries(USERNAME, vacancyId, ['Финансовый советник'], hash);

  return workDir;
}

describe('proactive cold search — location is per-vacancy, not hardcoded Moscow', () => {
  it('searches the vacancy\'s own area (SPb) and does not silently narrow to Moscow', async () => {
    const workDir = setUpWorkDir('vac-spb', 'Финансовый советник (СПб)', { area: { id: '2', name: 'Санкт-Петербург' } });

    const result = await runProactiveSearch(USERNAME, workDir, {});

    expect(result.new_ids).toContain('res-spb');
    expect(result.new_ids).not.toContain('res-moscow-decoy');
  }, 20_000);

  it('falls back to whole-Russia search (documented default) when no location is known anywhere, not to Moscow', async () => {
    const workDir = setUpWorkDir('vac-nolocation', 'Финансовый советник (без города)', {});

    const result = await runProactiveSearch(USERNAME, workDir, {});

    expect(result.new_ids).toContain('res-russia-wide');
  }, 20_000);
});
