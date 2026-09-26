'use strict';

// L2 behavior contract: launch the real MCP skills server as a subprocess and
// speak JSON-RPC 2.0 over stdio. Tests never call handlers in-process — the
// server, registry and transport run for real; only the LLM and the external
// network (HH) are faked, and never the registry/service under test.

const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');

const MCP_ENTRY = path.resolve(__dirname, '../../src/mcp-skills/index.js');

async function startMcp({ entrypoint = MCP_ENTRY, args = [], userId = 'test-mcp-user', workDir = process.cwd(), env = {}, callTimeoutMs = 20000 } = {}) {
  const proc = spawn(process.execPath, [entrypoint, ...args], {
    cwd: workDir,
    env: { ...process.env, USER_ID: userId, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const rl = readline.createInterface({ input: proc.stdout, terminal: false });
  let seq = 0;
  let stderr = '';
  let exited = null;
  const pending = new Map();

  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  proc.on('exit', (code, signal) => {
    exited = { code, signal };
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(`MCP server exited (code=${code}, signal=${signal}) before answering`));
    }
    pending.clear();
  });

  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id == null || !pending.has(msg.id)) return;
    const { resolve, reject, timer } = pending.get(msg.id);
    clearTimeout(timer);
    pending.delete(msg.id);
    if (msg.error) reject(Object.assign(new Error(msg.error.message), { rpc: msg.error }));
    else resolve(msg.result);
  });

  function call(method, params = {}) {
    if (exited) return Promise.reject(new Error('MCP server already exited'));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP call timed out: ${method}`));
      }, callTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'hh-contract-test', version: '1.0' },
  });

  return {
    call,
    stop: () => new Promise((resolve) => {
      if (exited) return resolve();
      proc.on('close', resolve);
      proc.kill();
    }),
    get stderr() { return stderr; },
    get exited() { return exited; },
  };
}

module.exports = { startMcp, MCP_ENTRY };
