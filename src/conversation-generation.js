'use strict';

// Conversation generation — the single entry point for WRITING messages to candidates.
// Everything the product writes (review-page draft, MCP generate tool, background
// auto-drafts) goes through here; this layer calls our llm-ladder (src/llm-ladder.js)
// instead of a per-file direct OpenRouter copy, so the model is chosen in ONE place:
//
//   ladder  = env HH_CONVERSATION_LADDER  (default 'conversations' — config/ladders.json
//             of trained-assist-llm-ladder: gemini-3.1-flash-lite-preview →
//             gemini-2.5-flash → Go mimo)
//   rung    = env HH_CONVERSATION_RUNG    (default none — the ladder walks; set a rung id
//             to PIN one model, no failover: model switch for tests / A/B / bench)
//
// Every accepted exchange is recorded — last N in memory (conversationHistory()) plus
// appended to a JSONL file (conversationHistoryFile()) — question (the exact messages
// sent) and answer, with the rung that actually served it. That buffer is what a future
// bench replays across candidate models; nothing else in the repo keeps it.
//
// Recording is best-effort: a failed append logs a warning, never fails the generation.

const fs = require('fs');
const path = require('path');
const { dataRoot } = require('./data-paths');
const { ladderChat } = require('./llm-ladder');

const DEFAULT_LADDER = 'conversations';
const DEFAULT_HISTORY_LIMIT = 20;

let history = [];

function conversationLadder() {
  return process.env.HH_CONVERSATION_LADDER || DEFAULT_LADDER;
}

function conversationRung() {
  return process.env.HH_CONVERSATION_RUNG || null;
}

function historyLimit() {
  const n = Number(process.env.HH_CONVERSATION_HISTORY_LIMIT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_HISTORY_LIMIT;
}

function conversationHistoryFile() {
  return process.env.HH_CONVERSATION_HISTORY_FILE
    || path.join(dataRoot(), 'hh', 'conversation-history.jsonl');
}

/**
 * Generate the next message of a conversation through the ladder and remember
 * the exchange (question + answer) for the bench.
 *
 * @param {object} o — see src/llm-ladder.js ladderChat, plus:
 * @param {string} [o.source='hh-conversation'] x-ladder-app attribution
 * @returns {Promise<string>} the assistant message text
 */
async function generateConversation({ messages, temperature = 0.7, maxTokens = 800, ladder, rung, timeoutMs, source = 'hh-conversation', fetchImpl } = {}) {
  const usedLadder = ladder || conversationLadder();
  const usedRung = rung !== undefined && rung !== null ? rung : conversationRung();
  const res = await ladderChat({ messages, ladder: usedLadder, rung: usedRung, temperature, maxTokens, timeoutMs, source, fetchImpl });
  rememberExchange({ messages, answer: res.content, ladder: usedLadder, rung: usedRung, model: res.model, temperature });
  return res.content;
}

function rememberExchange(entry) {
  const record = { ts: new Date().toISOString(), ...entry };
  history.push(record);
  while (history.length > historyLimit()) history.shift();
  try {
    const file = conversationHistoryFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
  } catch (e) {
    console.warn(`[conversation-generation] history append failed: ${e.message}`);
  }
}

/** Last N exchanges, oldest first — a copy, safe for the caller to hold. */
function conversationHistory() {
  return history.slice();
}

/** Drop the in-memory buffer (tests). The JSONL file is never touched. */
function clearConversationHistory() {
  history = [];
}

module.exports = {
  generateConversation,
  conversationHistory,
  clearConversationHistory,
  conversationHistoryFile,
  conversationLadder,
  conversationRung,
};
