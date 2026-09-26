'use strict';

// hh_quick_answer is a host-only action (trained-assist-agent#1470 P1.3): core
// spawns this server with MCP_HOST_ACTION=1 for user-typed quick commands.
// The model must never see or reach it — send_confirm/reject_confirm execute
// outbound HH effects that only a user-typed /hh_*_yes may trigger.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const INDEX = path.resolve(__dirname, '../../src/mcp-skills/index.js');

function callOnce(env, method, params) {
  return new Promise((resolve, reject) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-quick-'));
    const child = spawn(process.execPath, [INDEX], { cwd, env: { ...process.env, WORK_DIR: cwd, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const line = out.split('\n').find((l) => l.trim());
      if (line) { child.kill(); resolve(JSON.parse(line)); }
    });
    child.on('error', reject);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n');
  });
}

test('hh_quick_answer is absent from the model tool catalog and manifests', async () => {
  const res = await callOnce({ MCP_HOST_ACTION: '1' }, 'tools/list', {});
  assert.ok(!res.result.tools.some((t) => t.name === 'hh_quick_answer'));
  for (const f of ['mcp.manifest.json', 'provider-manifest.json', 'action-provider-manifest.json']) {
    const text = fs.readFileSync(path.resolve(__dirname, '../..', f), 'utf8');
    assert.ok(!text.includes('hh_quick_answer'), `${f} must not list the host-only action`);
  }
});

test('model-side call (no MCP_HOST_ACTION) is refused as unknown tool', async () => {
  const res = await callOnce({ MCP_HOST_ACTION: '' }, 'tools/call', { name: 'hh_quick_answer', arguments: { intent: 'send_confirm' } });
  assert.ok(res.error, 'must be an error');
  assert.match(res.error.message, /Unknown tool: hh_quick_answer/);
});

test('host call answers deterministically without HH network', async () => {
  const res = await callOnce({ MCP_HOST_ACTION: '1' }, 'tools/call', { name: 'hh_quick_answer', arguments: { intent: 'send_confirm' } });
  assert.equal(res.result.content[0].text, '⚠️ Нет отложенной отправки. Сначала /hh_send.');
  const ats = await callOnce({ MCP_HOST_ACTION: '1', AGENT_SECRET: '' }, 'tools/call', { name: 'hh_quick_answer', arguments: { intent: 'ats_editor' } });
  assert.match(ats.result.content[0].text, /\/hh\/ats-editor\?username=fixture/);
  const review = await callOnce({ MCP_HOST_ACTION: '1' }, 'tools/call', { name: 'hh_quick_answer', arguments: { intent: 'review_page' } });
  assert.equal(review.result.content[0].text, '', 'no active vacancy → empty = fall through');
  const bad = await callOnce({ MCP_HOST_ACTION: '1' }, 'tools/call', { name: 'hh_quick_answer', arguments: { intent: 'nope' } });
  assert.match(bad.error.message, /Unknown intent/);
});
