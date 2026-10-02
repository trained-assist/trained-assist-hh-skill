'use strict';
// Хранение документов кандидата (#87): ~/agent-data/hh/<user>/candidate-docs/<id>/
//   manifest.json — что загружено, какого типа, кем определено (rules|llm|manual)
//   <docId>.<ext> — исходные байты; <docId>.txt — извлечённый текст
//   profile.json — «сжатие до требований»: LLM выжимает всё в разрезы профиля
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataRoot } = require('./data-paths.js');
const { extractTextFromBuffer } = require('./hh-doc-text');
const { classifyDoc, llmClassifyChunk, TYPE_LABELS } = require('./hh-doc-classify');
const { slugify } = require('./hh-candidate-report');
const { ladderToken } = require('./hh-llm');

function candRoot(username, candidateId) {
  return path.join(dataRoot(), 'hh', String(username), 'candidate-docs', candidateId);
}

function manifestPath(username, candidateId) {
  return path.join(candRoot(username, candidateId), 'manifest.json');
}

function readManifest(username, candidateId) {
  const file = manifestPath(username, candidateId);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeManifest(username, candidateId, manifest) {
  const file = manifestPath(username, candidateId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  manifest.updated_at = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  return manifest;
}

// candidate_id попадает в query/HMAC-скоупы с SAFE_ID ([a-zA-Z0-9_-]) — транслитерируем,
// кириллица в имени живёт отдельно в manifest.name.
const TRANSLIT = { 'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e', 'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'h', 'ц': 'c', 'ч': 'ch', 'ш': 'sh', 'щ': 'sch', 'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya' };

function translit(s) {
  return String(s).toLowerCase().split('').map(c => (c in TRANSLIT ? TRANSLIT[c] : c)).join('');
}

function newCandidateId(name) {
  const base = slugify(translit(name)) || 'candidate';
  return `${base}-${Date.now().toString(36)}`;
}

function ensureCandidate(username, candidateId, name) {
  const id = candidateId || newCandidateId(name || 'candidate');
  const existing = readManifest(username, id);
  if (existing) return existing;
  return writeManifest(username, id, {
    candidate_id: id,
    name: name || id,
    created_at: new Date().toISOString(),
    docs: [],
    profile: null,
  });
}

function docId() {
  return Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

// Классификация: правила → (LLM-фолбэк снаружи, если rules дал 'other' и есть текст).
function classifyStored(doc, text) {
  return classifyDoc({ filename: doc.filename, text, ext: doc.ext });
}

async function addDocument({ username, candidateId = null, candidateName = null, filename, buffer, manualType = null, sourceUrl = null }) {
  const manifest = ensureCandidate(username, candidateId, candidateName);
  const id = docId();
  const ext = (String(filename).match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const root = candRoot(username, manifest.candidate_id);
  fs.mkdirSync(root, { recursive: true });

  let text = '';
  let extractError = null;
  let mediaKindName = null;
  if (!sourceUrl) {
    // Фото/аудио/видео/архив — не пытаемся «выжать» текст (раньше это давало
    // пугающее «формат не поддерживается» на абсолютно ожидаемых файлах).
    mediaKindName = require('./hh-doc-text').mediaKind(ext);
    if (!mediaKindName) {
      // extractTextFromBuffer смотрит расширение имени — даём синтетическое с тем же ext
      const extracted = extractTextFromBuffer(buffer, ext ? `doc${ext}` : String(filename || 'file'));
      if (extracted.ok) text = extracted.text;
      else extractError = extracted.error;
    }
  }

  let detected;
  if (manualType) {
    detected = { type: manualType, detected_by: 'manual', reason: 'выбрано при загрузке' };
  } else {
    detected = classifyStored({ filename, ext }, text);
  }

  if (!sourceUrl) fs.writeFileSync(path.join(root, `${id}${ext || '.bin'}`), buffer);
  if (text) fs.writeFileSync(path.join(root, `${id}.txt`), text);

  const doc = {
    id,
    filename: String(filename || sourceUrl || 'без имени').slice(0, 200),
    ext,
    type: detected.type,
    type_label: TYPE_LABELS[detected.type] || detected.type,
    detected_by: detected.detected_by,
    reason: detected.reason,
    source_url: sourceUrl || null,
    sha256,
    size: buffer ? buffer.length : 0,
    chars: text.length,
    media_kind: mediaKindName || undefined,
    extract_error: extractError || undefined,
    added_at: new Date().toISOString(),
  };
  manifest.docs.push(doc);
  writeManifest(username, manifest.candidate_id, manifest);
  return { candidate_id: manifest.candidate_id, doc };
}

// Правила дали 'other' → короткий LLM-классификатор по началу текста (первые 500
// символов, дешёвая модель). Необходимость — правило клиента: «резюме/письмо — в
// первую очередь по наличию истории опыта».
async function llmClassifyFallback({ username, candidateId, docId: id }) {
  const manifest = readManifest(username, candidateId);
  if (!manifest) return { error: 'Кандидат не найден.' };
  const doc = manifest.docs.find(d => d.id === id);
  if (!doc || doc.type !== 'other') return null;
  const txtFile = path.join(candRoot(username, candidateId), `${id}.txt`);
  if (!fs.existsSync(txtFile)) return null;
  const chunk = llmClassifyChunk(fs.readFileSync(txtFile, 'utf8'));
  if (!chunk.trim() || !ladderToken()) return null;

  const { hhLlmJson } = require('./hh-llm');
  const out = await hhLlmJson({
    messages: [
      { role: 'system', content: 'Классифицируй документ кандидата. Типы: resume (есть история опыта с датами/компаниями), cover_letter (просто о себе/письмо без истории), correspondence (переписка), interview (расшифровка интервью), portfolio, photo, other. Ответь ТОЛЬКО JSON: {"type":"...","reason":"одна короткая фраза"}' },
      { role: 'user', content: chunk },
    ],
    purpose: 'default',
    temperature: 0,
    maxTokens: 200,
    timeoutMs: 30_000,
    source: 'hh-candidate-docs',
  });
  const type = require('./hh-doc-classify').TYPES.includes(out?.type) ? out.type : null;
  if (!type || type === 'other') return null;
  doc.type = type;
  doc.type_label = TYPE_LABELS[type] || type;
  doc.detected_by = 'llm';
  doc.reason = String(out.reason || 'LLM-классификатор').slice(0, 120);
  writeManifest(username, candidateId, manifest);
  return { ok: true, doc };
}

function setDocType({ username, candidateId, docId: id, type }) {
  const manifest = readManifest(username, candidateId);
  if (!manifest) return { error: 'Кандидат не найден.' };
  const doc = manifest.docs.find(d => d.id === id);
  if (!doc) return { error: 'Документ не найден.' };
  doc.type = type;
  doc.type_label = TYPE_LABELS[type] || type;
  doc.detected_by = 'manual';
  doc.reason = 'правка вручную';
  writeManifest(username, candidateId, manifest);
  return { ok: true, doc };
}

function combinedText(username, candidateId, { types = ['resume', 'cover_letter', 'correspondence', 'interview'] } = {}) {
  const manifest = readManifest(username, candidateId);
  if (!manifest) return '';
  const root = candRoot(username, candidateId);
  const parts = [];
  for (const doc of manifest.docs) {
    if (!types.includes(doc.type)) continue;
    const txt = path.join(root, `${doc.id}.txt`);
    if (fs.existsSync(txt)) parts.push(`--- ${doc.filename} (${doc.type}) ---\n` + fs.readFileSync(txt, 'utf8'));
    else if (doc.source_url) parts.push(`--- ${doc.filename} (${doc.type}) ---\nссылка: ${doc.source_url}`);
  }
  return parts.join('\n\n');
}

// «Сжимаем всё до разрезов» — LLM-выжимка в профиль кандидата (та же геометрия, что
// у портрета вакансии, но заполненная фактами кандидата). Только факты из источников.
const PROFILE_SYSTEM = `Ты извлекаешь профиль кандидата из его документов (резюме, сопроводительное, переписка, расшифровка интервью).
Правила: только факты из источников, ничего не додумывай; отсутствующее — null или []; списки — плоские строки.
Отвечай ТОЛЬКО JSON без markdown:
{
  "name": null, "position": null,
  "experience": [{"period": "2023-2025", "company": "...", "role": "...", "details": ["..."]}],
  "skills": [], "education": [], "languages": [],
  "location": null, "salary_expectations": null,
  "summary": "3-4 предложения о кандидате от первого лица"
}`;

async function extractProfile({ username, candidateId }) {
  const manifest = readManifest(username, candidateId);
  if (!manifest) return { error: 'Кандидат не найден.' };
  const text = combinedText(username, candidateId);
  if (!text.trim()) {
    // Почему нет текста — по каждому файлу, с действием вместо общей фразы.
    const HINTS = {
      image: 'изображение — вставь текст вручную (поле «Вставить текстом») или дай PDF/docx с текстом',
      media: 'аудио/видео — нажми «Расшифровать» у документа',
      archive: 'архив — загрузи нужные файлы отдельно',
    };
    const perDoc = (manifest.docs || []).map(d => {
      const why = d.media_kind ? (HINTS[d.media_kind] || d.media_kind) : (d.extract_error || 'нет текста');
      return `• ${d.filename} — ${why}`;
    });
    return {
      error: 'Нет текстовых документов для профиля.\n'
        + (perDoc.length ? perDoc.join('\n') + '\n' : '')
        + 'Что сделать: вставь текст резюме в поле «Вставить текстом», либо загрузи PDF/docx с текстовым слоем, либо расшифруй аудио/видео кнопкой «Расшифровать».',
    };
  }
  if (!ladderToken()) return { error: 'llm-ladder token не найден.' };

  const { hhLlmJson } = require('./hh-llm');
  const profile = await hhLlmJson({
    messages: [
      { role: 'system', content: PROFILE_SYSTEM },
      { role: 'user', content: text.slice(0, 60000) },
    ],
    purpose: 'default',
    temperature: 0.1,
    maxTokens: 3000,
    timeoutMs: 60_000,
    source: 'hh-candidate-docs',
  });
  manifest.profile = { ...profile, extracted_at: new Date().toISOString() };
  writeManifest(username, candidateId, manifest);
  return { ok: true, profile: manifest.profile };
}

module.exports = {
  candRoot, manifestPath, readManifest, writeManifest, ensureCandidate,
  addDocument, setDocType, combinedText, extractProfile, llmClassifyFallback,
};
