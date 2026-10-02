'use strict';
// Shared recruiting-hub nav bar (trained-assist-agent#1742, UX spec §2).
// Injected into every /hh/* HTML page by wrapping the response — the page generators
// (hh-proactive-page.js, hh-review-page-html.js, …) are NOT edited: existing markup,
// JS and query params stay byte-for-byte as before, the nav block is the only addition,
// placed right after the opening <body> tag.
// Links are relative (pages live at /hh/<page>, and legacy /agent/hh/<page>), carrying
// username/token (and vacancy_id when the page has one) from the page's own query —
// the same way the review page's vacancy-tabs build their hrefs.

const NAV_ITEMS = [
  { path: '/hh/vacancies', label: 'Вакансии' },
{ path: '/hh/vacancy-new', label: 'Портрет' },
  { path: '/hh/review', label: 'Кандидаты' },
{ path: '/hh/candidate-new', label: '+ Кандидат' },
  { path: '/hh/proactive', label: 'Холодный поиск' },
  { path: '/hh/ats-editor', label: 'ATS воронка' },
  { path: '/hh/sync-log', label: 'Синхронизация' },
];

// Epic #112: the gear «Общие настройки» menu. «Стиль» lives here (was a flat nav
// item) — these are the global per-recruiter layers, not per-vacancy pages, and the
// dropdown keeps them from pretending to be part of the per-vacancy flow.
const SETTINGS_ITEMS = [
  { path: '/hh/style', label: 'Стиль' },
];

const NAV_ID = 'hh-hub-nav';

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Query string shared by every nav link: identity (username/token) plus the vacancy
// the recruiter is looking at, so switching sections keeps the same vacancy selected.
function navQuery({ username, token, vacancyId }) {
  const q = new URLSearchParams({ username: username || '', token: token || '' });
  if (vacancyId) q.set('vacancy_id', vacancyId);
  return q.toString();
}

function hhNavHtml({ pathname = '', username, token, vacancyId } = {}) {
  const qs = escHtml(navQuery({ username, token, vacancyId }));
  const linkFor = ({ path, label }) => {
    const active = pathname.endsWith(path);
    const href = `${path.slice('/hh/'.length)}?${qs}`;
    return `<a href="${href}"${active ? ' class="active" aria-current="page"' : ''}>${escHtml(label)}</a>`;
  };
  const links = NAV_ITEMS.map(linkFor).join('');
  const settingsLinks = SETTINGS_ITEMS.map(linkFor).join('');
  // Styles are scoped to #hh-hub-nav and set every property they rely on, so page
  // resets (`*{margin:0;padding:0}`, dark themes) neither break the bar nor leak out.
  return `<nav id="${NAV_ID}" aria-label="Рекрутинг-хаб"><style>` +
    `#${NAV_ID}{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin:0;padding:8px 16px;background:#fff;border-bottom:1px solid #e2e8f0;font:500 14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;box-sizing:border-box;width:100%}` +
    `#${NAV_ID} a,#${NAV_ID} summary{display:inline-block;margin:0;padding:6px 12px;border-radius:8px;color:#475569;text-decoration:none;white-space:nowrap;cursor:pointer;list-style:none}` +
    `#${NAV_ID} a:hover,#${NAV_ID} summary:hover{background:#f1f5f9;color:#1e293b}` +
    `#${NAV_ID} a.active{background:#eef2ff;color:#4338ca;font-weight:600}` +
    `#${NAV_ID} .hh-nav-settings{position:relative;display:inline-block}` +
    `#${NAV_ID} .hh-nav-settings-menu{position:absolute;right:0;top:calc(100% + 4px);z-index:50;min-width:180px;background:#fff;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 8px 24px rgba(15,23,42,.12);padding:6px;display:none}` +
    `#${NAV_ID} .hh-nav-settings[open] .hh-nav-settings-menu{display:block}` +
    `#${NAV_ID} .hh-nav-settings-menu a{display:block;padding:8px 10px;border-radius:8px}` +
    `@media(max-width:640px){#${NAV_ID}{padding:6px 8px;overflow-x:auto;flex-wrap:nowrap}#${NAV_ID} a,#${NAV_ID} summary{padding:6px 8px}}` +
    `</style>${links}<details class="hh-nav-settings" data-testid="nav-settings"` +
    `${pathname.endsWith('/hh/style') ? ' open' : ''}><summary>⚙ Общие настройки</summary><div class="hh-nav-settings-menu">${settingsLinks}</div></details></nav>`;
}

// Insert the nav right after the first opening <body …> tag. Pages without a body tag
// (JSON, fragments) and pages that already carry the nav are returned unchanged.
function injectHhNav(html, opts) {
  if (typeof html !== 'string' || html.includes(`id="${NAV_ID}"`)) return html;
  const m = /<body\b[^>]*>/i.exec(html);
  if (!m) return html;
  const at = m.index + m[0].length;
  return html.slice(0, at) + hhNavHtml(opts) + html.slice(at);
}

// Wrap `res` so an HTML response written by any GET /hh/* handler gets the nav.
// `isAuthorized(username, token)` gates it: invalid-link error pages stay nav-less
// (their links could not work anyway). Only writeHead/end are intercepted — status,
// headers and every other byte of the response are untouched.
function withHhNav(req, url, res, { isAuthorized } = {}) {
  if (req.method !== 'GET' || !url.pathname.includes('/hh/')) return res;
  const username = url.searchParams.get('username') || '';
  const token = url.searchParams.get('token') || '';
  if (!username || (isAuthorized && !isAuthorized(username, token))) return res;
  const opts = { pathname: url.pathname, username, token, vacancyId: url.searchParams.get('vacancy_id') || '' };
  let isHtml = false;
  const origWriteHead = res.writeHead;
  const origEnd = res.end;
  res.writeHead = function (status, ...rest) {
    const headers = rest.find(h => h && typeof h === 'object');
    const type = (headers && (headers['Content-Type'] || headers['content-type'])) ||
      (typeof res.getHeader === 'function' && res.getHeader('content-type')) || '';
    isHtml = /text\/html/i.test(String(type));
    return origWriteHead.call(this, status, ...rest);
  };
  res.end = function (chunk, ...rest) {
    if (isHtml && typeof chunk === 'string') chunk = injectHhNav(chunk, opts);
    return origEnd.call(this, chunk, ...rest);
  };
  return res;
}

// Full vacancy name for pickers: title · city · company. Profiles track the same role
// in several cities, so a bare title is ambiguous; company comes from company_label
// ("Атон — Финансовый советник" → "Атон").
function vacancyLabel(v = {}) {
  const city = v.area?.name || (typeof v.area === 'string' ? v.area : '');
  const company = String(v.company_label || '').split(' — ')[0].trim();
  return [v.title || v.id, city, company].filter(Boolean).join(' · ');
}

// One vacancy switcher shared by every /hh/* page (proactive, review, ATS editor).
// A dropdown instead of a row of chips: with 10+ vacancies the chips filled the whole
// first screen and had to truncate names. hrefFor(v) builds each page's own link.
// Always visible (epic #112) — even with a single vacancy, so the photo rectangle
// and «+ Добавить вакансию» are reachable exactly when the vacancy is one.
function vacancyPickerHtml(vacancies, currentId, hrefFor, addVacancyHref = '') {
  const list = Array.isArray(vacancies) ? vacancies : [];
  const options = list.map(v => {
    const selected = String(v.id) === String(currentId) ? ' selected' : '';
    return `<option value="${escHtml(hrefFor(v))}"${selected}>${escHtml(vacancyLabel(v))}</option>`;
  }).join('');
  const hasCurrent = list.some(v => String(v.id) === String(currentId));
  const addBtn = addVacancyHref
    ? `<a class="vacancy-add" data-testid="vacancy-add" href="${escHtml(addVacancyHref)}" ` +
      `style="flex:0 0 auto;padding:8px 14px;border:1px solid #c7d2fe;border-radius:8px;font-size:14px;font-weight:600;color:#4338ca;background:#eef2ff;text-decoration:none;white-space:nowrap">+ Добавить вакансию</a>`
    : '';
  return `<div class="vacancy-picker" data-testid="vacancy-picker" style="display:flex;gap:10px;align-items:center;margin:0 0 10px;flex-wrap:wrap">` +
    `<div style="flex:1 1 260px;min-width:220px">` +
    `<label style="display:block;font-size:12px;color:#64748b;margin-bottom:4px">Вакансия (${list.length})</label>` +
    `<select aria-label="Вакансия" onchange="if(this.value)location.href=this.value" ` +
    `style="width:100%;max-width:720px;padding:8px 10px;border:1px solid #c7d2fe;border-radius:8px;font-size:14px;font-weight:600;color:#1e293b;background:#fff">` +
    `${hasCurrent ? '' : '<option value="" selected>— выберите вакансию —</option>'}${options}</select></div>${addBtn}</div>`;
}

module.exports = { NAV_ITEMS, SETTINGS_ITEMS, NAV_ID, hhNavHtml, injectHhNav, withHhNav, escHtml, vacancyLabel, vacancyPickerHtml };
