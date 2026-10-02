// src/hh-blob-client.js — вызов core /internal/blob/* (loopback-сервер-фейк ядра).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { uploadDocBytes, downloadDocBytes, coreBase } = require('../../src/hh-blob-client.js');

let server;
let baseUrl;
let uploads = []; // {key, body, contentType, auth}
const objects = new Map(); // key -> Buffer

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (u.pathname === '/internal/blob/upload') {
        const key = `profiles/${u.searchParams.get('username')}/candidate-docs/${u.searchParams.get('candidate_id')}/${u.searchParams.get('doc_id')}${u.searchParams.get('ext')}`;
        uploads.push({ key, body, contentType: req.headers['content-type'], auth: req.headers.authorization });
        if (u.searchParams.get('username') === 'fail-user') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'gcs down' }));
          return;
        }
        objects.set(key, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, key, sha256: 'a'.repeat(64), size: body.length, generation: '1' }));
        return;
      }
      if (u.pathname === '/internal/blob/download') {
        const key = `profiles/${u.searchParams.get('username')}/candidate-docs/${u.searchParams.get('candidate_id')}/${u.searchParams.get('doc_id')}${u.searchParams.get('ext')}`;
        const buf = objects.get(key);
        if (!buf) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `файл не найден: ${key}` }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(buf);
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise(r => server.close(r));
});

let env;
beforeEach(() => {
  uploads = [];
  objects.clear();
  env = { AGENT_INTERNAL_URL: baseUrl, AGENT_SECRET: 'sec' };
});

const DOC = { username: 'alice', candidateId: 'anna-1', docId: 'd1', ext: '.m4a' };

describe('coreBase', () => {
  it('prefers AGENT_INTERNAL_URL, then PORT, then PUBLIC', () => {
    expect(coreBase({ AGENT_INTERNAL_URL: 'http://a:1/' })).toBe('http://a:1');
    expect(coreBase({ PORT: 3001 })).toBe('http://127.0.0.1:3001');
    expect(coreBase({ AGENT_PUBLIC_URL: 'https://x.example' })).toBe('https://x.example');
    expect(coreBase({})).toBe('');
  });
});

describe('uploadDocBytes', () => {
  it('sends raw bytes with auth and content-type, returns core payload', async () => {
    const payload = Buffer.from([0, 1, 2, 250]);
    const out = await uploadDocBytes({ ...DOC, buffer: payload, contentType: 'audio/mp4' }, { env });
    expect(out.ok).toBe(true);
    expect(out.size).toBe(4);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].key).toBe('profiles/alice/candidate-docs/anna-1/d1.m4a');
    expect(uploads[0].auth).toBe('Bearer sec');
    expect(uploads[0].contentType).toBe('audio/mp4');
    expect(uploads[0].body.equals(payload)).toBe(true);
  });

  it('surfaces core errors as {error}', async () => {
    const out = await uploadDocBytes({ ...DOC, username: 'fail-user', buffer: Buffer.from('x') }, { env });
    expect(out.error).toContain('gcs down');
  });

  it('refuses without core address/secret', async () => {
    const out = await uploadDocBytes({ ...DOC, buffer: Buffer.from('x') }, { env: {} });
    expect(out.error).toMatch(/недоступна/);
  });

  it('refuses empty buffer', async () => {
    const out = await uploadDocBytes({ ...DOC, buffer: Buffer.alloc(0) }, { env });
    expect(out.error).toMatch(/пустой/);
  });
});

describe('downloadDocBytes', () => {
  it('roundtrips bytes upload → download', async () => {
    const payload = Buffer.from('тяжёлые байты интервью');
    await uploadDocBytes({ ...DOC, buffer: payload, contentType: 'video/mp4' }, { env });
    const back = await downloadDocBytes(DOC, { env });
    expect(back.equals(payload)).toBe(true);
  });

  it('missing object → error with code BLOB_NOT_FOUND', async () => {
    await expect(downloadDocBytes({ ...DOC, docId: 'nope' }, { env })).rejects.toMatchObject({ code: 'BLOB_NOT_FOUND' });
  });

  it('unreachable core → clear error', async () => {
    await expect(downloadDocBytes(DOC, { env: { AGENT_INTERNAL_URL: 'http://127.0.0.1:1', AGENT_SECRET: 's' } })).rejects.toThrow(/blob download failed/);
  });
});
