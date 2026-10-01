'use strict';
// Extract plain text from files dropped into the vacancy-new page (#85).
// Zero-dependency: txt/md are utf8, docx is a minimal zip reader on node:zlib,
// pdf shells out to poppler's pdftotext when the host has it (graceful error when not).
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_TEXT = 500 * 1024;
const PDF_TIMEOUT_MS = 30_000;

function fail(error) {
  return { ok: false, error };
}

function ok(text) {
  return { ok: true, text: String(text || '').trim().slice(0, MAX_TEXT) };
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

// ── DOCX: read word/document.xml out of the zip container ─────────────────────
// EOCD → central directory → local header → raw/deflated payload. Only the pieces
// the format guarantees; no general-purpose unzip.

function readZipEntry(buf, entryName) {
  // EOCD signature PK\x05\x06, searched from the end (comment ≤ 65535 bytes).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('не похоже на zip/docx (EOCD не найден)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('повреждённая central directory');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (name === entryName) {
      if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('повреждённый local header');
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compSize);
      if (method === 0) return raw.toString('utf8');
      if (method === 8) return zlib.inflateRawSync(raw).toString('utf8');
      throw new Error(`неподдерживаемый метод сжатия zip: ${method}`);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`нет файла ${entryName} в docx`);
}

function docxToText(buf) {
  const xml = readZipEntry(buf, 'word/document.xml');
  const text = xml
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tc>/g, ' | ')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text);
}

// ── PDF: poppler's pdftotext when present, honest error when not ──────────────

function pdfToText(buf) {
  const tmp = path.join(os.tmpdir(), `hh-pdf-${process.pid}-${Date.now()}.pdf`);
  try {
    fs.writeFileSync(tmp, buf);
    const r = spawnSync('pdftotext', ['-enc', 'UTF-8', '-layout', tmp, '-'], {
      encoding: 'utf8', timeout: PDF_TIMEOUT_MS, maxBuffer: MAX_TEXT * 2,
    });
    if (r.error && r.error.code === 'ENOENT') {
      return fail('На сервере нет pdftotext (poppler) — вставь текст из PDF вручную в поле вакансии.');
    }
    if (r.error) return fail(`Ошибка разбора PDF: ${r.error.message}`);
    if (r.status !== 0) return fail(`pdftotext завершился с ошибкой: ${(r.stderr || '').trim().slice(0, 200)}`);
    const text = (r.stdout || '').trim();
    if (!text) return fail('PDF без текста (скан?) — вставь содержимое вручную.');
    return ok(text);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
}

function extractTextFromBuffer(buf, filename) {
  if (!Buffer.isBuffer(buf) || !buf.length) return fail('Пустой файл.');
  if (buf.length > MAX_BYTES) return fail(`Файл больше ${Math.round(MAX_BYTES / 1048576)} МБ.`);

  const ext = path.extname(String(filename || '')).toLowerCase();
  try {
    if (['.txt', '.md', '.markdown', '.csv', '.text'].includes(ext)) {
      return ok(buf.toString('utf8').replace(/^\uFEFF/, ''));
    }
    if (ext === '.docx') return ok(docxToText(buf));
    if (ext === '.pdf') return pdfToText(buf);
    // Без расширения — пробуем как текст; бинарь отвергаем по нулям в начале.
    if (!ext && buf.subarray(0, 1024).includes(0)) return fail('Бинарный файл без расширения — не понятно, как читать.');
    if (!ext) return ok(buf.toString('utf8'));
    return fail(`Формат .${ext.slice(1)} не поддерживается — конвертируй в .txt/.md или вставь текстом.`);
  } catch (e) {
    return fail(`Не удалось извлечь текст: ${e.message}`);
  }
}

module.exports = { extractTextFromBuffer, docxToText, MAX_BYTES };
