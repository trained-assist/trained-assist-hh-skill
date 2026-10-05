import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { handleHhPublic } = require('../src/hh-routes');

it('send-and-reject posts through common chat with the persisted idempotency UUID', async () => {
  const keys = ['AGENT_DATA_DIR', 'AGENT_TOKENS_ROOT', 'AGENT_TOKENS_DIR', 'AGENT_SECRET'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-reject-route-chat-'));
  const originalFetch = globalThis.fetch;
  let chatPosts = 0;
  try {
    process.env.AGENT_DATA_DIR = path.join(root, 'data');
    process.env.AGENT_TOKENS_ROOT = path.join(root, 'tokens');
    process.env.AGENT_TOKENS_DIR = path.join(root, 'tokens');
    process.env.AGENT_SECRET = '';
    const tokenDir = path.join(root, 'tokens', 'alice');
    fs.mkdirSync(tokenDir, { recursive: true });
    fs.writeFileSync(path.join(tokenDir, 'hh'), JSON.stringify({ access_token: 'fixture' }), { mode: 0o600 });
    const historyFile = path.join(root, 'data', 'hh', 'alice', 'candidates', 'n1.json');
    globalThis.fetch = async (url, options = {}) => {
      let data = {};
      if (String(url).includes('/negotiations/n1') && options.method !== 'PUT') data = { id: 'n1', chat_id: 'chat' };
      else if (String(url).includes('/common/chats/chat/messages') && options.method === 'POST') {
        chatPosts++;
        const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
        const payload = JSON.parse(options.body);
        expect(history.rejection_operation.status).toBe('sending');
        expect(payload).toEqual({ text: 'Отказ', idempotency_key: history.rejection_operation.idempotency_key });
        expect(payload.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
        data = { id: 'hh-rejected-message' };
      }
      return { ok: true, status: options.method === 'PUT' ? 204 : 201, json: async () => data };
    };
    const req = Readable.from([Buffer.from(JSON.stringify({ username: 'alice', negotiation_id: 'n1', message: 'Отказ', force: true }))]);
    req.method = 'POST'; req.headers = {};
    let status, raw;
    const res = { setHeader() {}, writeHead(code) { status = code; }, end(body) { raw = String(body); } };
    await handleHhPublic(req, new URL('/hh/send-and-reject', 'http://localhost'), res, { BASE_USERS_DIR: path.join(root, 'users'), getSecretsCache: () => ({}), secrets: {} });
    expect(status).toBe(200);
    expect(JSON.parse(raw)).toEqual({ ok: true });
    expect(chatPosts).toBe(1);
    expect(JSON.parse(fs.readFileSync(historyFile, 'utf8')).rejection_operation).toMatchObject({ status: 'done', provider_message_id: 'hh-rejected-message' });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
