'use strict';
// PDF по кнопке (#91): HTML → PDF через headless Chrome/Chromium.
// Движок выбирается/env: HH_CHROME_PATH (полный путь) или первый существующий из
// кандиндатов. Ключевой флаг — --no-pdf-header-footer (без колонтитулов Chrome).
// Нет бинаря → {ok:false} со скользящей подсказкой «печатай из браузера» (print-CSS
// у документов уже есть). Спавн: фиксированный бинарь, argv без shell (гард L3,
// allowlist в tests/guards/guards.test.cjs).
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'chrome',
];
const PDF_TIMEOUT_MS = 30_000;

function findChrome() {
  const forced = process.env.HH_CHROME_PATH;
  const list = forced ? [forced, ...CHROME_CANDIDATES] : CHROME_CANDIDATES;
  for (const bin of list) {
    try {
      const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 });
      if (!r.error && r.status === 0) return bin;
    } catch { /* next */ }
  }
  return null;
}

function engineOff() {
  return process.env.HH_PDF_ENGINE === 'off';
}

// html → pdf. Возвращает Buffer или {ok:false, error}.
function htmlToPdf(html) {
  if (engineOff()) return { ok: false, error: 'PDF-движок отключён (HH_PDF_ENGINE=off).' };
  const bin = findChrome();
  if (!bin) return { ok: false, error: 'На сервере нет Chrome/Chromium — открой HTML-версию и используй печать браузера (CSS уже A4).' };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-pdf-'));
  const htmlPath = path.join(dir, 'doc.html');
  const pdfPath = path.join(dir, 'doc.pdf');
  try {
    fs.writeFileSync(htmlPath, html, 'utf8');
    const r = spawnSync(bin, [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      `file://${htmlPath}`,
    ], { encoding: 'utf8', timeout: PDF_TIMEOUT_MS });
    if (r.error) return { ok: false, error: `Chrome не запустился: ${r.error.message}` };
    if (r.status !== 0 || !fs.existsSync(pdfPath)) {
      return { ok: false, error: `Chrome завершился с кодом ${r.status}: ${String(r.stderr || '').slice(0, 200)}` };
    }
    return { ok: true, pdf: fs.readFileSync(pdfPath) };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

module.exports = { htmlToPdf, findChrome, engineOff, CHROME_CANDIDATES };
