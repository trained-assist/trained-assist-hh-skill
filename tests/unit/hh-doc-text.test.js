// src/hh-doc-text.js — file → text extraction for the vacancy-new page (#85).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { extractTextFromBuffer, mediaKind } = require('../../src/hh-doc-text.js');

// Минимальный zip (метод stored) с одной записью — ровно то, что умеет парсер docx.
function zipStore(name, data) {
  const nameBuf = Buffer.from(name, 'utf8');
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const localFull = Buffer.concat([local, nameBuf, payload]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42); // local header offset
  const centralFull = Buffer.concat([central, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralFull.length, 12);
  eocd.writeUInt32LE(localFull.length, 16);
  return Buffer.concat([localFull, centralFull, eocd]);
}

describe('extractTextFromBuffer', () => {
  it('reads txt/md as utf8 and strips BOM', () => {
    expect(extractTextFromBuffer(Buffer.from('\uFEFFИщем маркетолога'), 'a.txt')).toEqual({ ok: true, text: 'Ищем маркетолога' });
    expect(extractTextFromBuffer(Buffer.from('# Вакансия'), 'brief.md').text).toBe('# Вакансия');
  });

  it('unzips a docx and strips wordprocessingml tags', () => {
    const xml = '<w:p><w:r><w:t>Опыт от 2 лет &amp; портфолио</w:t></w:r></w:p><w:p><w:t>1С, Excel</w:t></w:p>';
    const buf = zipStore('word/document.xml', xml);
    const out = extractTextFromBuffer(buf, 'портрет.docx');
    expect(out.ok).toBe(true);
    expect(out.text).toContain('Опыт от 2 лет & портфолио');
    expect(out.text).toContain('1С, Excel');
    expect(out.text).not.toContain('<w:');
  });

  it('reports a docx without word/document.xml as an error', () => {
    const buf = zipStore('[Content_Types].xml', '<Types/>');
    const out = extractTextFromBuffer(buf, 'broken.docx');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/word\/document\.xml/);
  });

  it('rejects unsupported extensions with a hint', () => {
    const out = extractTextFromBuffer(Buffer.from('MZ binary'), 'resume.exe');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/не поддерживается/);
  });

  it('rejects empty input', () => {
    expect(extractTextFromBuffer(Buffer.alloc(0), 'a.txt').ok).toBe(false);
  });

  it('treats extensionless input with NUL bytes as binary', () => {
    const out = extractTextFromBuffer(Buffer.from([0x50, 0x4b, 0x00, 0x00]), 'noext');
    expect(out.ok).toBe(false);
  });
});

describe('медиа и старые форматы — понятные причины, а не «конвертируй в .txt»', () => {
  it('image / audio / archive / .doc дают осмысленные подсказки', () => {
    expect(extractTextFromBuffer(Buffer.from([0xff, 0xd8]), 'doc.jpeg').error).toMatch(/Изображение/);
    expect(extractTextFromBuffer(Buffer.from([0, 0]), 'doc.m4a').error).toMatch(/Расшифровать/);
    expect(extractTextFromBuffer(Buffer.from([0, 0]), 'doc.zip').error).toMatch(/Архив/);
    expect(extractTextFromBuffer(Buffer.from([0, 0]), 'old.doc').error).toMatch(/пересохрани/);
  });

  it('mediaKind распознаёт типы медиа', () => {
    expect(mediaKind('.jpeg')).toBe('image');
    expect(mediaKind('.m4a')).toBe('media');
    expect(mediaKind('.zip')).toBe('archive');
    expect(mediaKind('.pdf')).toBeNull();
    expect(mediaKind('')).toBeNull();
  });
});
