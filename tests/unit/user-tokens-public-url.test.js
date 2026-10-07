import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const keys = ['AGENT_PUBLIC_URL', 'AGENT_TOKENS_DIR', 'AGENT_TOKENS_ROOT', 'AGENT_DATA_DIR', 'USERS_DIR'];
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'user-tokens-public-url-'));

beforeEach(() => {
  for (const key of keys) delete process.env[key];
  process.env.AGENT_TOKENS_DIR = path.join(root, 'tokens');
  process.env.AGENT_TOKENS_ROOT = path.join(root, 'tokens');
  process.env.AGENT_DATA_DIR = root;
  process.env.USERS_DIR = root;
});

afterEach(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('credential links require an explicit public callback origin', () => {
  it('does not write a pending legacy token when the public URL is missing', async () => {
    const tokens = require('../../src/user-tokens.js');
    await expect(tokens.generateConnectLink('alice', 'hh')).rejects.toThrow('AGENT_PUBLIC_URL is required');
    const pending = path.join(process.env.AGENT_TOKENS_DIR, 'connect-pending');
    expect(fs.existsSync(pending) ? fs.readdirSync(pending) : []).toEqual([]);
  });

  it('uses the explicitly configured URL for legacy connect links', async () => {
    process.env.AGENT_PUBLIC_URL = 'https://recruiting.example.test/';
    delete require.cache[require.resolve('../../src/user-tokens.js')];
    const tokens = require('../../src/user-tokens.js');
    const link = await tokens.generateConnectLink('alice', 'hh');
    expect(link).toMatch(/^https:\/\/recruiting\.example\.test\/connect\/hh\?t=[a-f0-9]{32}$/);
  });
});
