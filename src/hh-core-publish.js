'use strict';
// Publish a page through core's POST /internal/publish (trained-assist-agent#1470) —
// the same writer as core's publish_page tool, reached over HTTP so this repo never
// requires core code. Core address/secret resolution mirrors hh-cold-search-cron.js.
function coreBase(env = process.env) {
  if (env.AGENT_INTERNAL_URL) return env.AGENT_INTERNAL_URL.replace(/\/$/, '');
  if (env.PORT) return `http://127.0.0.1:${env.PORT}`;
  return (env.AGENT_PUBLIC_URL || '').replace(/\/$/, '');
}

async function publishPage(page, { env = process.env, fetchImpl = fetch } = {}) {
  const base = coreBase(env);
  if (!base || !env.AGENT_SECRET) return { error: 'Публикация недоступна из этого окружения (нет адреса ядра или секрета)' };
  try {
    const res = await fetchImpl(`${base}/internal/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.AGENT_SECRET}` },
      body: JSON.stringify(page),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { error: body.error || `publish failed: HTTP ${res.status}` };
    return body;
  } catch (e) {
    return { error: `publish failed: ${e.message}` };
  }
}

module.exports = { publishPage, coreBase };
