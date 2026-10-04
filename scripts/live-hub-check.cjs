'use strict';
// Live API check of the recruiting hub — the pages the recruiter actually opens,
// fetched over HTTP and asserted on structure, not on pixels.
//
// Why this exists: the hub has no headless-testable front end, so three real defects
// (#121) shipped because "it looked fine in the HTML": the vacancy picker rendered
// below the nav, the writer prompt said "ask only about must-haves" while the
// must-haves list was empty, and «Вернуть общий шаблон» answered «Failed to fetch».
// All three are decidable from a fetched page — so this script decides them.
//
// Run:  HH_HUB_BASE=http://localhost:8080 HH_HUB_USER=<recruiter> \
//       HH_HUB_TOKEN=<page token> node scripts/live-hub-check.cjs [--json]
// The page token is the per-recruiter HMAC the hub already uses in its own links; it
// never grants anything beyond that recruiter's pages.

const NAV_ID = 'hh-hub-nav';
// Pages that emit the vacancy switcher (src: only these three call vacancyPickerHtml).
// /hh/vacancies has none by design and must stay a single-row nav.
const PICKER_PAGES = ['/hh/review', '/hh/ats-editor', '/hh/proactive'];
const PLAIN_PAGES = ['/hh/vacancies'];
const GLOBALS = new Set((
  'Math JSON Object Array String Number Boolean Promise Map Set Date RegExp Error TypeError isNaN parseInt parseFloat ' +
  'fetch setTimeout clearTimeout setInterval confirm alert prompt location document window navigator console ' +
  'encodeURIComponent decodeURIComponent Blob URL URLSearchParams FormData Headers Request Response Intl require module exports ' +
  'if for while do switch try catch finally return throw typeof instanceof new delete void in of function var let const ' +
  'class extends super this null true false undefined structuredClone async await').split(/\s+/));

// The nav's own <style> block must be removed before looking for elements: its CSS
// selectors (`.hh-nav-settings`, `.vacancy-picker`) otherwise read as markup and every
// hierarchy assertion passes on a page whose picker never moved (#121, first probe).
function navMarkup(html) {
  const start = html.indexOf(`<nav id="${NAV_ID}"`);
  if (start === -1) return null;
  const end = html.indexOf('</nav>', start);
  return html.slice(start, end).replace(/<style[\s\S]*?<\/style>/g, '');
}

// Order matters: strings first, then block comments, then line comments — a naive pass
// treats the `//` inside `https://` as a comment and truncates the script.
function scriptCode(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n')
    .replace(/`(?:\\.|[^`\\])*`/g, '``').replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""').replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

// Every called function must exist. One dangling call (renderKnockout, removed in
// 5dcce7b) aborted the whole editor render and surfaced as «Failed to fetch».
function undefinedFunctions(html) {
  const code = scriptCode(html);
  const called = new Set([...code.matchAll(/(?:^|[^\w.$])([A-Za-z_$][\w$]*)\s*\(/g)]
    .map(m => m[1]).filter(n => !GLOBALS.has(n)));
  const defined = new Set([...code.matchAll(/function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=:]/g)]
    .map(m => m[1] || m[2]));
  return [...called].filter(n => !defined.has(n)).sort();
}

function checkNav(html, { expectsPicker }) {
  const nav = navMarkup(html);
  if (nav === null) return { pass: false, why: 'навбар не найден' };
  const picker = nav.indexOf('class="vacancy-picker"');
  const settings = nav.indexOf('class="hh-nav-settings"');
  const linksRow = nav.indexOf('hh-nav-links');
  const rows = (nav.match(/class="hh-nav-row/g) || []).length;
  const body = html.slice(html.indexOf('</nav>'));
  const duplicated = body.includes('class="vacancy-picker"');
  if (!expectsPicker) {
    const okSingle = rows === 0 && picker === -1;
    return { pass: okSingle, why: `rows=${rows} picker=${picker} (страница без переключателя должна быть однорядной)` };
  }
  if (picker === -1) return { pass: false, why: 'переключатель вакансии не попал в навбар' };
  if (duplicated) return { pass: false, why: 'переключатель продублирован в теле страницы' };
  const ordered = picker < settings && settings < linksRow && picker !== -1 && settings !== -1 && linksRow !== -1;
  if (!ordered) return { pass: false, why: `порядок нарушен: picker=${picker} settings=${settings} links=${linksRow}` };
  if (rows !== 2) return { pass: false, why: `ожидалось 2 ряда (пикер+настройки / разделы), найдено ${rows}` };
  return { pass: true, why: `2 ряда, picker=${picker} → settings=${settings} → links=${linksRow}` };
}

// The letter writer is told to ask only about must-haves; they must actually be in the
// prompt (#122). Build the same prompt the routes build and assert every name is there.
function checkPrompt(buildMessageSystemPrompt, atsConfig, vacancyContext = '') {
  const required = (atsConfig?.required || []).map(c => c?.name || c).filter(Boolean);
  const preferred = (atsConfig?.preferred || []).map(c => c?.name || c).filter(Boolean);
  const prompt = buildMessageSystemPrompt({ vacancyContext, atsConfig: atsConfig || {} });
  if (!/Обязательные требования/.test(prompt)) {
    return { pass: false, why: 'в системном промпте нет блока «Обязательные требования»' };
  }
  const missing = required.filter(n => !prompt.includes(n));
  if (missing.length) return { pass: false, why: `нет в промпте: ${missing.join(' | ')}` };
  const missingP = preferred.filter(n => !prompt.includes(n));
  if (missingP.length) return { pass: false, why: 'нет желательных: ' + missingP.join(' | ') };
  return { pass: true, why: `required=${required.length} preferred=${preferred.length} — все в промпте` };
}

async function run({ base = process.env.HH_HUB_BASE || 'http://localhost:8080',
                     user = process.env.HH_HUB_USER, token = process.env.HH_HUB_TOKEN,
                     vacancyId = process.env.HH_HUB_VACANCY || '', atsConfig = null,
                     expectRev = process.env.HH_HUB_EXPECT_REV || '', fetch: f = fetch } = {}) {
  if (!user) throw new Error('HH_HUB_USER is required');
  if (!token) throw new Error('HH_HUB_TOKEN is required');
  const results = [];
  const add = (name, pass, why) => results.push({ name, pass, why });

  async function get(path) {
    const q = new URLSearchParams({ username: user, token });
    if (vacancyId) q.set('vacancy_id', vacancyId);
    const response = await f(`${base}${path}?${q}`, { signal: AbortSignal.timeout(20_000) });
    return { status: response.status, text: await response.text() };
  }

  for (const path of PICKER_PAGES) {
    const { status, text } = await get(path);
    if (status !== 200) { add(`${path} открывается`, false, `HTTP ${status}`); continue; }
    add(`${path} открывается`, true, `HTTP ${status}, ${text.length} байт`);
    const r = checkNav(text, { expectsPicker: true });
    add(`${path} выбор вакансии и настройки сверху меню`, r.pass, r.why);
  }
  for (const path of PLAIN_PAGES) {
    const { status, text } = await get(path);
    if (status !== 200) { add(`${path} открывается`, false, `HTTP ${status}`); continue; }
    const r = checkNav(text, { expectsPicker: false });
    add(`${path} страница без переключателя не сломана`, r.pass, r.why);
  }

  {
    const { status, text } = await get('/hh/ats-editor');
    if (status !== 200) add('ATS-редактор открывается', false, `HTTP ${status}`);
    else {
      add('ATS-редактор открывается', true, `HTTP ${status}`);
      add('кнопка «Вернуть общий шаблон» на месте', text.includes('Вернуть общий шаблон'), 'resetInstructionBtn');
      const undef = undefinedFunctions(text);
      add('в редакторе нет вызовов несуществующих функций', undef.length === 0, undef.length ? `нет: ${undef.join(', ')}` : 'все определены');
      // The endpoint the button hits — this is what answered «Failed to fetch».
      const t = await f(`${base}/hh/message-instructions-template?${new URLSearchParams({ username: user, token })}`,
        { signal: AbortSignal.timeout(20_000) });
      const body = await t.text();
      add('эндпоинт общего шаблона отвечает', t.status === 200 && /"ok"\s*:\s*true/.test(body), `HTTP ${t.status}`);
    }
  }

  // Which revision of the skill repo the served pages came from. A stale skill
  // checkout used to be invisible: the agent release looked current while the pages
  // were generated by an old revision, and nothing reported the mismatch. The marker
  // is a <meta> tag the pages embed (src/hh-version.js), so it needs no new route.
  {
    const { status, text } = await get('/hh/ats-editor');
    const m = text.match(/<meta name="hh-skill-rev" content="([0-9a-f]{40})">/);
    if (status !== 200) add('страница несёт метку ревизии скилла', false, `HTTP ${status}`);
    else if (!m) add('страница несёт метку ревизии скилла', false, 'нет <meta name="hh-skill-rev"> — страница отдаётся не из этого репозитория или ревизия неизвестна');
    else add('страница несёт метку ревизии скилла', true, m[1].slice(0, 12));

    // Presence alone is not enough: a stale checkout also carries a marker, just the
    // wrong one. Pass the revision you meant to deploy and the probe refuses to bless
    // anything else — that is what turns «deploy and hope» into «deploy and verify».
    if (expectRev) {
      const expected = String(expectRev).trim();
      const served = m[1];
      const short = h => h.slice(0, 12);
      if (!/^[0-9a-f]{40}$/.test(expected)) {
        add('отдаваемая ревизия совпадает с целевой', false, `HH_HUB_EXPECT_REV не похож на SHA: ${expected}`);
      } else if (served !== expected) {
        add('отдаваемая ревизия совпадает с целевой', false,
          `прод отдаёт ${short(served)}, а задеплоено должно быть ${short(expected)} — вероятно, отдаётся устаревший чекаут`);
      } else {
        add('отдаваемая ревизия совпадает с целевой', true, short(served));
      }
    }
  }

  if (atsConfig) {
    const { buildMessageSystemPrompt } = require('../src/hh-message-prompts');
    const r = checkPrompt(buildMessageSystemPrompt, atsConfig);
    add('обязательные требования вакансии попадают в промпт письма', r.pass, r.why);
  } else {
    results.push({ name: 'обязательные требования вакансии попадают в промпт письма', pass: null, why: 'ats_config не передан — пропущено' });
  }

  const failed = results.filter(r => r.pass === false);
  return { ok: failed.length === 0, user, base, results };
}

module.exports = { run, navMarkup, undefinedFunctions, scriptCode, checkNav, checkPrompt, PICKER_PAGES, PLAIN_PAGES };

if (require.main === module) {
  const raw = process.env.HH_HUB_ATS_CONFIG || '';
  const atsConfig = !raw ? null
    : raw.trim().startsWith('{') ? JSON.parse(raw)
    : JSON.parse(require('fs').readFileSync(raw, 'utf8'));  // path to ats_config:<vacancy>.json
  // The stored file is {value:{...}, updated_at} — unwrap, so the check reads the same
  // object the editor and the writer resolve.
  const cfg = atsConfig && atsConfig.value ? atsConfig.value : atsConfig;
  run({ atsConfig: cfg })
    .then(r => {
      if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
      else for (const x of r.results) console.log(`${x.pass === false ? '✗' : x.pass === null ? '–' : '✓'} ${x.name} — ${x.why}`);
      process.exitCode = r.ok ? 0 : 1;
    })
    .catch(e => { console.error(e.message); process.exitCode = 2; });
}