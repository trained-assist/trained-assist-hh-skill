'use strict';
const { tokensRoot } = require('./data-paths.js');
// Shared HH utilities — used by 90-hh.js (MCP) and hh-quick.js (runner quick answers).
// Single source of truth for token reading, context I/O, and HH API HTTP.

const fs = require('fs');
const path = require('path');
const os = require('os');
// Credential store (trained-assist-agent#1939): the `hh` token file passes
// through it — legacy plaintext transparent, a v2 envelope decrypted, a base64
// stub never returned as a token, a missing CRED_ENCRYPTION_KEY → plaintext
// with a warning (never a hard failure).
const { readCredentialFile, writeCredentialFile } = require('./credential-store');

function hhApiBase() {
  return process.env.HH_API_BASE_URL || 'https://api.hh.ru';
}

function hhTokenBase() {
  return tokensRoot();
}

function hhTokenPath(userId) {
  return path.join(hhTokenBase(), String(userId), 'hh');
}

// Reads HH token from disk. Handles both JSON object and plain-string formats.
function readHhToken(userId) {
  const raw = readCredentialFileSafe(hhTokenPath(userId));
  if (raw === null) return null; // absent / undecryptable — never the base64 stub
  try {
    const trimmed = raw.trim();
    return trimmed.startsWith('{') ? JSON.parse(trimmed) : { access_token: trimmed };
  } catch { return null; }
}

/**
 * Plaintext of a credential file, or null when it cannot be produced — the
 * single safe reader for every credential file this skill touches:
 *   - legacy plaintext passes through as-is;
 *   - a v2 envelope is decrypted;
 *   - an encrypted file with no CRED_ENCRYPTION_KEY warns and yields null
 *     (never the base64 stub, never a thrown error inside a route handler);
 *   - an absent file yields null quietly.
 */
function readCredentialFileSafe(filePath) {
  try {
    return readCredentialFile(filePath);
  } catch (e) {
    if (e && e.code !== 'ENOENT' && /CRED_ENCRYPTION_KEY/.test(String(e.message))) {
      console.warn('[hh] %s: %s — treating the credential as absent', filePath, e.message);
    }
    return null;
  }
}

/**
 * Read the `hh` token FILE (already-built path) as JSON — the one chokepoint for
 * the /hh/* routes, which all need the parsed token object.
 * Returns null when the file is absent, unreadable or not JSON — never the stub.
 */
function readHhTokenFile(filePath) {
  const raw = readCredentialFileSafe(filePath);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Context helpers — workDir is explicit (for runner) or null → the profile root (for MCP),
// never the project folder a session may be bound to (see data-paths.profileWorkDir).
function hhContextPath(workDir, skill, key) {
  return path.join(workDir || require('./data-paths').profileWorkDir(), 'contexts', skill, `${key}.json`);
}

function readHhContext(workDir, skill, key) {
  try {
    return JSON.parse(fs.readFileSync(hhContextPath(workDir, skill, key), 'utf8'));
  } catch { return null; }
}

async function writeHhContext(workDir, skill, key, value) {
  const file = hhContextPath(workDir, skill, key);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(
    file,
    JSON.stringify({ value, updated_at: new Date().toISOString() }, null, 2),
  );
}

// active_vacancies[]: profiles tracking several vacancies at once (see 90-hh.js
// hh_set_active_vacancy). Falls back to the legacy singleton active_vacancy.json
// for profiles that have never tracked a second vacancy — this is the single
// source of truth for "which vacancies does this profile track", reused by both
// the MCP tools and the background scoring loop so they can't drift apart.
function readActiveVacancies(workDir) {
  const list = readHhContext(workDir, 'hh', 'active_vacancies')?.value;
  if (Array.isArray(list)) return list;
  const legacy = readHhContext(workDir, 'hh', 'active_vacancy')?.value;
  return legacy?.id ? [legacy] : [];
}

const HH_FETCH_TIMEOUT_MS = 15_000;

// HTTP 403 also means insufficient permissions: only explicit OAuth failures
// require reconnecting. Preserve the provider payload for callers and tests.
function isHhAuthError(error) {
  if (error?.status == null) return /HH(?: API)? 40[13].*token[-_ ]?expired/i.test(String(error?.message || ''));
  if (![401, 403].includes(Number(error.status))) return false;
  const data = error.provider_error || {};
  const markers = [data.description, data.error, ...(Array.isArray(data.errors) ? data.errors : []).flatMap(e => [e.type, e.value])].filter(Boolean);
  return markers.some(value => /^(?:unrecognized authorization|invalid authorization|token[-_ ]?(?:expired|invalid|revoked)|invalid[-_ ]?token|invalid_grant)$/i.test(String(value).trim()));
}
function hhApiError(status, apiPath, data = {}, method = 'GET') {
  const detail = data.description || (Array.isArray(data.errors) ? data.errors.map(e => e.value || e.type).join(', ') : '') || data.error || '';
  const error = new Error(method === 'GET' ? `HH API ${status}: ${apiPath}${detail ? ` — ${detail}` : ''}` : `HH API ${method} ${status}: ${JSON.stringify(data).slice(0, 200)}`);
  error.status = status;
  error.api_path = apiPath;
  error.method = method;
  error.provider_error = data;
  error.code = isHhAuthError(error) ? 'HH_REAUTH_REQUIRED' : 'HH_API_ERROR';
  return error;
}
function hhAuthErrorResponse(error) {
  return { code: 'HH_REAUTH_REQUIRED', reauth_required: true,
    error: 'Авторизация HeadHunter истекла или отозвана. Подключите HH заново в чате с ассистентом и повторите действие.' };
}


// HH API via fetch (Node 18+). Respects HH_API_BASE_URL for test mocking.
async function hhFetch(apiPath, token) {
  const res = await fetch(`${hhApiBase()}${apiPath}`, {
    signal: AbortSignal.timeout(HH_FETCH_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'User-Agent': `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`,
      'HH-User-Agent': `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`,
    },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw hhApiError(res.status, apiPath, data);
  }
  return res.json();
}

// Safe read retry only. Never replay a message POST after an uncertain outcome.
async function hhFetchWithRefresh(apiPath, token, username, secrets) {
  try { return await hhFetch(apiPath, token); }
  catch (error) {
    if (!isHhAuthError(error)) throw error;
    const stored = readHhToken(username);
    const fresh = stored?.access_token && stored.access_token !== token.access_token ? stored.access_token : await refreshHhToken(username, secrets, token.access_token);
    if (!fresh) throw error;
    token.access_token = fresh;
    return hhFetch(apiPath, token);
  }
}

async function hhPost(apiPath, token, body) {
  const res = await fetch(`${hhApiBase()}${apiPath}`, {
    method: 'POST',
    signal: AbortSignal.timeout(HH_FETCH_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
      'User-Agent': `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`,
      'HH-User-Agent': `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw hhApiError(res.status, apiPath, data, 'POST');
  return data;
}

async function hhPut(apiPath, token, body) {
  const res = await fetch(`${hhApiBase()}${apiPath}`, {
    method: 'PUT',
    signal: AbortSignal.timeout(HH_FETCH_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'User-Agent': `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`,
      'HH-User-Agent': `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return { status: 204 };
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw hhApiError(res.status, apiPath, data, 'PUT');
  return data;
}

// OAuth token refresh. Needs client id/secret from env secrets; rewrites the token
// file in place with the fresh access/refresh pair. Returns the new access_token or null.
const hhRefreshInFlight = new Map();
function refreshHhToken(userId, secrets, expectedAccessToken) {
  const key = String(userId);
  if (hhRefreshInFlight.has(key)) return hhRefreshInFlight.get(key);
  const pending = performHhTokenRefresh(userId, secrets, expectedAccessToken).finally(() => hhRefreshInFlight.delete(key));
  hhRefreshInFlight.set(key, pending);
  return pending;
}
async function performHhTokenRefresh(userId, secrets, expectedAccessToken) {
  if (!secrets?.HH_CLIENT_ID || !secrets?.HH_CLIENT_SECRET) {
    console.warn('[hh-refresh] HH OAuth client credentials are not configured — cannot refresh');
    return null;
  }
  const file = hhTokenPath(userId);
  if (!fs.existsSync(file)) return null;
  const initial = readHhTokenFile(file);
  if (!initial || !initial.refresh_token) return null;
  const expected = expectedAccessToken || initial.access_token;
  const release = await require('./hh-refresh-lock').acquireHhRefreshLock(file+'.refresh.lock');
  try {
    // Another process may have rotated this credential while we waited.
    const stored = readHhTokenFile(file);
    if (!stored || !stored.refresh_token) return null;
    if (stored.access_token !== expected) return stored.access_token;
    const res = await fetch('https://hh.ru/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: secrets.HH_CLIENT_ID,
        client_secret: secrets.HH_CLIENT_SECRET,
        refresh_token: stored.refresh_token,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json();
    if (!data.access_token) {
      console.warn(`[hh-refresh] HH refused refresh for ${userId}: ${data.error || 'no access_token'}`);
      return null;
    }
    const updated = {
      ...stored,
      access_token: data.access_token,
      refresh_token: data.refresh_token || stored.refresh_token,
      saved_at: new Date().toISOString(),
    };
    writeCredentialFile(file, JSON.stringify(updated, null, 2));
    console.log(`[hh-refresh] refreshed HH credentials for ${userId}`);
    return data.access_token;
  } catch (e) {
    console.error(`[hh-refresh] error for ${userId}: ${e.message}`);
    return null;
  } finally { release(); }
}

// Form-encoded POST — HH messages endpoint requires application/x-www-form-urlencoded, not JSON.
async function hhPostForm(apiPath, token, fields) {
  const bodyStr = new URLSearchParams(fields).toString();
  const res = await fetch(`${hhApiBase()}${apiPath}`, {
    method: 'POST',
    signal: AbortSignal.timeout(HH_FETCH_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`,
      'HH-User-Agent': `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`,
    },
    body: bodyStr,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw hhApiError(res.status, apiPath, data, 'POST');
  return data;
}

module.exports = { hhFetchWithRefresh, isHhAuthError, hhApiError, hhAuthErrorResponse, readHhToken, readHhTokenFile, readCredentialFileSafe, readHhContext, writeHhContext, readActiveVacancies, hhFetch, hhPost, hhPut, hhPostForm, hhTokenPath, refreshHhToken };
