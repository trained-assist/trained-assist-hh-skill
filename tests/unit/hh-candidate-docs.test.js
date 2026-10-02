// src/hh-candidate-docs.js — манифест документов кандидата (#87).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const docs = require('../../src/hh-candidate-docs.js');

let dataDir;
let savedEnv;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'hh-cand-docs-'));
  savedEnv = process.env.AGENT_DATA_DIR;
  process.env.AGENT_DATA_DIR = dataDir;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.AGENT_DATA_DIR;
  else process.env.AGENT_DATA_DIR = savedEnv;
  rmSync(dataDir, { recursive: true, force: true });
});

const RESUME = Buffer.from('Опыт работы\n2023 – 2025 ООО «Пример», маркетолог\nНавыки: Excel', 'utf8');
const LETTER = Buffer.from('Добрый день! Пишу по поводу вакансии.\nС уважением, Анна', 'utf8');

describe('addDocument', () => {
  it('creates a candidate, stores file + text, classifies by rules', async () => {
    const out = await docs.addDocument({ username: 'u1', candidateName: 'Стогниенко Анна', filename: 'cv.txt', buffer: RESUME });
    expect(out.candidate_id).toMatch(/^stognienko-anna-/); // транслит, SAFE_ID-safe
    const m = docs.readManifest('u1', out.candidate_id);
    expect(m.docs).toHaveLength(1);
    expect(out.doc.type).toBe('resume');
    expect(out.doc.detected_by).toBe('rules');
    expect(out.doc.chars).toBeGreaterThan(0);
    expect(out.doc.sha256).toHaveLength(64);

    const root = docs.candRoot('u1', out.candidate_id);
    expect(existsSync(join(root, `${out.doc.id}.txt`))).toBe(true);
    expect(existsSync(join(root, `${out.doc.id}.txt`))).toBe(true);
  });

  it('manual type at upload wins over rules', async () => {
    const out = await docs.addDocument({ username: 'u1', candidateId: 'c-1', filename: 'cv.txt', buffer: RESUME, manualType: 'cover_letter' });
    expect(out.doc.type).toBe('cover_letter');
    expect(out.doc.detected_by).toBe('manual');
  });

  it('stores a source link as a document without bytes', async () => {
    const out = await docs.addDocument({ username: 'u1', candidateId: 'c-1', filename: 'https://drive.google.com/file/d/x/view', buffer: Buffer.alloc(0), sourceUrl: 'https://drive.google.com/file/d/x/view', manualType: 'interview' });
    expect(out.doc.source_url).toContain('drive.google.com');
    expect(out.doc.type).toBe('interview');
    expect(existsSync(join(docs.candRoot('u1', 'c-1'), `${out.doc.id}.txt`))).toBe(false);
  });

  it('binary without text gets an extract_error but still lands in the manifest', async () => {
    const out = await docs.addDocument({ username: 'u1', candidateId: 'c-1', filename: 'weird.bin', buffer: Buffer.from([0, 1, 2]) });
    expect(out.doc.extract_error || out.doc.type).toBeTruthy();
    expect(docs.readManifest('u1', 'c-1').docs).toHaveLength(1);
  });
});

describe('setDocType', () => {
  it('overrides type with detected_by=manual', async () => {
    const { candidate_id, doc } = await docs.addDocument({ username: 'u1', candidateName: 'Анна', filename: 'l.txt', buffer: LETTER });
    expect(doc.type).toBe('cover_letter');
    const out = docs.setDocType({ username: 'u1', candidateId: candidate_id, docId: doc.id, type: 'correspondence' });
    expect(out.ok).toBe(true);
    const m = docs.readManifest('u1', candidate_id);
    expect(m.docs[0].type).toBe('correspondence');
    expect(m.docs[0].detected_by).toBe('manual');
  });

  it('reports unknown candidate/doc', () => {
    expect(docs.setDocType({ username: 'u1', candidateId: 'nope', docId: 'x', type: 'resume' }).error).toBeTruthy();
  });
});

describe('combinedText', () => {
  it('joins text docs by type and skips binary/photo', async () => {
    const { candidate_id } = await docs.addDocument({ username: 'u1', candidateName: 'Анна', filename: 'cv.txt', buffer: RESUME });
    await docs.addDocument({ username: 'u1', candidateId: candidate_id, filename: 'l.txt', buffer: LETTER });
    await docs.addDocument({ username: 'u1', candidateId: candidate_id, filename: 'photo.png', buffer: Buffer.from([0x89, 0x50]) });
    const text = docs.combinedText('u1', candidate_id);
    expect(text).toContain('Опыт работы');
    expect(text).toContain('Добрый день');
    expect(text).not.toContain('photo.png');
    const noCorr = docs.combinedText('u1', candidate_id, { types: ['resume'] });
    expect(noCorr).toContain('Опыт работы');
    expect(noCorr).not.toContain('Добрый день');
  });
});

describe('manifest file shape', () => {
  it('is the {value-free} JSON with candidate_id and docs array', async () => {
    const { candidate_id } = await docs.addDocument({ username: 'u1', candidateName: 'X', filename: 'a.txt', buffer: LETTER });
    const raw = JSON.parse(readFileSync(docs.manifestPath('u1', candidate_id), 'utf8'));
    expect(raw.candidate_id).toBe(candidate_id);
    expect(Array.isArray(raw.docs)).toBe(true);
    expect(raw.profile).toBeNull();
  });
});

describe('медиа-файлы и ручной текст (#87 фиксы из живого прогона)', () => {
  it('аудио/видео и картинки не получают extract_error — вместо него media_kind', async () => {
    const a = await docs.addDocument({ username: 'u1', candidateId: 'c-m', filename: 'audio1519171140.m4a', buffer: Buffer.from([0, 1]), manualType: 'interview' });
    expect(a.doc.type).toBe('interview');
    expect(a.doc.media_kind).toBe('media');
    expect(a.doc.extract_error).toBeUndefined();

    const j = await docs.addDocument({ username: 'u1', candidateId: 'c-m', filename: 'photo_2026-10-02.jpeg', buffer: Buffer.from([0xff, 0xd8]), manualType: 'photo' });
    expect(j.doc.media_kind).toBe('image');
    expect(j.doc.extract_error).toBeUndefined();
    expect(j.doc.type).toBe('photo');
  });

  it('extractProfile при нулевом тексте объясняет по каждому файлу и что делать', async () => {
    await docs.addDocument({ username: 'u1', candidateId: 'c-nt', candidateName: 'Татьяна', filename: 'resume.jpeg', buffer: Buffer.from([0xff, 0xd8]), manualType: 'resume' });
    await docs.addDocument({ username: 'u1', candidateId: 'c-nt', filename: 'audio.m4a', buffer: Buffer.from([0, 1]), manualType: 'interview' });
    const out = await docs.extractProfile({ username: 'u1', candidateId: 'c-nt' });
    expect(out.error).toContain('resume.jpeg');
    expect(out.error).toContain('Вставить текстом');
    expect(out.error).toContain('audio.m4a');
    expect(out.error).toContain('Расшифровать');
  });

  it('ручной текст — обычный документ с типом', async () => {
    const out = await docs.addDocument({
      username: 'u1', candidateId: 'c-t', filename: 'вставлено-вручную.txt',
      buffer: Buffer.from('Опыт работы\n2020 – 2024 ООО Х', 'utf8'), manualType: 'resume',
    });
    expect(out.doc.type).toBe('resume');
    expect(out.doc.chars).toBeGreaterThan(0);
    expect(docs.combinedText('u1', 'c-t')).toContain('2020 – 2024');
  });
});
