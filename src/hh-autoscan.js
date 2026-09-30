'use strict';
const { tokensRoot } = require('./data-paths.js');

// Opt-in state + cadence gate for automatic cold-search ("проактивный поиск").
//
// Why this exists: PR #768 added seen-ids persistence + a Telegram digest that
// fires from inside runProactiveSearch. But nothing RAN runProactiveSearch on a
// schedule — the 5-min background loop only *re-scored* already-collected cold
// candidates. So "notify me when new candidates appear" never fired on its own;
// the recruiter had to manually /hh_scan. This module lets a recruiter opt in and
// the background loop then triggers a fresh cold search on a cadence. See #798.
//
// State file: agent-tokens/<username>/hh-autoscan.json
//   { enabled: bool, intervalMinutes: number, lastRunAt: ISO|null, enabledAt: ISO|null }
// Absent file = disabled (default OFF — we never auto-scan or notify unasked).

const path = require('path');
const os = require('os');
const { createHmac } = require('crypto');
// Credential store (trained-assist-agent#1939): this state file lives under
// agent-tokens, so the migration encrypts it — read/write it through the store
// (legacy plaintext transparent, v2 envelope decrypted, stub never returned,
// missing CRED_ENCRYPTION_KEY → plaintext with a warning).
const { readCredentialFileSafe } = require('./hh-utils');
const { writeCredentialFile } = require('./credential-store');

const DEFAULT_INTERVAL_MIN = 60; // don't burn HH API / spam chat every 5 min
const DEFAULT_STATE = () => ({ enabled: false, intervalMinutes: DEFAULT_INTERVAL_MIN, lastRunAt: null, enabledAt: null });

function tokensBase() {
  return tokensRoot();
}

function statePath(username) {
  return path.join(tokensBase(), String(username), 'hh-autoscan.json');
}

function readState(username) {
  // Absent or undecryptable → OFF (we never auto-scan unasked), never the stub.
  const text = readCredentialFileSafe(statePath(username));
  if (text == null) return DEFAULT_STATE();
  try {
    const raw = JSON.parse(text);
    const iv = Number(raw.intervalMinutes);
    return {
      enabled: !!raw.enabled,
      intervalMinutes: iv > 0 ? iv : DEFAULT_INTERVAL_MIN,
      lastRunAt: raw.lastRunAt || null,
      enabledAt: raw.enabledAt || null,
    };
  } catch {
    return DEFAULT_STATE();
  }
}

function writeState(username, patch) {
  const next = { ...readState(username), ...patch };
  const file = statePath(username);
  // The store mkdir's the profile dir and writes mode 0600 (plus the .meta
  // sidecar / .index.json entry when a master key is present).
  writeCredentialFile(file, JSON.stringify(next, null, 2));
  return next;
}

function enable(username, intervalMinutes, nowIso) {
  const patch = { enabled: true, enabledAt: nowIso || new Date().toISOString() };
  if (Number(intervalMinutes) > 0) patch.intervalMinutes = Number(intervalMinutes);
  return writeState(username, patch);
}

function disable(username) {
  return writeState(username, { enabled: false });
}

function markRun(username, nowIso) {
  return writeState(username, { lastRunAt: nowIso || new Date().toISOString() });
}

// Pure: decide whether a fresh cold search is due. nowMs is injected so this is
// deterministic and testable.
function shouldRun(state, nowMs) {
  if (!state || !state.enabled) return false;
  if (!state.lastRunAt) return true; // enabled but never run → run now
  const last = Date.parse(state.lastRunAt);
  if (Number.isNaN(last)) return true; // corrupt timestamp → don't get stuck
  const intervalMs = (state.intervalMinutes > 0 ? state.intervalMinutes : DEFAULT_INTERVAL_MIN) * 60 * 1000;
  return (nowMs - last) >= intervalMs;
}

// Signed URL to the recruiter's proactive results page (same HMAC scheme as
// 92-hh-proactive.js so the digest link opens the right page). `vacancyId` is a
// plain, non-HMAC'd query param appended alongside the token — same pattern as
// hhReviewUrl in hh-quick.js — so multi-vacancy step 7's tab switcher can deep-link
// straight into the right tab. Omitted (falsy) → no param, unchanged for
// single-vacancy callers.
function proactiveUrlFor(username, vacancyId) {
  const base = (process.env.HH_COLD_SEARCH_PUBLIC_URL || 'https://recruiter-assistant.ru').replace(/\/$/, '');
  const token = createHmac('sha256', process.env.AGENT_SECRET || '').update(String(username)).digest('hex').slice(0, 16);
  const vacancyParam = vacancyId ? `&vacancy_id=${encodeURIComponent(vacancyId)}` : '';
  return `${base}/hh/proactive?username=${encodeURIComponent(username)}&token=${token}${vacancyParam}`;
}

module.exports = {
  DEFAULT_INTERVAL_MIN,
  statePath,
  readState,
  writeState,
  enable,
  disable,
  markRun,
  shouldRun,
  proactiveUrlFor,
};
