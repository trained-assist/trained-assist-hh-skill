'use strict';

// Two bases, and keeping them apart is the whole point of this module.
//
//   PUBLIC page base  — the host we put into a link a HUMAN opens: Cold Search
//                       pages, review, ATS editor, vacancy/style pages. May be
//                       per-user (an agency publishes under its own domain).
//   INTERNAL api base — the host WE call from server to server: POST
//                       /hh/sync-negotiations and other callbacks into the
//                       agent. Always the infrastructure URL.
//
// The first attempt at per-tenant publishing fed the user's page domain into
// the internal sync call, so a page-publishing preference silently redirected
// the agent's own API traffic to an arbitrary tenant host. There is no single
// "resolve the base" function any more on purpose: every call site must say
// which of the two it wants.
//
// Storage is the profile's own tokens dir through the shared resolver
// (src/data-paths.js), same plain-file convention as `hh-message-style`, so a
// sandbox run with AGENT_TOKENS_DIR/HOME rewritten stays inside the sandbox.

const fs = require('fs');
const path = require('path');
const { tokensRoot } = require('./data-paths');

const DOMAIN_FILE = 'hh-publish-domain';
const MAX_DOMAIN_LEN = 200;

function stripSlash(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

// Server-to-server base. Deliberately ignores any per-user override.
function internalApiBase(env = process.env, port) {
  const p = port || env.PORT || 3001;
  return stripSlash(env.AGENT_PUBLIC_URL || `http://localhost:${p}`);
}

// Browser callbacks need a reachable API URL independent of host defaults.
// Keep this in the HH systemd drop-in so a host redeploy cannot replace it with
// localhost. Per-profile page publishing does not change the API destination.
function browserApiBase(env = process.env, port) {
  return stripSlash(env.HH_PUBLIC_API_URL || internalApiBase(env, port));
}

// Accept only a bare origin we could actually hand to a recruiter: http/https,
// no credentials, no path/query/fragment, no whitespace. Returns the stripped
// origin or throws with a message the tool can show verbatim.
function normalizePublicDomain(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) throw new Error('Домен пустой. Передай адрес вида https://coldsearch.myagency.ru');
  if (value.length > MAX_DOMAIN_LEN) throw new Error(`Домен длиннее ${MAX_DOMAIN_LEN} символов — это не адрес страницы`);
  if (/\s/.test(value)) throw new Error('В адресе не должно быть пробелов');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`«${value}» — это не URL. Нужен адрес вида https://coldsearch.myagency.ru`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Схема ${url.protocol}// не поддерживается — нужен https:// (или http:// для локального стенда)`);
  }
  if (url.username || url.password) throw new Error('Логин/пароль в адресе не допускаются');
  if (url.search || url.hash) throw new Error('В адресе не должно быть параметров после домена (?… или #…)');
  if (url.pathname && url.pathname !== '/') {
    throw new Error('В адресе не должно быть пути — только домен, например https://coldsearch.myagency.ru');
  }
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') {
    throw new Error(`«${url.hostname}» — это не домен. Нужен полный адрес, например https://coldsearch.myagency.ru`);
  }
  return stripSlash(url.origin);
}

function publishDomainFile(username) {
  if (!username) throw new Error('Нужен username профиля');
  return path.join(tokensRoot(), String(username), DOMAIN_FILE);
}

function loadPublishDomain(username) {
  if (!username) return null;
  try {
    const file = publishDomainFile(username);
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return null;
    return normalizePublicDomain(raw); // a hand-edited file is validated too
  } catch (e) {
    return null; // unreadable or invalid override → behave as "not set"
  }
}

function savePublishDomain(username, raw) {
  const domain = normalizePublicDomain(raw); // throws BEFORE anything is written
  const file = publishDomainFile(username);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${domain}\n`, { mode: 0o600 });
  return domain;
}

function clearPublishDomain(username) {
  const file = publishDomainFile(username);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  return true;
}

// Public page base for a link we generate on someone's behalf.
// Precedence: per-user override → the call site's own env chain (each call site
// keeps its historical chain and default) → that default. Callers pass the env
// names they already honoured, so adding an override cannot reorder the rest.
function publicPageBase(username, envNames = [], fallback = '', env = process.env) {
  const override = loadPublishDomain(username);
  if (override) return override;
  for (const name of envNames) {
    if (env[name]) return stripSlash(env[name]);
  }
  return stripSlash(fallback);
}

// Chain used by Cold Search page links (proactive/hub/review digests).
const COLD_SEARCH_ENV = ['HH_COLD_SEARCH_PUBLIC_URL'];
// Chain used by HH tool pages (review, ATS editor, vacancy, style).
const HH_PAGES_ENV = ['HH_PLATFORM_URL', 'AGENT_PUBLIC_URL'];

module.exports = {
  DOMAIN_FILE,
  COLD_SEARCH_ENV,
  HH_PAGES_ENV,
  internalApiBase,
  browserApiBase,
  normalizePublicDomain,
  publishDomainFile,
  loadPublishDomain,
  savePublishDomain,
  clearPublishDomain,
  publicPageBase,
};