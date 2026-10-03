'use strict';

// Single LLM entry point for the HH skill.
//
// Before this file every module had its own OpenRouter/GigaChat copy, its own key
// resolver and its own failover. The resolvers read the PERSONAL key first
// (agent-tokens/<user>/openrouter) and returned it if the file existed — even when
// that key was dead (401 «User not found», live case vova-recruiter 01.10.2026) — so
// the working shared credential was never reached. The background scorer, the message
// guard and the criteria guard all failed the same way, each in its own copy, each
// reporting a different symptom.
//
// The fix is one place: callers say WHAT the call is for, the routing table picks the
// ladder of trained-assist-llm-ladder (src/llm-ladder.js), and the ladder owns rung
// order, failover, model health and credentials. No caller reads an API key any more.
//
// Routing (owner 2026-10-01):
//   message — writing a message to a candidate            → 'conversation'
//   score   — ATS / primitive evaluation, guards          → 'free'
//   default — everything else (planning, extraction, rewriting, tips) → 'service'
//
// The ladder name can be overridden per call (ladder) or per skill (env HH_LLM_LADDER),
// and a single rung can be pinned (rung) for model switch / bench — same contract as
// src/llm-ladder.js.

const { ladderChat, ladderToken, ladderUrl } = require('./llm-ladder');

const LADDERS = {
  message: 'conversation',
  score: 'free',
  default: 'service',
};

function ladderFor(purpose) {
  return LADDERS[purpose] || LADDERS.default;
}

/**
 * One chat completion through the ladder.
 *
 * @param {object} o
 * @param {Array<{role:string,content:string}>} o.messages
 * @param {'message'|'score'|'default'} [o.purpose='default']
 * @param {string} [o.ladder]      explicit ladder name — overrides purpose
 * @param {string|null} [o.rung]   pin ONE rung (no failover) — model switch / bench
 * @param {number} [o.temperature=0]
 * @param {number} [o.maxTokens=800]
 * @param {number} [o.timeoutMs=20000]
 * @param {string} [o.source='hh'] x-ladder-app attribution slug
 * @param {Function} [o.fetchImpl] injected HTTP function for tests
 * @returns {Promise<string>} assistant message content
 */
async function hhLlm({ messages, purpose = 'default', ladder, rung = null, temperature = 0, maxTokens = 800, timeoutMs = 20000, source = 'hh', fetchImpl = null } = {}) {
  const usedLadder = ladder || process.env.HH_LLM_LADDER || ladderFor(purpose);
  const { content } = await ladderChat({ messages, ladder: usedLadder, rung, temperature, maxTokens, timeoutMs, source, fetchImpl });
  return content;
}

/** Strip a markdown fence and parse JSON — the ladder models sometimes wrap output. */
function parseJsonLoose(text) {
  if (!text) throw new Error('hh-llm: empty content');
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  return JSON.parse(s);
}

/** hhLlm + parseJsonLoose: for calls whose answer is a JSON object. */
async function hhLlmJson(opts) {
  return parseJsonLoose(await hhLlm(opts));
}

module.exports = { hhLlm, hhLlmJson, parseJsonLoose, ladderFor, ladderToken, ladderUrl };
