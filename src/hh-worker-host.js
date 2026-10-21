'use strict';

// Host services of the standalone HH worker (#187).
//
// The HH routes (src/hh-routes.js) were written for the retiring agent's server:
// it owned the HTTP listener, the secret cache, the profile notification and the
// MCP call-out, and mounted the skill's route table. The retiring agent is not
// coming back to the RU host, so the worker provides the same contract itself —
// nothing more, nothing less:
//
//   secrets / getSecretsCache  — the platform keys the skill reads at call time;
//   BASE_USERS_DIR / PORT     — where the profile state lives and where the
//                                worker listens;
//   readChatId / notifyProfile — the per-profile notification;
//   runMcpTool                — the skill's own MCP tools;
//   the negotiation helpers   — from createHhNegotiations (the skill owns them).
//
// The MCP call-out runs the skill's registry in-process. The registry reads the
// profile from USER_ID, so calls are serialized through one queue: two parallel
// tool calls would otherwise answer for the wrong profile.

const fs = require('fs');
const path = require('path');
const { tokensRoot, usersRoot, dataRoot } = require('./data-paths');
const { createHhNegotiations } = require('./hh-negotiations');
const { refreshHhToken } = require('./hh-utils');
const { toolResultText } = require('./mcp-skills/tool-result');

function readSecretFile(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function createHost({ env = process.env, fetchImpl = fetch, now = () => new Date() } = {}) {
  const secrets = {
    HH_CLIENT_ID: env.HH_CLIENT_ID || '',
    HH_CLIENT_SECRET: env.HH_CLIENT_SECRET || '',
    AGENT_SECRET: env.AGENT_SECRET || '',
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN || env.BOT_TOKEN || '',
    OPENROUTER_API_KEY: env.OPENROUTER_API_KEY || '',
  };

  const getSecretsCache = () => secrets;

  const readChatId = (username) => {
    try {
      return fs.readFileSync(path.join(tokensRoot(), String(username), '.chatid'), 'utf8').trim() || null;
    } catch {
      return null;
    }
  };

  // Telegram delivery of the worker's own pushes. It never throws into the
  // request path: a failed push must not turn a recruiter action into an error.
  const notifyProfile = async (username, text, extra = {}) => {
    const chatId = readChatId(username);
    if (!chatId) return { sent: false, reason: 'no_chat_id' };
    const botToken = secrets.TELEGRAM_BOT_TOKEN;
    if (!botToken) return { sent: false, reason: 'no_bot_credentials' };
    const base = (env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/+$/, '');
    try {
      const response = await fetchImpl(`${base}/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: String(text || '').slice(0, 4000),
          disable_web_page_preview: true,
          ...(extra && extra.threadId ? { message_thread_id: extra.threadId } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return { sent: false, reason: `telegram_status_${response.status}` };
      return { sent: true };
    } catch (error) {
      console.warn('[hh-worker] push failed:', error.message);
      return { sent: false, reason: 'push_failed' };
    }
  };

  // The skill's MCP tools, called in-process. Serialized: the registry reads the
  // profile from the environment, so two calls must not overlap.
  let queue = Promise.resolve();
  const runMcpTool = ({ tool, params, username, workDir, timeoutMs = 120_000 }) => {
    const task = async () => {
      const registry = require('./mcp-skills/registry');
      const previousUser = process.env.USER_ID;
      const previousWorkDir = process.env.WORK_DIR;
      process.env.USER_ID = String(username || '');
      process.env.WORK_DIR = String(workDir || path.join(usersRoot(), String(username || '')));
      try {
        const result = await Promise.race([
          Promise.resolve(registry.callTool(tool, params || {})),
          new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`tool timed out after ${timeoutMs}ms`)), timeoutMs).unref?.()),
        ]);
        return toolResultText(tool, result);
      } finally {
        if (previousUser == null) delete process.env.USER_ID; else process.env.USER_ID = previousUser;
        if (previousWorkDir == null) delete process.env.WORK_DIR; else process.env.WORK_DIR = previousWorkDir;
      }
    };
    const run = queue.then(task, task);
    queue = run.then(() => {}, () => {});
    return run;
  };

  let negotiations = {};
  try {
    negotiations = createHhNegotiations({
      refreshHhToken: (...args) => refreshHhToken(...args),
      readChatId,
      getSecretsCache,
    });
  } catch (error) {
    console.error('[hh-worker] переговоры недоступны:', error.message);
  }

  return {
    secrets,
    getSecretsCache,
    readChatId,
    notifyProfile,
    runMcpTool,
    BASE_USERS_DIR: usersRoot(),
    PORT: Number(env.PORT) || 8091,
    getHhNegotiationsWithCache: negotiations.getHhNegotiationsWithCache,
    syncHhMessagesToHistory: negotiations.syncHhMessagesToHistory,
    fetchAllHhNegotiations: negotiations.fetchAllHhNegotiations,
    getHhDiscardedWithCache: negotiations.getHhDiscardedWithCache,
    hhCacheFile: negotiations.hhCacheFile,
    paths: { usersRoot: usersRoot(), tokensRoot: tokensRoot(), dataRoot: dataRoot() },
    now,
  };
}

module.exports = { createHost, readSecretFile };
