'use strict';
// Provider-independent JSON-RPC stdio client. Real process; no registry/handler mocks.
const { spawn } = require('node:child_process');
const readline = require('node:readline');
class McpClient {
  constructor(command, args, options) {
    this.pending = new Map(); this.nextId = 1; this.stderr = ''; this.failure = null;
    this.child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', chunk => { this.stderr += chunk; });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      try {
        const response = JSON.parse(line);
        if (response.jsonrpc !== '2.0') throw new Error('Invalid JSON-RPC envelope');
        const waiter = this.pending.get(response.id);
        if (!waiter) throw new Error(`Unsolicited response: ${line}`);
        clearTimeout(waiter.timer); this.pending.delete(response.id); waiter.resolve(response);
      } catch (error) { this.fail(error); }
    });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', code => this.fail(new Error(`MCP exited ${code}: ${this.stderr}`)));
  }
  fail(error) { this.failure = error; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
  request(method, params) {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP timeout: ${method}: ${this.stderr}`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
    });
  }
  notify(method) { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); }
  async call(name, args = {}) {
    const response = await this.request('tools/call', { name, arguments: args });
    if (response.error) throw new Error(JSON.stringify(response.error));
    const content = response.result?.content;
    if (!Array.isArray(content) || content[0]?.type !== 'text' || typeof content[0].text !== 'string') throw new Error('Invalid tools/call content');
    return JSON.parse(content[0].text);
  }
  async close() {
    if (this.child.exitCode !== null || this.child.signalCode) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); }); this.child.stdin.end();
    });
    this.lines.close();
  }
}
module.exports = { McpClient };
