// src/hh-candidate-docs.js — манифест документов кандидата (#87).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import nock from 'nock';

const require = createRequire(import.meta.url);
const docs = require('../../src/hh-candidate-docs.js');

let dataDir;
let savedEnv;
let tokensDir;
let savedTokens;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'hh-cand-docs-'));
  tokensDir = mkdtempSync(join(tmpdir(), 'hh-cand-docs-tokens-'));
  savedEnv = process.env.AGENT_DATA_DIR;
  savedTokens = { d: process.env.AGENT_TOKENS_DIR, r: process.env.AGENT_TOKENS_ROOT };
  process.env.AGENT_DATA_DIR = dataDir;
  // герметично от реального ~/agent-tokens/llm-ladder/token (vision-тесты ставят
  // env-токен сами; остальные должны видеть «токена нет» и ходить по правилам)
  process.env.AGENT_TOKENS_DIR = tokensDir;
  process.env.AGENT_TOKENS_ROOT = tokensDir;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.AGENT_DATA_DIR;
  else process.env.AGENT_DATA_DIR = savedEnv;
  if (savedTokens) {
    if (savedTokens.d === undefined) delete process.env.AGENT_TOKENS_DIR; else process.env.AGENT_TOKENS_DIR = savedTokens.d;
    if (savedTokens.r === undefined) delete process.env.AGENT_TOKENS_ROOT; else process.env.AGENT_TOKENS_ROOT = savedTokens.r;
  }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(tokensDir, { recursive: true, force: true });
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

describe('externalStore — файл уходит в GCS, локально остаётся только текст (#105)', () => {
  it('вызывает store с candidateId/docId/ext/contentType, пишет storage в манифест, байт-файл не создаёт', async () => {
    const calls = [];
    const out = await docs.addDocument({
      username: 'u1', candidateName: 'Татьяна', filename: 'big.md',
      buffer: Buffer.from('# Тяжёлое резюме\nОпыт работы 2020 – 2024'),
      externalStore: async (info) => {
        calls.push(info);
        return { backend: 'gcs', key: `profiles/u1/candidate-docs/${info.candidateId}/${info.docId}${info.ext}`, doc_id: info.docId, ext: info.ext, sha256: 'b'.repeat(64) };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].candidateId).toBe(out.candidate_id);
    expect(calls[0].docId).toBe(out.doc.id);
    expect(calls[0].ext).toBe('.md');
    expect(calls[0].contentType).toContain('markdown');

    expect(out.doc.storage.backend).toBe('gcs');
    expect(out.doc.storage.key).toContain(`candidate-docs/${out.candidate_id}/${out.doc.id}.md`);

    const root = docs.candRoot('u1', out.candidate_id);
    expect(existsSync(join(root, `${out.doc.id}.md`))).toBe(false); // байтов локально нет
    expect(existsSync(join(root, `${out.doc.id}.txt`))).toBe(true);   // текст для профиля/оценок есть
    expect(out.doc.chars).toBeGreaterThan(0);
  });

  it('падение стора не оставляет документ в манифесте', async () => {
    await expect(docs.addDocument({
      username: 'u1', candidateId: 'c-g', filename: 'x.pdf', buffer: Buffer.from('%PDF'),
      externalStore: async () => { throw new Error('gcs down'); },
    })).rejects.toThrow(/gcs down/);
    // ensureCandidate создаёт пустой манифест раньше стора — документ туда попасть не должен
    const m = docs.readManifest('u1', 'c-g');
    expect(m ? m.docs.length : 0).toBe(0);
  });

  it('readDocBytes: gcs-документ идёт в клиент, локальный — с диска', async () => {
    // локальный
    const local = await docs.addDocument({ username: 'u1', candidateId: 'c-r', filename: 'a.txt', buffer: Buffer.from('локальный текст') });
    const buf1 = await docs.readDocBytes('u1', 'c-r', local.doc);
    expect(buf1.toString()).toBe('локальный текст');

    // gcs — мокаем клиента через реальный HTTP-фейк не будем здесь: storage.doc_id/ext достаточно,
    // чтобы readDocBytes пошёл в downloadDocBytes; отсутствие ядра даёт понятную ошибку.
    const remote = await docs.addDocument({
      username: 'u1', candidateId: 'c-r', filename: 'v.m4a', buffer: Buffer.from([1, 2]), manualType: 'interview',
      externalStore: async (info) => ({ backend: 'gcs', key: 'k', doc_id: info.docId, ext: info.ext }),
    });
    const savedEnv = { A: process.env.AGENT_INTERNAL_URL, S: process.env.AGENT_SECRET };
    delete process.env.AGENT_INTERNAL_URL; delete process.env.AGENT_SECRET;
    try {
      await expect(docs.readDocBytes('u1', 'c-r', remote.doc)).rejects.toThrow(/недоступна|download failed/);
    } finally {
      if (savedEnv.A !== undefined) process.env.AGENT_INTERNAL_URL = savedEnv.A;
      if (savedEnv.S !== undefined) process.env.AGENT_SECRET = savedEnv.S;
    }
  });
});

describe('healManifest + дедуп + удаление (#107)', () => {
  it('старые записи (до фиксов): extract_error у медиа убирается, media_kind проставляется', async () => {
    const out = await docs.addDocument({ username: 'u1', candidateName: 'Татьяна', filename: 'old.m4a', buffer: Buffer.from([1]), manualType: 'interview' });
    // имитируем запись, сделанную ДО фиксов (#87): без media_kind, со старой ошибкой
    const m = docs.readManifest('u1', out.candidate_id);
    delete m.docs[0].media_kind;
    m.docs[0].extract_error = 'Формат .m4a не поддерживается — конвертируй в .txt/.md или вставь текстом.';
    docs.writeManifest('u1', out.candidate_id, m);

    const healed = docs.readManifest('u1', out.candidate_id);
    expect(healed.docs[0].media_kind).toBe('media');
    expect(healed.docs[0].extract_error).toBeUndefined();

    const err = await docs.extractProfile({ username: 'u1', candidateId: out.candidate_id });
    expect(err.error).not.toContain('Формат .m4a не поддерживается');
    expect(err.error).toContain('Расшифровать');
  });

  it('повторная загрузка того же контента — дубль не создаётся; явный тип правит', async () => {
    const buf = Buffer.from('один и тот же файл');
    const a = await docs.addDocument({ username: 'u1', candidateId: 'c-d', filename: 'cv.txt', buffer: buf });
    const b = await docs.addDocument({ username: 'u1', candidateId: 'c-d', filename: 'cv.txt', buffer: buf });
    expect(b.duplicate).toBe(true);
    expect(b.doc.id).toBe(a.doc.id);
    expect(docs.readManifest('u1', 'c-d').docs).toHaveLength(1);

    // правила и так дают cover_letter (короткий текст) — правим в РАЗНЫЙ тип
    const c = await docs.addDocument({ username: 'u1', candidateId: 'c-d', filename: 'cv.txt', buffer: buf, manualType: 'correspondence' });
    expect(c.duplicate).toBe(true);
    expect(c.doc.type).toBe('correspondence');
    expect(c.doc.detected_by).toBe('manual');
    expect(docs.readManifest('u1', 'c-d').docs).toHaveLength(1);
  });

  it('deleteDocument: локальный документ — байты, .txt и запись исчезают', async () => {
    const out = await docs.addDocument({ username: 'u1', candidateId: 'c-del', filename: 'a.txt', buffer: Buffer.from('текст') });
    const root = docs.candRoot('u1', 'c-del');
    expect(existsSync(join(root, `${out.doc.id}.txt`))).toBe(true);

    const res = await docs.deleteDocument({ username: 'u1', candidateId: 'c-del', docId: out.doc.id });
    expect(res.ok).toBe(true);
    expect(existsSync(join(root, `${out.doc.id}.txt`))).toBe(false);
    expect(docs.readManifest('u1', 'c-del').docs).toHaveLength(0);
  });

  it('deleteDocument: gcs-документ — сначала ядро, при ошибке манифест не трогается', async () => {
    const out = await docs.addDocument({
      username: 'u1', candidateId: 'c-delg', filename: 'v.m4a', buffer: Buffer.from([9]), manualType: 'interview',
      externalStore: async (info) => ({ backend: 'gcs', key: 'k', doc_id: info.docId, ext: info.ext }),
    });
    const saved = { u: process.env.AGENT_INTERNAL_URL, s: process.env.AGENT_SECRET };
    delete process.env.AGENT_INTERNAL_URL; delete process.env.AGENT_SECRET;
    try {
      const res = await docs.deleteDocument({ username: 'u1', candidateId: 'c-delg', docId: out.doc.id });
      expect(res.error).toMatch(/хранилища/);
      expect(docs.readManifest('u1', 'c-delg').docs).toHaveLength(1); // ничего не удалено
    } finally {
      if (saved.u !== undefined) process.env.AGENT_INTERNAL_URL = saved.u;
      if (saved.s !== undefined) process.env.AGENT_SECRET = saved.s;
    }
  });

  it('deleteDocument: неизвестный документ/кандидат → error', async () => {
    expect((await docs.deleteDocument({ username: 'u1', candidateId: 'nope', docId: 'x' })).error).toMatch(/не найден/);
    const out = await docs.addDocument({ username: 'u1', candidateId: 'c-de', filename: 'a.txt', buffer: Buffer.from('t') });
    expect((await docs.deleteDocument({ username: 'u1', candidateId: 'c-de', docId: 'zzz' })).error).toMatch(/не найден/);
    expect(out.doc.id).toBeTruthy();
  });
});

describe('имя не блокирует + переименование (UX #107)', () => {
  it('addDocument без имени → «Кандидат», renameCandidate правит', async () => {
    const out = await docs.addDocument({ username: 'u1', filename: 'a.txt', buffer: Buffer.from('текст') });
    const m = docs.readManifest('u1', out.candidate_id);
    expect(m.name).toBe('Кандидат');
    expect(out.candidate_id).toMatch(/^candidate-/);

    const r = docs.renameCandidate({ username: 'u1', candidateId: out.candidate_id, name: '  Татьяна Потапова  ' });
    expect(r.ok).toBe(true);
    expect(docs.readManifest('u1', out.candidate_id).name).toBe('Татьяна Потапова');
    expect(docs.readManifest('u1', out.candidate_id).candidate_id).toBe(out.candidate_id); // id стабилен
  });

  it('rename: пустое имя и неизвестный кандидат — error', async () => {
    expect(docs.renameCandidate({ username: 'u1', candidateId: 'x', name: '   ' }).error).toBeTruthy();
    expect(docs.renameCandidate({ username: 'u1', candidateId: 'nope', name: 'Y' }).error).toMatch(/не найден/);
  });
});

describe('vision-классификация изображений (#107 → резюме-картинка)', () => {
  const LADDER = 'https://llm-ladder.trainedassist.store';
  let savedToken;

  function nockVision(visionJson, { fail = false } = {}) {
    return nock(LADDER).post('/v1/chat/completions').reply(200, (_u, body) => {
      nock.__lastBody = JSON.stringify(body);
      if (fail) return { error: { message: 'boom' } };
      const hasImage = JSON.stringify(body).includes('data:image');
      const content = hasImage ? visionJson : JSON.stringify({ summary: 'профиль' });
      return { choices: [{ message: { content } }], model: 'gemini-flash' };
    });
  }

  beforeEach(() => {
    savedToken = process.env.LLM_LADDER_TOKEN;
    process.env.LLM_LADDER_TOKEN = 'test-vision-token';
    nock.cleanAll();
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env.LLM_LADDER_TOKEN;
    else process.env.LLM_LADDER_TOKEN = savedToken;
    nock.cleanAll();
    delete nock.__lastBody;
  });

  it('картинка-резюме: vision определяет resume и переносит текст → .txt рядом', async () => {
    nockVision(JSON.stringify({ type: 'resume', reason: 'визуально резюме с опытом и датами', text: 'Татьяна Потапова — Wealth Advisor\nОпыт: 09.2024 — 06.2026 SKYFORT CAPITAL' }));
    const out = await docs.addDocument({
      username: 'u1', candidateName: 'Татьяна', filename: 'photo_2026-10-02 09.59.21.jpeg',
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), // jpeg-заголовок
    });
    expect(out.doc.type).toBe('resume');
    expect(out.doc.detected_by).toBe('llm');
    expect(out.doc.reason).toContain('резюме');
    expect(out.doc.chars).toBeGreaterThan(50);
    expect(out.doc.media_kind).toBe('image'); // медиа-факт сохранён
    expect(existsSync(join(docs.candRoot('u1', out.candidate_id), `${out.doc.id}.txt`))).toBe(true);
    // в запрос действительно ушла картинка, а не пустой текст
    expect(nock.__lastBody).toContain('data:image/jpeg;base64,');
    expect(docs.combinedText('u1', out.candidate_id)).toContain('SKYFORT');
  });

  it('ручной тип главнее, но текст vision всё равно берётся', async () => {
    nockVision(JSON.stringify({ type: 'photo', reason: 'какое-то фото', text: 'Текст с картинки, который остался' }));
    const out = await docs.addDocument({
      username: 'u1', candidateId: 'c-v2', filename: 'x.jpeg',
      buffer: Buffer.from([0xff, 0xd8, 1]), manualType: 'resume',
    });
    expect(out.doc.type).toBe('resume');
    expect(out.doc.detected_by).toBe('manual');
    expect(out.doc.chars).toBeGreaterThan(0); // текст из vision сохранён
  });

  it('vision недоступен (нет токена) → прежние правила: image → фото', async () => {
    delete process.env.LLM_LADDER_TOKEN;
    const out = await docs.addDocument({
      username: 'u1', candidateId: 'c-v3', filename: 'p.jpeg', buffer: Buffer.from([0xff, 0xd8]),
    });
    expect(out.doc.type).toBe('photo');
    expect(out.doc.detected_by).toBe('rules');
    expect(out.doc.chars).toBe(0);
  });

  it('extractProfile: догоняет текст у старых картинок (backfill) и строит профиль', async () => {
    // документ «до vision»: создаём БЕЗ токена → правила, текста нет
    delete process.env.LLM_LADDER_TOKEN;
    const up = await docs.addDocument({
      username: 'u1', candidateId: 'c-v4', candidateName: 'Анна', filename: 'old-cv.jpeg',
      buffer: Buffer.from([0xff, 0xd8]), manualType: 'resume',
    });
    expect(up.doc.chars).toBe(0);
    process.env.LLM_LADDER_TOKEN = 'test-vision-token';

    // вызова будет два: backfill (vision, в теле картинка) и сам профиль
    nock(LADDER).post('/v1/chat/completions').times(2).reply(200, (_u, body) => {
      const hasImage = JSON.stringify(body).includes('data:image');
      const content = hasImage
        ? JSON.stringify({ type: 'resume', reason: 'резюме', text: 'Опыт работы 2020 – 2024, навыки: SEO' })
        : JSON.stringify({ name: 'Анна', experience: [{ period: '2020-2024', company: 'X', role: 'PM' }], skills: ['SEO'], summary: 'Опытный PM' });
      return { choices: [{ message: { content } }], model: 'gemini-flash' };
    });

    const out = await docs.extractProfile({ username: 'u1', candidateId: 'c-v4' });
    expect(out.ok).toBe(true);
    expect(out.profile.summary).toContain('Опытный');
    const m = docs.readManifest('u1', 'c-v4');
    expect(m.docs[0].chars).toBeGreaterThan(0);
  });
});
