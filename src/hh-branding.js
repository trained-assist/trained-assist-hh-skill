'use strict';
// Настройки оформления агентства (R5: бренд — это настройки, не копия реализации).
//
// Один JSON с палитрой, шрифтом и логотипом применяется к клиентскому HTML/PDF.
// По умолчанию — нейтральная палитра, идентичная действующей, поэтому агентство
// без branding.json получает те же цвета, что и сейчас.

const fs = require('fs');
const path = require('path');

const NEUTRAL = {
  primary: '#1f4e8c',
  accent: '#1e7a46',
  ink: '#1c2430',
  mute: '#5d6b7c',
  line: '#dfe4ea',
  surface: '#f6f8fb',
  font: "-apple-system,'Segoe UI',Roboto,Arial,sans-serif",
  logo_data_uri: null,
  agency_name: null,
};

const HEX = /^#[0-9a-f]{6}$/i;

// Только безопасные подмножества: hex-цвет и data:image. Внешний URL в CSS/HTML
// не принимаем — иначе настройка агентства становится вектором подгрузки.
function sanitizeColor(value, fallback) {
  return HEX.test(String(value || '').trim()) ? String(value).trim() : fallback;
}

// data:image допускаем только для картинок (png/jpeg/webp/gif) — svg может нести скрипт.
function sanitizeLogo(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  if (/^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(s)) return s;
  return null;
}

// Шрифт — только список семейств через запятую. Всё остальное (двоеточие, скобки,
// точки с запятой, фигурные скобки, угловые скобки) вырезается: иначе через
// настройку агентства в CSS вырывается произвольное правило.
function sanitizeFont(value, fallback) {
  const s = String(value || '').trim();
  if (!s) return fallback;
  const cleaned = s.replace(/[;{}<>()\[\]:=]/g, ' ').replace(/\s+/g, ' ').trim();
  // Оставляем только буквы, цифры, пробелы, запятые, дефисы и кавычки — то, из чего
  // состоит валидный font-family.
  const families = cleaned.split(',').map(f => f.replace(/[^a-z0-9\s-]/gi, '').trim()).filter(Boolean);
  return families.length ? families.join(', ') : fallback;
}

function sanitizeAgencyName(value) {
  const s = String(value || '').trim();
  return s ? s.slice(0, 120) : null;
}

// Читает contexts/hh/branding.json из профиля пользователя. Любой мусор в файле
// не ломает документ — невалидные поля заменяются нейтральными значениями.
function loadBranding(workDir) {
  const base = { ...NEUTRAL };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(workDir, 'contexts', 'hh', 'branding.json'), 'utf8'));
  } catch { return base; }
  if (!raw || typeof raw !== 'object') return base;

  return {
    primary: sanitizeColor(raw.primary, base.primary),
    accent: sanitizeColor(raw.accent, base.accent),
    ink: sanitizeColor(raw.ink, base.ink),
    mute: sanitizeColor(raw.mute, base.mute),
    line: sanitizeColor(raw.line, base.line),
    surface: sanitizeColor(raw.surface, base.surface),
    font: sanitizeFont(raw.font, base.font),
    logo_data_uri: sanitizeLogo(raw.logo_data_uri),
    agency_name: sanitizeAgencyName(raw.agency_name),
  };
}

function saveBranding(workDir, branding) {
  const file = path.join(workDir, 'contexts', 'hh', 'branding.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const clean = {
    primary: sanitizeColor(branding?.primary, NEUTRAL.primary),
    accent: sanitizeColor(branding?.accent, NEUTRAL.accent),
    ink: sanitizeColor(branding?.ink, NEUTRAL.ink),
    mute: sanitizeColor(branding?.mute, NEUTRAL.mute),
    line: sanitizeColor(branding?.line, NEUTRAL.line),
    surface: sanitizeColor(branding?.surface, NEUTRAL.surface),
    font: sanitizeFont(branding?.font, NEUTRAL.font),
    logo_data_uri: sanitizeLogo(branding?.logo_data_uri),
    agency_name: sanitizeAgencyName(branding?.agency_name),
  };
  fs.writeFileSync(file, JSON.stringify(clean, null, 2), { mode: 0o600 });
  return clean;
}

function brandingPath(workDir) {
  return path.join(workDir, 'contexts', 'hh', 'branding.json');
}

module.exports = {
  NEUTRAL,
  loadBranding,
  saveBranding,
  brandingPath,
  sanitizeColor,
  sanitizeLogo,
  sanitizeFont,
};