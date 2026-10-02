'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Интервью (#88, эпик #83): Deepgram-транскрипция → подписанный транскрипт в
// формате гайда → детерминированная Q&A-структура «ходов» рекрутер/кандидат.
//
// Зачем в КОДЕ скила: пайплайн один для всех сессий/юзеров, попадается в MCP,
// идемпотентен по источнику — «скинул ссылку → транскрипт», повтор не платит ни
// скачиванием, ни Deepgram (#89 разбирает готовые ходы без повторной расшифровки).
//
// Дизайн (решение из комментариев #88, проверено до реализации):
//   * видео НЕ распиливаем и аудио НЕ отделяем — Deepgram принимает
//     видео-контейнеры напрямую (mp4 38/40 МБ ушли как video/mp4 → 200);
//   * транспорт v1 — публичная ссылка Google Drive (drive.google.com/uc?…,
//     с confirm-токеном для больших файлов) либо прямой https-URL.
//     Локальные файлы не принимаются: у сервера нет этой папки, а выгрузка в
//     JSON-загрузку упирается в лимит 15 МБ (#85);
//   * ключ Deepgram — только env DEEPGRAM_API_KEY или credential-файл
//     agent-tokens/<user>/deepgram: никогда в коде и никогда в логах;
//   * каждый https-вызов с явным timeout (L3-гард);
//   * идемпотентность — sha256 источника (повтор → кэш, force пересчитывает).
//
// hh_interview_structure — БЕЗ LLM: разделение спикеров детерминированно по
// Q&A-паттерну (кто задаёт вопросы = рекрутер) плюс заголовок
// «Интервью: … (рекрутер) — …», если транскрипт уже подписан. Один голос или
// нечитаемое чередование → speakers_detected: false честно, без выдуманных ролей.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { dataRoot, tokensRoot } = require('../../data-paths.js');
const { readCredentialFileSafe } = require('../../hh-utils.js');

const DEEPGRAM_LISTEN_URL =
  'https://api.deepgram.com/v1/listen?model=nova-2&language=ru&smart_format=true&paragraphs=true&utterances=true&diarize=true';
const DOWNLOAD_TIMEOUT_MS = 180_000;
const DEEPGRAM_TIMEOUT_MS = 240_000;
// Гайд, шаг 1: ведёт интервью Владимир — подпись в заголовке и в репликах.
const RECRUITER_LABEL = 'Владимир (рекрутер)';
const SEPARATOR = '='.repeat(60);
// Вопросов должно быть заметно больше у одного спикера, иначе чередование
// нечитаемо и роли не подписываем (выдумать хуже, чем не подписать).
const MIN_QUESTION_SCORE = 3;
const CONTENT_TYPES = {
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', avi: 'video/x-msvideo',
  m4a: 'audio/mp4', m4r: 'audio/mp4', wav: 'audio/wav', mp3: 'audio/mpeg', aac: 'audio/aac', ogg: 'audio/ogg',
};

// ── Пути ─────────────────────────────────────────────────────────────────────

function interviewsRoot(userId) {
  return path.join(dataRoot(), 'hh', String(userId || ''), 'interviews');
}

function slugName(name) {
  return String(name || '')
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function fallbackSlug(source) {
  const id = driveFileId(source);
  if (id) return slugName(`drive-${id.slice(0, 12)}`) || 'interview';
  try {
    const base = path.posix.basename(new URL(source).pathname).replace(/\.[^.]+$/, '');
    return slugName(base) || 'interview';
  } catch { return 'interview'; }
}

function readMeta(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8')); }
  catch { return null; }
}

// ── Ключ Deepgram: env → credential-файл (по образцу readGigachatKey) ────────

function deepgramKey(userId) {
  const fromEnv = process.env.DEEPGRAM_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const files = [
    path.join(tokensRoot(), String(userId || process.env.USER_ID || ''), 'deepgram'),
    path.join(tokensRoot(), 'deepgram', 'token'),
    path.join(tokensRoot(), 'deepgram'),
  ];
  for (const file of files) {
    try {
      const value = readCredentialFileSafe(file);
      if (value && value.trim()) return value.trim();
    } catch { /* нет файла / не расшифровывается → смотрим дальше */ }
  }
  return null;
}

// ── Формат гайда ─────────────────────────────────────────────────────────────

function fmtClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function todayStr(now = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${p(now.getDate())}.${p(now.getMonth() + 1)}.${now.getFullYear()}`;
}

function headerTitle(speakersDetected, candidateName) {
  return speakersDetected ? `${RECRUITER_LABEL} — ${candidateName}` : candidateName;
}

// rows: [{label, t, text}] — уже склеенные и подписанные ходы.
// body: готовый текст (путь text), когда разбирать нечего.
function renderTranscript({ title, date = todayStr(), durationSec = null, rows = null, body = null }) {
  const lines = [
    `Интервью: ${title}`,
    `Дата: ${date}`,
    durationSec == null ? 'Длительность: неизвестна' : `Длительность: ${(durationSec / 60).toFixed(1)} мин`,
    SEPARATOR,
  ];
  if (body != null) lines.push('', body);
  else for (const row of rows) lines.push('', `[${fmtClock(row.t)}] ${row.label}: ${row.text}`);
  return lines.join('\n') + '\n';
}

// Разбор уже готового транскрипта: «[м:сс] Спикер: текст» с таймкодом или
// «Спикер: текст» без него (примеры клиента из Zoom — оба варианта).
function parseTranscript(raw) {
  const turns = [];
  let header = '';
  for (const line of String(raw || '').split(/\r?\n/)) {
    if (!header && /^Интервью:/.test(line)) { header = line; continue; }
    if (!line.trim()) continue;
    if (/^={4,}$/.test(line.trim())) continue;
    if (/^(Дата|Длительность):/.test(line)) continue;
    const timed = /^\[(\d+):(\d{2})\]\s*([^:]{1,60}):\s*(.*)$/.exec(line);
    if (timed) {
      turns.push({ speaker: timed[3].trim(), t: Number(timed[1]) * 60 + Number(timed[2]), text: timed[4].trim() });
      continue;
    }
    const plain = /^([^:]{1,60}):\s+(.*)$/.exec(line);
    if (plain) turns.push({ speaker: plain[1].trim(), t: null, text: plain[2].trim() });
    else if (turns.length) turns[turns.length - 1].text += ` ${line.trim()}`; // продолжение реплики
  }
  if (!turns.length) {
    // Голый текст без подписей: один блок, ролей не выдумываем.
    const body = String(raw || '').split(/\r?\n/).filter(l => l.trim() && !/^(Интервью|Дата|Длительность):/.test(l) && !/^={4,}$/.test(l.trim())).join(' ').trim();
    if (body) turns.push({ speaker: 'Спикер 0', t: null, text: body });
  }
  return { header, turns };
}

// ── Склейка соседних реплик одного спикера ───────────────────────────────────

function mergeUtterances(utterances) {
  const out = [];
  for (const u of utterances || []) {
    const text = String(u?.transcript || '').trim();
    if (!text) continue;
    const speaker = u.speaker ?? 0;
    // Таймкод — начало блока; null (текстовый транскрипт без таймкодов) остаётся null.
    const t = u.start == null ? null : Number(u.start) || 0;
    const prev = out[out.length - 1];
    if (prev && String(prev.speaker) === String(speaker)) prev.text += ` ${text}`;
    else out.push({ speaker, t, text });
  }
  return out;
}

// Склеивание соседних реплик одного спикера для уже разобранного текстового
// транскрипта (путь «готовый файл», без сырых utterance'ов).
function mergeTurns(turns) {
  return mergeUtterances((turns || []).map(t => ({ speaker: t.speaker, start: t.t, transcript: t.text })));
}

// Без utterances (или пустая запись) остаётся один текстовый блок — честный
// «один голос», который structure отметит как неразделённый.
function turnsFromDeepgram(json) {
  const utterances = json?.results?.utterances;
  if (Array.isArray(utterances) && utterances.length) return mergeUtterances(utterances);
  const plain = json?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  return plain && plain.trim() ? [{ speaker: 0, t: 0, text: plain.trim() }] : [];
}

// ── Определение ролей (без LLM) ──────────────────────────────────────────────

// Вопрос в конце реплики весит больше (это явный ход-вопрос), «?» внутри —
// уточнения. Сумма по ходам спикера = его «вопросность».
function questionScore(text) {
  const qmarks = (String(text).match(/\?/g) || []).length;
  const endsWithQuestion = /\?\s*$/.test(String(text).trim()) ? 1 : 0;
  return qmarks + 2 * endsWithQuestion;
}

// «Интервью: Владимир (рекрутер) — Кандидат (пример 1)» → имя/метка → роль.
function headerRoleMap(header) {
  if (!header || !/^Интервью:/.test(header)) return null;
  const sides = header.replace(/^Интервью:\s*/i, '').split(/\s+[—–]\s+|\s+-\s+/);
  const map = {};
  for (const side of sides) {
    const role = /рекрутер/i.test(side) ? 'recruiter' : /кандидат/i.test(side) ? 'candidate' : null;
    if (!role) continue;
    const name = side.replace(/\s*\([^)]*\)/g, '').trim();
    if (name) map[name.toLowerCase()] = role;
    map[side.trim().toLowerCase()] = role;
  }
  return Object.keys(map).length ? map : null;
}

function roleFromHeader(map, speaker) {
  const key = String(speaker).toLowerCase().trim();
  if (map[key]) return map[key];
  const stripped = key.replace(/\s*\([^)]*\)/g, '').trim();
  if (map[stripped]) return map[stripped];
  if (/рекрутер/.test(key)) return 'recruiter';
  if (/кандидат/.test(key)) return 'candidate';
  return null;
}

// turns: [{speaker, text, t?}], header — строка «Интервью: …», если есть.
// → {speakers_detected, roles: {speaker: 'recruiter'|'candidate'}, reason}
function detectRoles(turns, header = null) {
  const speakers = [];
  for (const t of turns) if (!speakers.some(s => String(s) === String(t.speaker))) speakers.push(t.speaker);
  if (speakers.length < 2) return { speakers_detected: false, roles: {}, reason: 'один спикер' };

  const fromHeader = headerRoleMap(header);
  if (fromHeader) {
    const roles = {};
    let complete = true;
    for (const s of speakers) {
      const role = roleFromHeader(fromHeader, s);
      if (!role) { complete = false; break; }
      roles[s] = role;
    }
    if (complete && new Set(Object.values(roles)).size === 2) {
      return { speakers_detected: true, roles, reason: 'заголовок' };
    }
  }

  const score = {};
  for (const s of speakers) score[String(s)] = 0;
  for (const t of turns) score[String(t.speaker)] += questionScore(t.text);
  const ranked = [...speakers].sort((a, b) => score[String(b)] - score[String(a)]);
  const [top, second] = ranked;
  if (score[String(top)] >= MIN_QUESTION_SCORE && score[String(top)] > score[String(second)]) {
    const roles = {};
    for (const s of speakers) roles[s] = String(s) === String(top) ? 'recruiter' : 'candidate';
    return { speakers_detected: true, roles, reason: 'q&a' };
  }
  return { speakers_detected: false, roles: {}, reason: 'нечитаемое чередование' };
}

function labelFor(speaker, roles, candidateName) {
  const role = roles?.[speaker] ?? roles?.[String(speaker)];
  if (role === 'recruiter') return RECRUITER_LABEL;
  if (role === 'candidate') return candidateName;
  return `Спикер ${speaker}`;
}

// ── Скачивание источника ─────────────────────────────────────────────────────

function driveFileId(source) {
  const byPath = /^https?:\/\/(?:www\.)?drive\.google\.com\/file\/d\/([^/?#]+)/i.exec(String(source || ''));
  if (byPath) return byPath[1];
  try {
    const url = new URL(source);
    if (/^(?:www\.)?drive\.google\.com$/i.test(url.hostname)) return url.searchParams.get('id');
  } catch { /* не URL — значит не Drive */ }
  return null;
}

function driveDownloadUrl(source) {
  const id = driveFileId(source);
  return id ? `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}` : null;
}

// Контент-тип строго по расширению: mp4/m4a/wav — три формата из гайда,
// всё остальное уходит как mp4-контейнер (Deepgram ест видео напрямую).
function contentTypeFor(url, filename, headerCt) {
  const byExt = value => {
    const m = /\.([A-Za-z0-9]+)$/.exec(String(value || '').split(/[?#]/)[0]);
    return m ? CONTENT_TYPES[m[1].toLowerCase()] || null : null;
  };
  let pathname = url;
  try { pathname = new URL(url).pathname; } catch { /* уже путь */ }
  return byExt(pathname) || byExt(filename) ||
    (Object.values(CONTENT_TYPES).includes(headerCt) ? headerCt : null) ||
    'video/mp4';
}

function fileNameFromDisposition(disposition) {
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition || '');
  return m ? decodeURIComponent(m[1]).trim() : '';
}

// Большие файлы Drive отдают HTML-страницу с формой подтверждения
// («Слишком большой для проверки на вирусы») — собираем её action + hidden-поля.
function driveConfirmUrl(pageUrl, html) {
  const action = /<form[^>]*\baction="([^"]+)"/i.exec(html || '')?.[1];
  const params = new Map();
  for (const [tag] of html.matchAll(/<input\b[^>]*>/gi)) {
    const name = /\bname="([^"]*)"/i.exec(tag)?.[1];
    const value = /\bvalue="([^"]*)"/i.exec(tag)?.[1];
    if (name) params.set(name, value || '');
  }
  if (params.get('confirm')) {
    if (!action) return null;
    const url = new URL(action, pageUrl);
    for (const [key, value] of params) url.searchParams.set(key, value);
    return url.toString();
  }
  const legacy = /[?&]confirm=([0-9A-Za-z_-]+)/.exec(html || '');
  if (legacy) {
    const url = new URL(pageUrl);
    url.searchParams.set('confirm', legacy[1]);
    return url.toString();
  }
  return null;
}

async function downloadSource(source) {
  let url = driveDownloadUrl(source) || source;
  let res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Скачивание источника не удалось: HTTP ${res.status} (${new URL(url).host})`);

  let disposition = res.headers.get('content-disposition') || '';
  let contentTypeHeader = res.headers.get('content-type') || '';
  if (/text\/html/i.test(contentTypeHeader)) {
    const html = await res.text();
    const next = driveConfirmUrl(url, html);
    if (!next) throw new Error('Google Drive: вместо файла пришла HTML-страница — проверь, что ссылка публичная («Все, у кого есть ссылка») и ведёт на файл, а не на папку.');
    res = await fetch(next, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Google Drive: HTTP ${res.status} на скачивании`);
    contentTypeHeader = res.headers.get('content-type') || '';
    if (/text\/html/i.test(contentTypeHeader)) {
      throw new Error('Google Drive: confirm-токен не помог, файл не отдаётся — проверь права доступа по ссылке.');
    }
    disposition = res.headers.get('content-disposition') || disposition;
    url = next;
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error('Источник пустой (0 байт)');
  const filename = fileNameFromDisposition(disposition);
  return { buffer, filename, contentType: contentTypeFor(url, filename, contentTypeHeader) };
}

// Загруженный кандидатом файл из candidate-docs (#87): окно «Новый кандидат»
// кладёт аудио/видео на сервер — расшифровка идёт прямо с него, без URL.
async function loadUploadedDoc(userId, args) {
  const candidateId = String(args.candidate_id || '').trim();
  const docId = String(args.doc_id || '').trim();
  if (!candidateId && !docId) return null;
  if (!candidateId || !docId) throw new Error('Для загруженного файла нужны и candidate_id, и doc_id.');
  const cand = require('../../hh-candidate-docs');
  const manifest = cand.readManifest(userId, candidateId);
  if (!manifest) throw new Error(`Кандидат «${candidateId}» не найден — сначала загрузи документы.`);
  const doc = (manifest.docs || []).find(d => d.id === docId);
  if (!doc) throw new Error(`Документ ${docId} не найден у кандидата «${candidateId}».`);
  const ext = String(doc.ext || '').toLowerCase();
  if (!['.mp4', '.mov', '.m4a', '.wav', '.mp3', '.webm', '.avi', '.aac', '.ogg', '.m4r'].includes(ext)) {
    throw new Error(`«${doc.filename}» не аудио/видео — расшифровать нечего. Для текста есть поле «Вставить текстом».`);
  }
  const file = path.join(cand.candRoot(userId, candidateId), `${doc.id}${ext}`);
  let buffer;
  if (doc.storage && doc.storage.backend === 'gcs') {
    // Файл живёт в GCS (#105) — ядро отдаёт байты по /internal/blob/download
    try {
      buffer = await cand.readDocBytes(userId, candidateId, doc);
    } catch (e) {
      throw new Error(`Не удалось получить «${doc.filename}» из хранилища: ${e.message}`);
    }
  } else {
    if (!fs.existsSync(file)) throw new Error(`Файл «${doc.filename}» не найден на диске (${file}) — загрузи заново.`);
    buffer = fs.readFileSync(file);
  }
  if (!buffer.length) throw new Error(`Файл «${doc.filename}» пустой (0 байт)`);
  return {
    buffer,
    filename: doc.filename,
    contentType: contentTypeFor('', doc.filename, ''),
    candidateName: manifest.name || doc.filename,
    sourceKey: `uploaded:${candidateId}/${docId}`,
  };
}

// ── Deepgram ─────────────────────────────────────────────────────────────────

async function deepgramListen(buffer, contentType, key) {
  const res = await fetch(DEEPGRAM_LISTEN_URL, {
    method: 'POST',
    headers: { Authorization: `Token ${key}`, 'Content-Type': contentType },
    body: buffer,
    signal: AbortSignal.timeout(DEEPGRAM_TIMEOUT_MS),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Deepgram: HTTP ${res.status} — ${raw.slice(0, 300)}`);
  let json;
  try { json = JSON.parse(raw); } catch { throw new Error('Deepgram: ответ не JSON'); }
  if (!json || !json.results) throw new Error('Deepgram: в ответе нет results');
  return json;
}

// ── Инструменты ──────────────────────────────────────────────────────────────

function resultPayload(meta, dir, slug, cached) {
  const transcriptPath = path.join(dir, `${slug}-transcript.txt`);
  const deepgramPath = path.join(dir, 'deepgram.json');
  return {
    cached,
    slug,
    candidate: meta.candidate,
    source_sha256: meta.source_sha256,
    content_sha256: meta.content_sha256 ?? null,
    speakers_detected: meta.speakers_detected ?? null,
    turns: meta.turns ?? null,
    duration_min: meta.duration_sec == null ? null : Number((meta.duration_sec / 60).toFixed(1)),
    transcript_path: transcriptPath,
    deepgram_path: fs.existsSync(deepgramPath) ? deepgramPath : null,
    structure_path: path.join(dir, `${slug}.structure.json`),
    portrait_structure_path: path.join(dir, 'structure.json'),
  };
}

module.exports = {
  isReady: () => true,

  tools: {
    hh_interview_transcribe: {
      description:
        'Расшифровать интервью: качает запись по публичной ссылке (Google Drive или прямой https-URL; ' +
        'локальные файлы не принимаются) и отправляет в Deepgram (nova-2, ru, diarize+utterances) напрямую — ' +
        'видео НЕ распиливается и аудио НЕ отделяется. Сохраняет сырой deepgram.json и транскрипт в формате ' +
        'гайда (заголовок «Интервью: …», реплики «[м:сс] Спикер: текст», соседние реплики одного спикера ' +
        'склеены) в agent-data/hh/<user>/interviews/<slug>/. Вместо ссылки можно передать text с готовым ' +
        'транскриптом — тогда Deepgram не вызывается. Идемпотентно по sha256 источника: повтор возвращает ' +
        'кэш, force пересчитывает. Нужен ключ DEEPGRAM_API_KEY в env или credential-файл.',
      inputSchema: {
        type: 'object',
        properties: {
          source_url: { type: 'string', description: 'Публичная ссылка на запись: Google Drive (drive.google.com/file/d/…/view или /uc?id=…) либо прямой https-URL mp4/m4a/wav.' },
          text: { type: 'string', description: 'Готовый текст/транскрипт интервью вместо файла — Deepgram не вызывается, ключ не нужен.' },
          candidate_name: { type: 'string', description: 'Имя кандидата: в заголовок транскрипта и подпись спикера. По умолчанию «Кандидат».' },
          slug: { type: 'string', description: 'Имя папки результата. По умолчанию — из candidate_name, иначе из ссылки.' },
          force: { type: 'boolean', description: 'Пересчитать, даже если по этому источнику транскрипт уже есть.' },
        },
      },
      handler: async (args = {}, ctx = {}) => {
        const userId = String(ctx.userId || process.env.USER_ID || '');
        const source = String(args.source_url || '').trim();
        const rawText = typeof args.text === 'string' ? args.text.trim() : '';
        const uploaded = await loadUploadedDoc(userId, args); // null, если candidate_id/doc_id не переданы

        const given = [source, rawText, uploaded].filter(Boolean).length;
        if (given > 1) throw new Error('Передай РОВНО один источник: source_url, text или загруженный файл (candidate_id + doc_id).');
        if (!given) throw new Error('Нет источника: source_url (Google Drive / https), text с готовым транскриптом либо загруженный файл кандидата (candidate_id + doc_id).');
        if (source && !/^https?:\/\//i.test(source)) {
          throw new Error('Источник должен быть http(s)-ссылкой или text — локальные файлы (и file://) не принимаются: у сервера нет этой папки.');
        }
        if (source && /drive\.google\.com\/drive\/folders\//i.test(source)) {
          throw new Error('Это ссылка на папку Google Drive — нужна ссылка на сам файл интервью.');
        }

        const explicitName = String(args.candidate_name || '').trim();
        const candidateName = explicitName || (uploaded ? uploaded.candidateName : 'Кандидат');
        const slug = slugName(args.slug || explicitName || (uploaded ? candidateName : null) || fallbackSlug(source)) || 'interview';
        const dir = path.join(interviewsRoot(userId), slug);
        const metaPath = path.join(dir, 'meta.json');
        const sourceSha = sha256Hex(uploaded ? uploaded.sourceKey : `${source}\n${rawText}`);

        // Идемпотентность: тот же источник и транскрипт на месте → кэш без сети.
        if (!args.force && fs.existsSync(metaPath)) {
          const meta = readMeta(dir);
          if (meta && meta.source_sha256 === sourceSha && fs.existsSync(path.join(dir, `${slug}-transcript.txt`))) {
            return resultPayload(meta, dir, slug, true);
          }
        }

        let transcript;
        let deepgramJson = null;
        let contentSha = null;
        let contentType = null;
        let durationSec = null;
        let speakersDetected = false;
        let turnsCount = 0;

        if (rawText) {
          const parsed = parseTranscript(rawText);
          const detection = detectRoles(parsed.turns, parsed.header);
          speakersDetected = detection.speakers_detected;
          turnsCount = parsed.turns.length;
          transcript = /^Интервью:/.test(rawText)
            ? rawText + '\n'
            : renderTranscript({ title: headerTitle(speakersDetected, candidateName), body: rawText });
        } else {
          const key = deepgramKey(userId);
          if (!key) {
            throw new Error(`Deepgram: нет ключа — задай DEEPGRAM_API_KEY в env либо положи ключ в credential-файл ${path.join(tokensRoot(), userId, 'deepgram')}.`);
          }
          let audioBuffer;
          if (uploaded) {
            audioBuffer = uploaded.buffer;
            contentType = uploaded.contentType;
          } else {
            const downloaded = await downloadSource(source);
            audioBuffer = downloaded.buffer;
            contentType = downloaded.contentType;
          }
          contentSha = sha256Hex(audioBuffer);
          deepgramJson = await deepgramListen(audioBuffer, contentType, key);
          durationSec = Number(deepgramJson?.metadata?.duration) || null;

          const turns = turnsFromDeepgram(deepgramJson);
          const detection = detectRoles(turns, null);
          speakersDetected = detection.speakers_detected;
          turnsCount = turns.length;
          transcript = renderTranscript({
            title: headerTitle(speakersDetected, candidateName),
            durationSec,
            rows: turns.map(t => ({ label: labelFor(t.speaker, detection.roles, candidateName), t: t.t, text: t.text })),
          });
        }

        fs.mkdirSync(dir, { recursive: true });
        if (deepgramJson) fs.writeFileSync(path.join(dir, 'deepgram.json'), JSON.stringify(deepgramJson, null, 2), 'utf-8');
        fs.writeFileSync(path.join(dir, `${slug}-transcript.txt`), transcript, 'utf-8');
        const meta = {
          slug,
          candidate: candidateName,
          kind: rawText ? 'text' : 'deepgram',
          source: source || (uploaded ? uploaded.sourceKey : null),
          source_sha256: sourceSha,
          content_sha256: contentSha,
          content_type: contentType,
          duration_sec: durationSec,
          turns: turnsCount,
          speakers_detected: speakersDetected,
          created_at: new Date().toISOString(),
        };
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
        return resultPayload(meta, dir, slug, false);
      },
    },

    hh_interview_structure: {
      description:
        'Разбить готовый транскрипт интервью на Q&A-ходы БЕЗ LLM: по Q&A-паттерну (кто задаёт вопросы — ' +
        'рекрутер, кто отвечает — кандидат) и по заголовку «Интервью: … (рекрутер) — …», если транскрипт ' +
        'уже подписан. Читает agent-data/hh/<user>/interviews/<slug>/ (сырой deepgram.json, иначе ' +
        '<slug>-transcript.txt), пишет структуру в оба имени контракта — <slug>.structure.json и ' +
        'structure.json (его читает hh_interview_evaluate): {speakers_detected, turns: [{speaker, role, ' +
        'text, t}]}. Один голос или нечитаемое чередование → speakers_detected: false и роли не подписаны — ' +
        'не выдумывай их. Идемпотентно: повтор возвращает кэш, force пересчитывает.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Папка интервью (см. hh_interview_transcribe).' },
          force: { type: 'boolean', description: 'Пересчитать, даже если structure.json уже есть.' },
        },
        required: ['slug'],
      },
      handler: async (args = {}, ctx = {}) => {
        const userId = String(ctx.userId || process.env.USER_ID || '');
        const slug = slugName(args.slug);
        if (!slug) throw new Error('Укажи slug интервью (папка с транскриптом).');

        const dir = path.join(interviewsRoot(userId), slug);
        if (!fs.existsSync(dir)) {
          throw new Error(`Интервью «${slug}» не найдено (${path.relative(process.cwd(), dir) || dir}) — сначала hh_interview_transcribe.`);
        }
        // Два имени одного файла, пока контракт не унифицирован: спека #88 обещает
        // <slug>.structure.json, а смёрдженный в main #89 (99b-interview-portrait.js)
        // читает structure.json из той же папки и называет это «контрактом #88» —
        // пишем оба, иначе эпик #83 рвётся на стыке #88→#89.
        const structurePath = path.join(dir, `${slug}.structure.json`);
        const sharedStructurePath = path.join(dir, 'structure.json');
        const structurePaths = [structurePath, sharedStructurePath];
        const transcriptPath = path.join(dir, `${slug}-transcript.txt`);
        const deepgramPath = path.join(dir, 'deepgram.json');

        let payload = null;
        let cached = false;
        if (!args.force) {
          for (const candidate of structurePaths) {
            if (!fs.existsSync(candidate)) continue;
            try { payload = JSON.parse(fs.readFileSync(candidate, 'utf-8')); cached = true; break; }
            catch { payload = null; /* битый файл — смотрим следующий */ }
          }
        }

        if (!payload) {
          const candidateName = readMeta(dir)?.candidate || 'Кандидат';
          let detection;
          let rawTurns;
          let sourcePath = null;

          if (fs.existsSync(deepgramPath)) {
            let json;
            try { json = JSON.parse(fs.readFileSync(deepgramPath, 'utf-8')); }
            catch { throw new Error(`Deepgram-ответ для «${slug}» не читается (битый JSON) — перезапусти с force.`); }
            rawTurns = turnsFromDeepgram(json);
            detection = detectRoles(rawTurns, null);
            sourcePath = deepgramPath;
          } else if (fs.existsSync(transcriptPath)) {
            const parsed = parseTranscript(fs.readFileSync(transcriptPath, 'utf-8'));
            rawTurns = mergeTurns(parsed.turns);
            detection = detectRoles(rawTurns, parsed.header);
            sourcePath = transcriptPath;
          } else {
            throw new Error(`Для «${slug}» нет ни deepgram.json, ни транскрипта — сначала hh_interview_transcribe.`);
          }

          payload = {
            speakers_detected: detection.speakers_detected,
            reason: detection.reason,
            turns: rawTurns.map(t => ({
              // Для deepgram-пути спикер подписывается как в транскрипте;
              // для текстового — метка из самой файла не переименовывается.
              speaker: sourcePath === deepgramPath ? labelFor(t.speaker, detection.roles, candidateName) : t.speaker,
              role: detection.roles[t.speaker] ?? detection.roles[String(t.speaker)] ?? null,
              text: t.text,
              t: t.t,
            })),
            source_path: sourcePath,
          };
        }

        const serialized = JSON.stringify(payload, null, 2);
        for (const candidate of structurePaths) fs.writeFileSync(candidate, serialized, 'utf-8');

        return {
          cached,
          slug,
          ...payload,
          turns_count: payload.turns.length,
          structure_path: structurePath,
          portrait_structure_path: sharedStructurePath,
          ...(payload.speakers_detected ? {} : {
            hint: 'Спикеры не разделены (один голос или нечитаемое чередование) — роли не подписаны, не приписывай их сам.',
          }),
        };
      },
    },
  },

  // Test hooks (pure functions): handlers stay the only production entry point.
  slugName,
  fmtClock,
  renderTranscript,
  parseTranscript,
  mergeUtterances,
  mergeTurns,
  turnsFromDeepgram,
  detectRoles,
  labelFor,
  contentTypeFor,
  driveFileId,
  driveDownloadUrl,
  driveConfirmUrl,
  deepgramKey,
};
