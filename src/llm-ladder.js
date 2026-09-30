'use strict';

// Thin client for OUR model ladder — the trained-assist-llm-ladder Cloudflare Worker
// (https://llm-ladder.trainedassist.store, repo trained-assist/trained-assist-llm-ladder).
// One HTTP contract for every LLM call that has left direct OpenRouter: the worker owns
// rung order, failover, model health and key rotation; we only pick WHICH ladder (and,
// when explicitly pinned, WHICH rung of it).
//
// Ladders used here (trained-assist-hh-skill):
//   conversations — writing messages to candidates (src/conversation-generation.js)
//   free-ladder   — ATS candidate evaluation (decided by the A/B 2026-09-30, docs/evals)
//   service       — the funnel planner (default ladder, Go mimo first)
//
// Token: LLM_LADDER_TOKEN, else $AGENT_TOKENS_DIR/llm-ladder/token (same files as
// trained-assist-agent src/service-llm.js). Callers fail loudly: an exception here
// reaches the route/tool error path the old direct-OpenRouter errors did.

const path = require('path');
const { tokensRoot } = require('./data-paths');
// Credential store (trained-assist-agent#1939) via hh-utils' safe reader: the
// ladder token lives at $AGENT_TOKENS_DIR/llm-ladder/token, which the one-time
// migration encrypts — plaintext transparent, envelope decrypted, a base64 stub
// never returned as a token, missing CRED_ENCRYPTION_KEY → null with a warning.
const { readCredentialFileSafe } = require('./hh-utils');

function ladderUrl() {
  return (process.env.LLM_LADDER_URL || 'https://llm-ladder.trainedassist.store').replace(/\/+$/, '');
}

function ladderToken() {
  if (process.env.LLM_LADDER_TOKEN) return process.env.LLM_LADDER_TOKEN.trim();
  const text = readCredentialFileSafe(path.join(tokensRoot(), 'llm-ladder', 'token'));
  return text ? text.trim() : null; // absent / unreadable = no token
}

/**
 * One OpenAI-shaped chat completion through the ladder.
 *
 * @param {object} o
 * @param {Array<{role:string,content:string}>} o.messages
 * @param {string}  [o.ladder='service']  ladder name (or `ladder:role`) from config/ladders.json
 * @param {string|null} [o.rung=null]     pin ONE rung of that ladder (no failover) — model switch / bench
 * @param {number}  [o.temperature=0]
 * @param {number}  [o.maxTokens=800]
 * @param {number}  [o.timeoutMs=20000]   per-rung budget on the worker
 * @param {string}  [o.source='hh']       x-ladder-app attribution slug ([a-z0-9-], ≤64)
 * @param {Function}[o.fetchImpl]         injectable fetch (tests)
 * @returns {Promise<{content:string, model:string|null, usage:object|null}>}
 * @throws {Error} no token / HTTP error from the worker / empty content
 */
async function ladderChat({ messages, ladder = 'service', rung = null, temperature = 0, maxTokens = 800, timeoutMs = 20000, source = 'hh', fetchImpl = null } = {}) {
  const token = ladderToken();
  if (!token) throw new Error('llm-ladder: no token (LLM_LADDER_TOKEN / $AGENT_TOKENS_DIR/llm-ladder/token)');
  if (!Array.isArray(messages) || !messages.length) throw new Error('llm-ladder: messages required');

  const body = {
    model: ladder,
    messages,
    temperature,
    max_tokens: maxTokens,
    ladder_timeout_ms: timeoutMs,
    ...(rung ? { ladder_rung: rung } : {}),
  };

  let res;
  try {
    res = await (fetchImpl || fetch)(`${ladderUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-ladder-app': source,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs + 20_000),
    });
  } catch (e) {
    throw new Error(`llm-ladder unreachable: ${e.message}`);
  }

  let data = null;
  let bodyError = null;
  try { data = await res.json(); } catch (e) { bodyError = e.message; }
  if (!res.ok) {
    const attempts = data?.error?.attempts ? ` attempts=${JSON.stringify(data.error.attempts).slice(0, 300)}` : '';
    throw new Error(`llm-ladder HTTP ${res.status}: ${data?.error?.message || bodyError || ''}${attempts}`);
  }

  const content = String(data?.choices?.[0]?.message?.content ?? '');
  if (!content.trim()) throw new Error(`llm-ladder: empty content (rung=${data?.model || ladder})`);
  return { content, model: data?.model || null, usage: data?.usage || null };
}

module.exports = { ladderChat, ladderToken, ladderUrl };
