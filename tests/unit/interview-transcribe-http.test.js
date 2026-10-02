// #88 — поведение hh_interview_transcribe / hh_interview_structure на живых
// границах: скачивание источника (Google Drive с confirm-токеном / прямой URL)
// и Deepgram мокаются nock (один из двух разрешённых рубежей, образец —
// tests/support/llm-provider-fixture.cjs). Регистратор и хэндлеры настоящие.
// Здесь же: ключ из env/credential-файла, идемпотентность по sha256 источника,
// force, отказ от локальных файлов и честное speakers_detected.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import nock from 'nock';

const require = createRequire(import.meta.url);
const interview = require('../../src/mcp-skills/tools/98b-interview.js');

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'interviews');

const DRIVE = 'https://drive.google.com';
const DRIVE_FILE = 'https://drive.usercontent.google.com';
const DEEPGRAM = 'https://api.deepgram.com';
const KEY = 'fixture-deepgram-key';
const USER = 'u1';
const SEPARATOR = '='.repeat(60);

const transcribe = (args) => interview.tools.hh_interview_transcribe.handler(args, { userId: USER });
const structure = (args) => interview.tools.hh_interview_structure.handler(args, { userId: USER });

const ENV_KEYS = ['DEEPGRAM_API_KEY', 'AGENT_DATA_DIR', 'AGENT_TOKENS_DIR', 'USER_ID'];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let dataDir;
let tokensDir;

const VIDEO = Buffer.from('mp4-bytes-here');
const DEEPGRAM_ANSWER = {
  metadata: { duration: 61 },
  results: {
    utterances: [
      { speaker: 0, start: 0, transcript: 'Здравствуйте! Расскажите о себе?' },
      { speaker: 1, start: 5, transcript: 'Пять лет на Node.js.' },
    ],
  },
};
const HTML_CONFIRM = [
  '<html><body><form id="download-form" action="https://drive.usercontent.google.com/download" method="get">',
  '<input type="hidden" name="id" value="abc123">',
  '<input type="hidden" name="export" value="download">',
  '<input type="hidden" name="confirm" value="t">',
  '<input type="hidden" name="uuid" value="u-1">',
  '</form></body></html>',
].join('\n');

const today = (now = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(now.getDate())}.${p(now.getMonth() + 1)}.${now.getFullYear()}`;
};
const interviewsDir = () => join(dataDir, 'hh', USER, 'interviews');
const read = (file) => readFileSync(file, 'utf8');

function mockDrive() {
  nock(DRIVE).get('/uc').query({ export: 'download', id: 'abc123' })
    .reply(200, HTML_CONFIRM, { 'content-type': 'text/html' });
  nock(DRIVE_FILE).get('/download').query(true).reply(200, VIDEO, {
    'content-type': 'application/octet-stream',
    'content-disposition': 'attachment; filename="client-interview.mp4"',
  });
}

function mockDeepgram({ contentType = 'video/mp4', answer = DEEPGRAM_ANSWER } = {}) {
  const bodies = [];
  nock(DEEPGRAM, { reqheaders: { authorization: `Token ${KEY}`, 'content-type': contentType } })
    .post('/v1/listen').query(true)
    .reply(200, (_uri, body) => { bodies.push(String(body)); return answer; });
  return bodies;
}

beforeAll(() => { nock.disableNetConnect(); nock.enableNetConnect('127.0.0.1'); });

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'hh-interview-data-'));
  tokensDir = mkdtempSync(join(tmpdir(), 'hh-interview-tokens-'));
  process.env.AGENT_DATA_DIR = dataDir;
  process.env.AGENT_TOKENS_DIR = tokensDir;
  process.env.DEEPGRAM_API_KEY = KEY;
  process.env.USER_ID = USER; // #89 читает structure.json через env — тот же юзер
  nock.cleanAll();
});

afterEach(() => { nock.cleanAll(); });

afterAll(() => {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(tokensDir, { recursive: true, force: true });
});

const DRIVE_ARGS = { source_url: 'https://drive.google.com/file/d/abc123/view', candidate_name: 'Иван Иванов', slug: 'ivanov' };

describe('hh_interview_transcribe — source → Deepgram → guide-format transcript', () => {
  it('walks the Google Drive confirm-token flow and renders the transcript', async () => {
    mockDrive();
    const bodies = mockDeepgram();

    const res = await transcribe(DRIVE_ARGS);

    expect(res.cached).toBe(false);
    expect(res.slug).toBe('ivanov');
    expect(res.speakers_detected).toBe(true);
    expect(res.turns).toBe(2);
    expect(res.content_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(res.source_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(res.duration_min).toBe(1);
    expect(bodies).toEqual(['mp4-bytes-here']); // файл ушёл в Deepgram целиком, без распилки

    expect(read(res.transcript_path)).toBe([
      'Интервью: Владимир (рекрутер) — Иван Иванов',
      `Дата: ${today()}`,
      'Длительность: 1.0 мин',
      SEPARATOR,
      '',
      '[0:00] Владимир (рекрутер): Здравствуйте! Расскажите о себе?',
      '',
      '[0:05] Иван Иванов: Пять лет на Node.js.',
      '',
    ].join('\n'));
    expect(existsSync(res.deepgram_path)).toBe(true);
    expect(JSON.parse(read(res.deepgram_path)).results.utterances).toHaveLength(2);
    expect(JSON.parse(read(join(interviewsDir(), 'ivanov', 'meta.json'))).source).toBe(DRIVE_ARGS.source_url);
  });

  it('repeats are served from the sha256 cache without any network call', async () => {
    mockDrive();
    mockDeepgram();
    const first = await transcribe(DRIVE_ARGS);
    expect(first.cached).toBe(false);

    nock.cleanAll(); // сеть отключена guard'ом: любой запрос упадёт
    const second = await transcribe(DRIVE_ARGS);

    expect(second.cached).toBe(true);
    expect(second.transcript_path).toBe(first.transcript_path);
    expect(second.source_sha256).toBe(first.source_sha256);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('force ignores the cache and transcribes again', async () => {
    mockDrive();
    mockDeepgram();
    await transcribe(DRIVE_ARGS);
    mockDrive();
    mockDeepgram();

    const forced = await transcribe({ ...DRIVE_ARGS, force: true });

    expect(forced.cached).toBe(false);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('a direct URL keeps its own content type (m4a → audio/mp4)', async () => {
    nock('https://media.example.test').get('/call.m4a').reply(200, VIDEO, { 'content-type': 'application/octet-stream' });
    const bodies = mockDeepgram({ contentType: 'audio/mp4' });

    const res = await transcribe({ source_url: 'https://media.example.test/call.m4a', candidate_name: 'Пётр', slug: 'pyotr' });

    expect(res.cached).toBe(false);
    expect(bodies).toEqual(['mp4-bytes-here']);
  });

  it('reads the key from the credential file when DEEPGRAM_API_KEY is absent', async () => {
    delete process.env.DEEPGRAM_API_KEY;
    mkdirSync(join(tokensDir, USER), { recursive: true });
    writeFileSync(join(tokensDir, USER, 'deepgram'), `${KEY}\n`, 'utf-8');
    mockDrive();
    mockDeepgram();

    const res = await transcribe(DRIVE_ARGS);

    expect(res.cached).toBe(false);
    expect(res.speakers_detected).toBe(true);
  });

  it('fails with a clear message and no network call when the key is missing', async () => {
    delete process.env.DEEPGRAM_API_KEY;
    mockDrive();
    mockDeepgram();

    await expect(transcribe(DRIVE_ARGS)).rejects.toThrow(/DEEPGRAM_API_KEY/);
    expect(nock.pendingMocks()).toHaveLength(3); // ни скачивания (2), ни Deepgram не было
  });

  it('refuses local files, folder links, both sources and an empty call', async () => {
    await expect(transcribe({ source_url: '/tmp/interview.mp4' })).rejects.toThrow(/локальные файлы/);
    await expect(transcribe({ source_url: 'file:///tmp/interview.mp4' })).rejects.toThrow(/локальные файлы/);
    await expect(transcribe({ source_url: 'https://drive.google.com/drive/folders/xyz' })).rejects.toThrow(/ссылка на папку/);
    await expect(transcribe({ source_url: 'https://x.test/a.mp4', text: 'текст' })).rejects.toThrow(/РОВНО один источник/);
    await expect(transcribe({})).rejects.toThrow(/Нет источника/);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('the text path needs no key and no network', async () => {
    delete process.env.DEEPGRAM_API_KEY;
    const text = [
      'Интервью: Владимир (рекрутер) — Иван Иванов',
      'Дата: 01.10.2026',
      'Длительность: 1.0 мин',
      SEPARATOR,
      '',
      '[0:00] Владимир (рекрутер): Здравствуйте! Чем занимаетесь?',
      '',
      '[0:10] Иван Иванов: Пять лет на Node.js.',
      '',
    ].join('\n');

    const res = await transcribe({ text, candidate_name: 'Иван Иванов', slug: 'text-only' });

    expect(res.cached).toBe(false);
    expect(res.speakers_detected).toBe(true);
    expect(res.deepgram_path).toBeNull();
    expect(read(res.transcript_path)).toBe(text); // подпись уже есть — текст не переписываем
    expect(nock.pendingMocks()).toEqual([]);
  });
});

describe('hh_interview_structure — Q&A-ходы без LLM', () => {
  it('builds turns from the raw Deepgram answer and caches itself', async () => {
    mockDrive();
    mockDeepgram();
    await transcribe(DRIVE_ARGS);

    const res = await structure({ slug: 'ivanov' });

    expect(res.cached).toBe(false);
    expect(res.speakers_detected).toBe(true);
    expect(res.turns_count).toBe(2);
    expect(res.source_path).toBe(join(interviewsDir(), 'ivanov', 'deepgram.json'));
    expect(res.turns).toEqual([
      { speaker: 'Владимир (рекрутер)', role: 'recruiter', text: 'Здравствуйте! Расскажите о себе?', t: 0 },
      { speaker: 'Иван Иванов', role: 'candidate', text: 'Пять лет на Node.js.', t: 5 },
    ]);
    expect(existsSync(res.structure_path)).toBe(true);
    // Контракт с #89 (смержен в main): hh_interview_evaluate читает structure.json
    // из той же папки — оба имени обязаны существовать и совпадать байт в байт.
    expect(existsSync(res.portrait_structure_path)).toBe(true);
    expect(read(res.portrait_structure_path)).toBe(read(res.structure_path));

    const again = await structure({ slug: 'ivanov' });
    expect(again.cached).toBe(true);
    expect(again.turns).toEqual(res.turns);
  });

  it('reads a ready transcript file — no re-transcription needed', async () => {
    const slug = 'ready';
    const dir = join(interviewsDir(), slug);
    mkdirSync(dir, { recursive: true });
    // Транскрипт клиента без единого таймкода (Zoom) — structure обязан разобрать его как есть.
    writeFileSync(join(dir, `${slug}-transcript.txt`),
      readFileSync(join(FIXTURES, 'zoom-2026-09-18-interview-dmitry-transcript.txt'), 'utf-8'), 'utf-8');

    const res = await structure({ slug });

    expect(res.cached).toBe(false);
    expect(res.speakers_detected).toBe(true);
    expect(res.source_path).toBe(join(dir, `${slug}-transcript.txt`));
    expect(res.turns.find((t) => t.role === 'recruiter').speaker).toBe('Владимир');
    expect(res.turns.find((t) => t.role === 'candidate').speaker).toBe('Дмитрий');
    expect(res.turns.every((t) => t.t === null)).toBe(true);
  });

  it('reports honestly when speakers are not separated', async () => {
    const slug = 'mono';
    const dir = join(interviewsDir(), slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${slug}-transcript.txt`), [
      'Интервью: Кандидат', 'Дата: 01.10.2026', SEPARATOR, '',
      '[0:00] Спикер 0: Просто монолог.', '[0:30] Спикер 0: Продолжение.', '',
    ].join('\n'), 'utf-8');

    const res = await structure({ slug });

    expect(res.speakers_detected).toBe(false);
    expect(res.turns).toHaveLength(1); // соседние реплики одного спикера склеились
    expect(res.turns[0].role).toBeNull();
    expect(res.hint).toMatch(/роли не подписаны/);
  });

  it('refuses a slug that was never transcribed', async () => {
    await expect(structure({ slug: 'missing' })).rejects.toThrow(/hh_interview_transcribe/);
    await expect(structure({})).rejects.toThrow(/Укажи slug/);
  });
});

describe('hh_interview_transcribe — загруженный файл кандидата (#87 → #88)', () => {
  const candDocs = require('../../src/hh-candidate-docs.js');

  async function upload(ext, buf, type) {
    const out = await candDocs.addDocument({
      username: USER, candidateId: 'c-av', candidateName: 'Татьяна Потапова',
      filename: `audio1519171140${ext}`, buffer: buf, manualType: type,
    });
    return out.doc;
  }

  it('расшифровывает аудио, уже загруженное в /hh/candidate-new — без URL', async () => {
    const doc = await upload('.m4a', Buffer.from('m4a-bytes'), 'interview');
    expect(doc.media_kind).toBe('media');
    expect(doc.extract_error).toBeUndefined();

    const bodies = mockDeepgram({ contentType: 'audio/mp4' });
    const res = await transcribe({ candidate_id: 'c-av', doc_id: doc.id, slug: 'c-av' });

    expect(res.slug).toBe('c-av');
    expect(res.speakers_detected).toBe(true);
    expect(res.turns).toBe(2);
    expect(bodies).toEqual(['m4a-bytes']); // байты файла ушли в Deepgram как есть
    const meta = JSON.parse(read(join(interviewsDir(), 'c-av', 'meta.json')));
    expect(meta.kind).toBe('deepgram');
    expect(meta.source).toBe(`uploaded:c-av/${doc.id}`);
    expect(meta.candidate).toBe('Татьяна Потапова');
  });

  it('повтор по тому же файлу — кэш без сети', async () => {
    const doc = await upload('.m4a', Buffer.from('m4a-bytes'), 'interview');
    mockDeepgram({ contentType: 'audio/mp4' });
    await transcribe({ candidate_id: 'c-av', doc_id: doc.id, slug: 'c-av' });
    nock.cleanAll(); // никаких моков → провал = сеть, кэш обязан вернуться
    const res = await transcribe({ candidate_id: 'c-av', doc_id: doc.id, slug: 'c-av' });
    expect(res.cached).toBe(true);
  });

  it('отказывает для не-медиа файла и при неполном наборе id', async () => {
    const doc = await upload('.txt', Buffer.from('просто текст'), 'interview');
    await expect(transcribe({ candidate_id: 'c-av', doc_id: doc.id })).rejects.toThrow(/не аудио\/видео/);
    await expect(transcribe({ candidate_id: 'c-av' })).rejects.toThrow(/candidate_id, и doc_id/);
    await expect(transcribe({ doc_id: 'x' })).rejects.toThrow(/candidate_id, и doc_id/);
  });
});

describe('hh_interview_transcribe — документ из GCS (#105)', () => {
  const candDocs = require('../../src/hh-candidate-docs.js');
  const http = require('node:http');

  it('gcs-документ: байты приходят через /internal/blob/download, локального файла нет', async () => {
    // 1) документ со storage=gcs (без локальных байтов)
    const doc = await candDocs.addDocument({
      username: USER, candidateId: 'c-gcs', candidateName: 'Татьяна Потапова',
      filename: 'rec.m4a', buffer: Buffer.from('placeholder'), manualType: 'interview',
      externalStore: async (info) => ({ backend: 'gcs', key: 'k', doc_id: info.docId, ext: info.ext }),
    });
    expect(doc.doc.storage.backend).toBe('gcs');

    // 2) фейк ядра отдаёт настоящие байты
    const core = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.from('m4a-from-gcs'));
    });
    await new Promise(r => core.listen(0, '127.0.0.1', r));
    const saved = { url: process.env.AGENT_INTERNAL_URL, secret: process.env.AGENT_SECRET };
    process.env.AGENT_INTERNAL_URL = `http://127.0.0.1:${core.address().port}`;
    process.env.AGENT_SECRET = 'sec';

    const bodies = mockDeepgram({ contentType: 'audio/mp4' });
    try {
      const res = await transcribe({ candidate_id: 'c-gcs', doc_id: doc.doc.id, slug: 'c-gcs' });
      expect(res.slug).toBe('c-gcs');
      expect(bodies).toEqual(['m4a-from-gcs']); // именно байты из GCS ушли в Deepgram
      const meta = JSON.parse(read(join(interviewsDir(), 'c-gcs', 'meta.json')));
      expect(meta.source).toBe(`uploaded:c-gcs/${doc.doc.id}`);
    } finally {
      await new Promise(r => core.close(r));
      if (saved.url === undefined) delete process.env.AGENT_INTERNAL_URL; else process.env.AGENT_INTERNAL_URL = saved.url;
      if (saved.secret === undefined) delete process.env.AGENT_SECRET; else process.env.AGENT_SECRET = saved.secret;
    }
  });
});
