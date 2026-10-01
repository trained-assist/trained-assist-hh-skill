'use strict';
// /hh/vacancy/new — сборка портрета кандидата из входных материалов (#85, эпик #83):
// место «положить информацию по вакансии» → donut-индикатор полноты → «Сгенерировать АТС».
// Данные и логика — те же MCP-тулы hh_portrait_*, что и у агента/бота (#84/#86).
const { escHtml } = require('./hh-nav');
const { SECTIONS, BLOCK_FIELDS, ARRAY_FIELDS } = require('./hh-portrait');

const CSS = `*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f1f5f9;color:#1e293b}
main{max-width:1040px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;font-weight:700;margin-bottom:4px}
h3{font-size:15px;font-weight:700;margin-bottom:10px;color:#334155}
.sub{font-size:13px;color:#64748b;margin-bottom:20px}
.card{background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.08);padding:16px 20px;margin-bottom:12px}
.hint{font-size:12px;color:#64748b;margin-top:6px}
textarea,input[type=text],select{width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;font:14px/1.45 inherit;background:#fff;color:inherit}
textarea{resize:vertical;min-height:64px}
label{display:block;font-size:12px;font-weight:600;color:#64748b;margin:10px 0 3px}
.btn{display:inline-block;font:600 14px/1 inherit;font-family:inherit;padding:9px 14px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;color:inherit;cursor:pointer}
.btn.primary{background:#4f46e5;border-color:#4f46e5;color:#fff}
.btn.ok{background:#16a34a;border-color:#16a34a;color:#fff}
.btn[disabled]{opacity:.45;cursor:not-allowed}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}
@media(max-width:720px){.grid2{grid-template-columns:1fr}}
.drop{border:2px dashed #cbd5e1;border-radius:10px;padding:14px;text-align:center;color:#64748b;font-size:13px;background:#f8fafc}
.drop.over{border-color:#4f46e5;color:#4f46e5;background:#eef2ff}
.gauge{display:flex;gap:24px;align-items:center;flex-wrap:wrap}
.gauge .legend{flex:1;min-width:260px}
.sec{display:flex;align-items:center;gap:8px;font-size:13px;padding:3px 0}
.sec .name{flex:1}
.sec .pct{font-weight:700;min-width:38px;text-align:right}
.sec .bar{width:90px;height:7px;border-radius:4px;background:#e2e8f0;overflow:hidden}
.sec .bar i{display:block;height:100%;background:#4f46e5}
.miss{margin-top:10px;font-size:12px;color:#b45309;max-height:150px;overflow:auto}
.miss li{margin-left:16px;list-style:✗}
.has .sec{color:#1e293b}
.alert{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;font-size:13px;padding:10px 14px;border-radius:8px;margin-bottom:12px}
#overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);display:none;align-items:center;justify-content:center;z-index:9999}
#overlay .box{background:#fff;color:#1e293b;border-radius:12px;padding:24px 28px;font-size:15px;font-weight:600;text-align:center;max-width:340px}
#overlay .box p{font-weight:400;font-size:13px;color:#64748b;margin-top:8px}
.toast{position:fixed;top:20px;right:20px;padding:10px 18px;border-radius:8px;background:#dc2626;color:#fff;font-size:14px;font-weight:600;z-index:10000;display:none}
@media(prefers-color-scheme:dark){body{background:#0f172a;color:#e2e8f0}.card{background:#1e293b;box-shadow:none}h3{color:#cbd5e1}textarea,input[type=text],select{background:#0f172a;border-color:#334155}.btn{background:#1e293b;color:#e2e8f0;border-color:#334155}.btn.primary{background:#4f46e5;color:#fff}.drop{background:#1e293b;border-color:#334155}.sub,.hint,label{color:#94a3b8}}`;

// Подписи полей — из той же схемы, что и индикатор полноты (форма-эталон клиента).
const FIELD_LABELS = (() => {
  const m = {};
  for (const s of SECTIONS) for (const [dotted, label] of s.fields) m[dotted] = label;
  m['vacancy.headcount'] = 'Количество вакансий';
  return m;
})();

const BLOCK_TITLES = {
  company: 'О компании (работодателе)',
  vacancy: 'Информация о вакансии',
  requirements: 'Требования к кандидату',
};

function donutSvg(completeness) {
  const secs = completeness.sections;
  const totalW = secs.reduce((s, x) => s + x.weight, 0) || 1;
  const R = 70;
  const C = 2 * Math.PI * R;
  const GAP = 2; // градусы между сегментами
  let acc = 0;
  const rings = secs.map(s => {
    const sweep = (s.weight / totalW) * 360;
    const seg = Math.max(((sweep - GAP) / 360) * C, 1);
    const fill = (seg * s.percent) / 100;
    const rot = acc - 90 + GAP / 2;
    acc += sweep;
    const base = `<circle cx="90" cy="90" r="${R}" fill="none" stroke="#e2e8f0" stroke-width="20" stroke-dasharray="${seg.toFixed(2)} ${C.toFixed(2)}" transform="rotate(${rot.toFixed(2)} 90 90)"/>`;
    const fillArc = fill > 0.5
      ? `<circle cx="90" cy="90" r="${R}" fill="none" stroke="#4f46e5" stroke-width="20" stroke-dasharray="${fill.toFixed(2)} ${C.toFixed(2)}" transform="rotate(${rot.toFixed(2)} 90 90)"/>`
      : '';
    return base + fillArc;
  }).join('');
  return `<svg viewBox="0 0 180 180" width="210" height="210" role="img" aria-label="Полнота портрета ${completeness.percent}%">
${rings}
<text x="90" y="86" text-anchor="middle" font-size="34" font-weight="700" fill="currentColor">${completeness.percent}%</text>
<text x="90" y="108" text-anchor="middle" font-size="11" fill="#64748b">портрет</text>
</svg>`;
}

function legendHtml(completeness) {
  const rows = completeness.sections.map(s => `<div class="sec">
  <span class="name">${escHtml(s.label)}</span>
  <span class="bar"><i style="width:${s.percent}%"></i></span>
  <span class="pct">${s.percent}%</span>
  <span style="color:#94a3b8;font-size:11px">${s.filled}/${s.total}</span>
</div>`).join('');
  const missing = completeness.missing_flat.length
    ? `<ul class="miss">${completeness.missing_flat.map(m => `<li>${escHtml(m)}</li>`).join('')}</ul>`
    : '<p class="hint" style="color:#16a34a">✓ Всё заполнено — портрет готов на 100%.</p>';
  return `<div class="legend">${rows}${missing}</div>`;
}

function fieldControl(dotted, value) {
  const [block, field] = [dotted.slice(0, dotted.indexOf('.')), dotted.slice(dotted.indexOf('.') + 1)];
  const common = `data-block="${block}" data-field="${field}"`;
  if (field === 'photo_required') {
    const v = value === true ? 'true' : value === false ? 'false' : '';
    return `<select ${common} id="f-${dotted}">
<option value="">— не указано —</option>
<option value="true"${v === 'true' ? ' selected' : ''}>да, обязательно</option>
<option value="false"${v === 'false' ? ' selected' : ''}>нет</option></select>`;
  }
  if (ARRAY_FIELDS.has(dotted)) {
    const lines = Array.isArray(value) ? value.join('\n') : '';
    const rows = Math.min(Math.max((lines.match(/\n/g) || []).length + 1, 2), 8);
    return `<textarea ${common} data-array="1" id="f-${dotted}" rows="${rows}">${escHtml(lines)}</textarea>`;
  }
  const scalar = value === null || value === undefined ? '' : String(value);
  return `<input type="text" ${common} id="f-${dotted}" value="${escHtml(scalar)}">`;
}

function blockFormHtml(block) {
  const fields = BLOCK_FIELDS[block];
  const inputs = fields.map(f => {
    const dotted = `${block}.${f}`;
    return `<div><label for="f-${dotted}">${escHtml(FIELD_LABELS[dotted] || f)}</label>${fieldControl(dotted, null)}</div>`;
  }).join('');
  return `<div><h3>${escHtml(BLOCK_TITLES[block])}</h3><div class="grid2">${inputs}</div></div>`;
}

// Значения полей подставляются клиентом из INIT (jsonForScript), чтобы форма
// редактировалась тем же кодом, что и рендерит сервер.
function vacancyNewPageHtml({ username, token, vacancyId = '', portrait = null, completeness = null, error = null }) {
  const qs = new URLSearchParams({ username, token: token || '' });
  if (vacancyId) qs.set('vacancy_id', vacancyId);
  const q = qs.toString();

  const gaugeCard = completeness ? `<div class="card" id="gauge-card">
<h3>Полнота портрета</h3>
<div class="gauge">
${donutSvg(completeness)}
${legendHtml(completeness)}
</div>
</div>` : '';

  const editorCard = portrait ? `<div class="card" id="editor-card">
<div class="row" style="justify-content:space-between;margin-bottom:6px">
<h3 style="margin:0">Портрет — редактирование</h3>
<button class="btn ok" id="btn-save" type="button">Сохранить правки</button>
</div>
<p class="hint">Пустые поля — то, чего не хватает (см. список выше). Сохранил — полнота пересчитается.</p>
<form id="portrait-form">
${blockFormHtml('company')}
<hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0">
${blockFormHtml('vacancy')}
<hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0">
${blockFormHtml('requirements')}
</form>
</div>
<div class="card">
<button class="btn primary" id="btn-ats" type="button" style="width:100%;padding:12px">⚙ Сгенерировать АТС →</button>
<p class="hint">Соберёт критерии must-have/nice-to-have из портрета и откроет «ATS воронку» на проверке (черновик — живым сделаете сохранением).</p>
</div>` : '';

  const buildLabel = portrait ? '↻ Пересобрать портрет' : '🧩 Собрать портрет';
  const buildHint = portrait
    ? 'Пересборка заменит текущий портрет по вставленным материалам.'
    : 'Из текста вакансии, переписки с клиентом и файлов. Любое сообщение с требованиями — тоже источник.';

  const body = `<main>
<h1>Новая вакансия — портрет кандидата</h1>
<p class="sub">${escHtml(username)}${vacancyId ? ` · вакансия ${escHtml(vacancyId)}` : ' · вакансия из активной (или новая, если активной нет)'}</p>
${error ? `<div class="alert">${escHtml(error)}</div>` : ''}
<div class="card">
<h3>Информация по вакансии</h3>
<label for="src-vacancy">Текст вакансии / бриф</label>
<textarea id="src-vacancy" rows="7" placeholder="Вставь текст вакансии или бриф от клиента…"></textarea>
<label for="src-corr">Переписка с клиентом (сообщения по вакансии)</label>
<textarea id="src-corr" rows="6" placeholder="Вставь переписку — можно целиком, несколько сообщений подряд…"></textarea>
<label for="src-files">Файлы (txt/md/docx/pdf)</label>
<div class="drop" id="drop">Перетащи файлы сюда или <input type="file" id="files" multiple accept=".txt,.md,.markdown,.csv,.text,.docx,.pdf" style="display:none"><button class="btn" type="button" id="btn-files">выбрать файлы</button></div>
<textarea id="src-files" rows="4" placeholder="Текст загруженных файлов появится здесь (можно править)"></textarea>
<div class="row" style="margin-top:14px">
<button class="btn primary" id="btn-build" type="button">${buildLabel}</button>
<span class="hint">${buildHint}</span>
</div>
</div>
${gaugeCard}
${editorCard}
</main>
<div id="overlay"><div class="box">Собираю портрет…<p>LLM разбирает материалы и заполняет разрезы. Обычно 10–60 секунд.</p></div></div>
<div class="toast" id="toast"></div>
<script>
(function () {
  var AUTH = ${JSON.stringify({ username, token: token || '' }).replace(/</g, '\\u003c')};
  var HAS_PORTRAIT = ${portrait ? 'true' : 'false'};
  var INIT = ${portrait ? JSON.stringify({ company: portrait.company, vacancy: portrait.vacancy, requirements: portrait.requirements }).replace(/</g, '\\u003c') : 'null'};
  var SRC_KEY = 'hh-portrait-src:' + AUTH.username;
  var $ = function (id) { return document.getElementById(id); };

  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.style.display = 'block';
    setTimeout(function () { t.style.display = 'none'; }, 6000);
  }
  function overlay(on) { $('overlay').style.display = on ? 'flex' : 'none'; }
  function qs(extra) {
    var p = new URLSearchParams(Object.assign({}, AUTH, extra || {}));
    return p.toString();
  }
  function pageUrl(vacancyId) { return 'vacancy-new?' + qs(vacancyId ? { vacancy_id: vacancyId } : {}); }

  // Черновики ввода переживают перезагрузку — пересборка не теряет вставленный текст.
  try {
    var saved = JSON.parse(localStorage.getItem(SRC_KEY) || 'null');
    if (saved) {
      $('src-vacancy').value = saved.v || '';
      $('src-corr').value = saved.c || '';
      $('src-files').value = saved.f || '';
    }
  } catch (e) {}
  function persistSrc() {
    try {
      localStorage.setItem(SRC_KEY, JSON.stringify({ v: $('src-vacancy').value, c: $('src-corr').value, f: $('src-files').value }));
    } catch (e) {}
  }
  ['src-vacancy', 'src-corr', 'src-files'].forEach(function (id) { $(id).addEventListener('input', persistSrc); });

  // ── Файлы → серверный разбор (docx/pdf/txt) → текст в textarea ──
  $('btn-files').addEventListener('click', function () { $('files').click(); });
  $('files').addEventListener('change', function () { handleFiles(this.files); this.value = ''; });
  var drop = $('drop');
  drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
  drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('over'); handleFiles(e.dataTransfer.files); });

  function b64(buf) {
    var bytes = new Uint8Array(buf), s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    overlay(true);
    var chain = Promise.resolve();
    files.forEach(function (f) {
      chain = chain.then(function () {
        return f.arrayBuffer().then(function (buf) {
          return fetch('portrait-file', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: AUTH.username, token: AUTH.token, filename: f.name, data_base64: b64(buf) }),
            signal: AbortSignal.timeout(60000),
          }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
            .then(function (x) {
              var ta = $('src-files');
              if (!x.ok || !x.d.text) { ta.value += '\\n--- ' + f.name + ': ' + (x.d.error || 'не удалось прочитать') + ' ---\\n'; return; }
              ta.value += (ta.value ? '\\n' : '') + '--- ' + f.name + ' ---\\n' + x.d.text + '\\n';
              persistSrc();
            });
        });
      });
    });
    chain.then(function () { overlay(false); }).catch(function (e) { overlay(false); toast(e.message); });
  }

  // ── Действия портрета → POST /hh/portrait → hh_portrait_* ──
  function callPortrait(action, extra) {
    var body = Object.assign({ username: AUTH.username, token: AUTH.token, vacancy_id: ${JSON.stringify(vacancyId || '')}, action: action }, extra || {});
    return fetch('portrait', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); });
  }

  $('btn-build').addEventListener('click', function () {
    var sources = [];
    var v = $('src-vacancy').value.trim();
    var c = $('src-corr').value.trim();
    var f = $('src-files').value.trim();
    if (v) sources.push({ type: 'vacancy', text: v });
    if (c) sources.push({ type: 'correspondence', text: c });
    if (f) sources.push({ type: 'file', text: f });
    if (!sources.length) { toast('Вставь текст вакансии, переписку или файлы'); return; }
    var btn = this; btn.disabled = true; overlay(true);
    callPortrait('extract', { sources: sources, force: HAS_PORTRAIT })
      .then(function (x) {
        overlay(false); btn.disabled = false;
        if (!x.ok || x.d.error) { toast(x.d.error || 'Не удалось собрать портрет'); return; }
        location.href = pageUrl(x.d.vacancy_id);
      })
      .catch(function (e) { overlay(false); btn.disabled = false; toast(e.message); });
  });

  if (HAS_PORTRAIT) {
    // Заполняем форму значениями портрета (INIT встроен в IIFE).
    ['company', 'vacancy', 'requirements'].forEach(function (block) {
      var data = (INIT || {})[block] || {};
      Object.keys(data).forEach(function (field) {
        var el = document.querySelector('[data-block="' + block + '"][data-field="' + field + '"]');
        if (!el) return;
        var val = data[field];
        if (el.dataset.array !== undefined) el.value = Array.isArray(val) ? val.join('\\n') : (val == null ? '' : String(val));
        else if (el.tagName === 'SELECT') el.value = val === true ? 'true' : val === false ? 'false' : '';
        else el.value = val == null ? '' : String(val);
      });
    });

    $('btn-save').addEventListener('click', function () {
      var patch = { company: {}, vacancy: {}, requirements: {} };
      document.querySelectorAll('[data-block]').forEach(function (el) {
        var b = el.dataset.block, f = el.dataset.field;
        if (el.tagName === 'SELECT') patch[b][f] = el.value === '' ? null : el.value === 'true';
        else if (el.dataset.array !== undefined) patch[b][f] = el.value.split('\\n').map(function (s) { return s.trim(); }).filter(Boolean);
        else { var t = el.value.trim(); patch[b][f] = t === '' ? null : t; }
      });
      var btn = this; btn.disabled = true; btn.textContent = 'Сохраняю…';
      callPortrait('update', { patch: patch })
        .then(function (x) {
          btn.disabled = false; btn.textContent = 'Сохранить правки';
          if (!x.ok || x.d.error) { toast(x.d.error || 'Не удалось сохранить'); return; }
          location.reload();
        })
        .catch(function (e) { btn.disabled = false; btn.textContent = 'Сохранить правки'; toast(e.message); });
    });

    $('btn-ats').addEventListener('click', function () {
      var btn = this; btn.disabled = true; btn.textContent = 'Генерирую…';
      callPortrait('to_ats', {})
        .then(function (x) {
          btn.disabled = false; btn.textContent = '⚙ Сгенерировать АТС →';
          if (!x.ok || x.d.error) { toast(x.d.error || 'Не удалось собрать ATS'); return; }
          var vid = x.d.vacancy_id && x.d.vacancy_id !== 'draft' ? { vacancy_id: x.d.vacancy_id } : {};
          location.href = 'ats-editor?' + qs(vid);
        })
        .catch(function (e) { btn.disabled = false; btn.textContent = '⚙ Сгенерировать АТС →'; toast(e.message); });
    });
  }
})();
</script>`;

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Портрет вакансии</title>
<style>${CSS}</style>
</head><body>
${body}
</body></html>`;
}

module.exports = { vacancyNewPageHtml, donutSvg, FIELD_LABELS };
