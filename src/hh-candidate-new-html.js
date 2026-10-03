'use strict';
// /hh/candidate-new — большое окно добавления кандидата (#87, эпик #83):
// пачка файлов (резюме/письма/переписка/интервью/портфолио/фото) → классификация
// типа → манифест → «сжать всё в профиль» (LLM-выжимка в разрезы).
const { escHtml } = require('./hh-nav');
const { TYPE_LABELS } = require('./hh-doc-classify');

const CSS = `*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f1f5f9;color:#1e293b}
main{max-width:960px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;font-weight:700;margin-bottom:4px}
h3{font-size:15px;font-weight:700;margin-bottom:10px;color:#334155}
.sub{font-size:13px;color:#64748b;margin-bottom:20px}
.card{background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.08);padding:16px 20px;margin-bottom:12px}
.hint{font-size:12px;color:#64748b;margin-top:6px}
textarea,input[type=text]{width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;font:14px/1.45 inherit;background:#fff;color:inherit}
label{display:block;font-size:12px;font-weight:600;color:#64748b;margin:10px 0 3px}
.btn{display:inline-block;font:600 14px/1 inherit;font-family:inherit;padding:9px 14px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;color:inherit;cursor:pointer}
.btn.primary{background:#4f46e5;border-color:#4f46e5;color:#fff}
.btn[disabled]{opacity:.45;cursor:not-allowed}
.drop{border:2px dashed #cbd5e1;border-radius:10px;padding:22px;text-align:center;color:#64748b;font-size:13px;background:#f8fafc}
.drop.over{border-color:#4f46e5;color:#4f46e5;background:#eef2ff}
table{width:100%;border-collapse:collapse;font-size:13px}
.tw{overflow-x:auto}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top}
th{font-size:11px;text-transform:uppercase;color:#94a3b8;letter-spacing:.03em}
select{padding:5px 6px;border:1px solid #cbd5e1;border-radius:6px;font:12px inherit;background:#fff}
.badge{display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:#e2e8f0;color:#475569}
.badge.rules{background:#e0e7ff;color:#3730a3}.badge.manual{background:#fef3c7;color:#92400e}.badge.llm{background:#dcfce7;color:#166534}
.reason{color:#94a3b8;font-size:11px}
.linkrow{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end}
.linkrow>div{flex:1;min-width:220px}
.profile{font-size:13px;line-height:1.55}
.profile dt{font-weight:700;color:#475569;margin-top:10px;font-size:12px}
.profile dd{margin:2px 0 0}
#overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);display:none;align-items:center;justify-content:center;z-index:9999}
#overlay .box{background:#fff;color:#1e293b;border-radius:12px;padding:24px 28px;font-size:15px;font-weight:600;text-align:center;max-width:340px}
#overlay .box p{font-weight:400;font-size:13px;color:#64748b;margin-top:8px}
.toast{position:fixed;top:20px;right:20px;padding:10px 18px;border-radius:8px;background:#dc2626;color:#fff;font-size:14px;font-weight:600;z-index:10000;display:none}
@media(prefers-color-scheme:dark){body{background:#0f172a;color:#e2e8f0}.card{background:#1e293b;box-shadow:none}h3{color:#cbd5e1}input[type=text],select{background:#0f172a;border-color:#334155}.btn{background:#1e293b;color:#e2e8f0;border-color:#334155}.btn.primary{background:#4f46e5;color:#fff}.drop{background:#1e293b;border-color:#334155}.sub,.hint,label{color:#94a3b8}th,td{border-color:#334155}.profile dt{color:#94a3b8}}`;

const MEDIA_HINT = {
  image: '📷 картинка — текст не нужен (вставь вручную, если это резюме)',
  media: '🎧 медиа — будет расшифровка',
  archive: '📦 архив — файлы загрузи отдельно',
};

function typeOptions(selected) {
  return Object.entries(TYPE_LABELS)
    .map(([value, label]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${escHtml(label)}</option>`)
    .join('');
}

function docsTableHtml(manifest) {
  const rows = manifest.docs.map(d => `<tr data-doc="${escHtml(d.id)}">
<td>${escHtml(d.filename)}<div class="reason">${d.chars ? `${d.chars} симв. текста` : d.size ? `${Math.round(d.size / 1024)} КБ` : 'ссылка'}${MEDIA_HINT[d.media_kind] && !d.chars ? ` · ${MEDIA_HINT[d.media_kind]}` : ''}${d.extract_error ? ` · ⚠ ${escHtml(d.extract_error)}` : ''}</div>
${d.media_kind === 'media' ? `<button class="btn" type="button" data-transcribe="${escHtml(d.id)}" style="margin-top:6px;padding:5px 10px;font-size:12px">🎙 Расшифровать</button>` : ''}
<button class="btn" type="button" data-delete="${escHtml(d.id)}" title="Удалить документ" style="margin-top:6px;margin-left:6px;padding:5px 9px;font-size:12px">🗑</button></td>
<td><select data-set-type="${escHtml(d.id)}">${typeOptions(d.type)}</select></td>
<td><span class="badge ${escHtml(d.detected_by)}">${escHtml(d.detected_by)}</span><div class="reason">${escHtml(d.reason || '')}</div></td>
<td class="reason">${escHtml(d.added_at.slice(0, 10))}</td>
</tr>`).join('');
  // Таблица шире экрана (длинные имена/select типа) — скролл внутри карточки,
  // а не всей страницы: на 390px иначе уходил весь документ вбок.
  return `<div class="tw"><table>
<thead><tr><th>Документ</th><th>Тип</th><th>Как определён</th><th>Добавлен</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>`;
}

function profileHtml(profile) {
  if (!profile) return '';
  const list = (arr) => (arr && arr.length) ? `<dd>${arr.map(x => escHtml(typeof x === 'string' ? x : JSON.stringify(x))).join('<br>')}</dd>` : '<dd class="reason">—</dd>';
  const exp = (profile.experience || []).map(e =>
    `<dd><b>${escHtml(e.period || '')}</b> — ${escHtml(e.company || '')}${e.role ? `, ${escHtml(e.role)}` : ''}${(e.details || []).length ? `<br><span class="reason">${e.details.map(escHtml).join(' · ')}</span>` : ''}</dd>`).join('') || '<dd class="reason">—</dd>';
  return `<div class="card profile">
<h3>Профиль кандидата <span class="reason">(извлечён ${escHtml(String(profile.extracted_at || '').slice(0, 10))})</span></h3>
<dl>
${profile.name ? `<dt>Имя</dt><dd>${escHtml(profile.name)}</dd>` : ''}
${profile.position ? `<dt>Позиция</dt><dd>${escHtml(profile.position)}</dd>` : ''}
<dt>Опыт работы</dt>${exp}
<dt>Навыки</dt>${list(profile.skills)}
<dt>Образование</dt>${list(profile.education)}
<dt>Языки</dt>${list(profile.languages)}
${profile.location ? `<dt>Локация</dt><dd>${escHtml(profile.location)}</dd>` : ''}
${profile.salary_expectations ? `<dt>Ожидания по деньгам</dt><dd>${escHtml(profile.salary_expectations)}</dd>` : ''}
${profile.summary ? `<dt>Кратко</dt><dd>${escHtml(profile.summary)}</dd>` : ''}
</dl>
</div>`;
}

function candidateNewPageHtml({ username, token, candidateId = '', manifest = null, error = null }) {
  const qs = new URLSearchParams({ username, token: token || '' });
  if (candidateId) qs.set('candidate_id', candidateId);

  const photoHtml = manifest?.photo?.file
    ? `<img src="candidate-photo?${qs.toString()}" alt="" style="width:96px;height:96px;object-fit:cover;border-radius:8px;float:right;margin-left:12px">`
    : '';
  const manifestCard = manifest ? `<div class="card">
<h3>Документы — ${escHtml(manifest.name || manifest.candidate_id)} <span class="reason">(${manifest.docs.length})</span></h3>
${photoHtml}
${manifest.docs.length ? docsTableHtml(manifest) : '<p class="hint">Документов пока нет.</p>'}
<div style="clear:both;padding-top:10px">
<label for="photo-file">Фото кандидата</label>
<input type="file" id="photo-file" accept="image/png,image/jpeg,image/webp,image/gif" style="font-size:12px">
</div>
</div>
<div class="card">
<h3>Оценка кандидата</h3>
<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
<button class="btn primary" id="btn-eval" type="button">▶ Запустить оценку</button>
<span id="eval-status" class="hint"></span>
</div>
<p class="hint">Прогон: must-have/nice-to-have из ATS-конфига → Σ(s×w)/Σ(5w), veto, ранг среди кандидатов вакансии. Займёт 1–3 минуты — не закрывай вкладку.</p>
</div>
<div class="card">
<h3>Документы кандидата</h3>
<div style="display:flex;gap:8px;flex-wrap:wrap">
<a class="btn" href="candidate-report?${escHtml(qs.toString())}&which=profile">📄 Профиль (просмотр)</a>
<a class="btn" href="candidate-report?${escHtml(qs.toString())}&which=profile&format=md">⬇ MD</a>
<a class="btn" href="candidate-report.pdf?${escHtml(qs.toString())}&which=profile">⬇ PDF</a>
<a class="btn" href="candidate-report?${escHtml(qs.toString())}&which=eval">📊 Чистая оценка (просмотр)</a>
<a class="btn" href="candidate-report?${escHtml(qs.toString())}&which=eval&format=md">⬇ MD</a>
<a class="btn" href="candidate-report.pdf?${escHtml(qs.toString())}&which=eval">⬇ PDF</a>
</div>
<p class="hint">PDF генерируется по кнопке; если на сервере нет Chrome — откроется подсказка печать из HTML (A4 без колонтитулов).</p>
</div>
<div class="card">
<h3>Документы кандидата — канон v2</h3>
<div style="display:flex;gap:8px;flex-wrap:wrap">
<a class="btn" href="candidate-report-v2?${escHtml(qs.toString())}&which=profile">📄 Профиль v2 (просмотр)</a>
<a class="btn" href="candidate-report-v2?${escHtml(qs.toString())}&which=profile&format=md">⬇ MD</a>
<a class="btn" href="candidate-report-v2.pdf?${escHtml(qs.toString())}&which=profile">⬇ PDF</a>
<a class="btn" href="candidate-report-v2?${escHtml(qs.toString())}&which=eval">📊 Оценка v2 (просмотр)</a>
<a class="btn" href="candidate-report-v2?${escHtml(qs.toString())}&which=eval&format=md">⬇ MD</a>
<a class="btn" href="candidate-report-v2.pdf?${escHtml(qs.toString())}&which=eval">⬇ PDF</a>
</div>
<p class="hint">Канон v2 (#120): шкала 1–5, канонический evaluation_id, брендированный клиентский профиль, внутренняя оценка с экспертной проверкой. Клиентский профиль не содержит внутренних баллов и рисков.</p>
</div>` : '';

  const profileCard = manifest && manifest.profile ? profileHtml(manifest.profile) : '';

  const body = `<main>
<h1>Новый кандидат</h1>
<p class="sub">${escHtml(username)}${manifest ? ` · <code>${escHtml(manifest.candidate_id)}</code>` : ' · брось файлы — тип определится сам'}</p>
${error ? `<div class="card" style="background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;font-size:13px">${escHtml(error)}</div>` : ''}
<div class="card">
<h3>Материалы кандидата</h3>
<label for="cand-name">Имя кандидата${manifest ? '' : ' (необязательно — можно бросить файлы и указать позже)'}</label>
<div class="linkrow">
<div><input type="text" id="cand-name" value="${manifest ? escHtml(manifest.name || '') : ''}" placeholder="Например: Стогниенко Анна"></div>
${manifest ? '<button class="btn" type="button" id="btn-rename" style="margin-bottom:1px">Сохранить имя</button>' : ''}
</div>
<div class="drop" id="drop" style="margin-top:10px">
Перетащи файлы: резюме, сопроводительное, переписка, расшифровка интервью, портфолио, фото<br><br>
<input type="file" id="files" multiple accept=".txt,.md,.csv,.text,.docx,.pdf,.mp4,.mov,.m4a,.wav,.mp3,.png,.jpg,.jpeg,.webp,.zip" style="display:none">
<button class="btn" type="button" id="btn-files">выбрать файлы</button>
<span class="hint">До 256 МБ: файлы тяжелее 1 МБ уходят в Google Storage ядра, без лимита base64. Ещё тяжелее — ссылкой на Drive ниже.</span>
</div>
<div class="linkrow" style="margin-top:12px">
<div><label for="link-url">Ссылка на материал (видеоинтервью на Google Drive)</label>
<input type="text" id="link-url" placeholder="https://drive.google.com/file/d/.../view"></div>
<div style="flex:0 0 auto"><label for="link-type">Тип</label><select id="link-type">${typeOptions('interview')}</select></div>
<button class="btn" type="button" id="btn-link" style="margin-bottom:1px">Добавить ссылку</button>
</div>
<label for="paste-text">Вставить текстом (если резюме — картинка/скан, или просто есть текст)</label>
<div class="linkrow">
<div><textarea id="paste-text" rows="4" placeholder="Вставь текст резюме/письма/переписки…"></textarea></div>
<div style="flex:0 0 auto"><label for="paste-type">Тип</label><select id="paste-type">${typeOptions('resume')}</select></div>
<button class="btn" type="button" id="btn-paste" style="margin-bottom:1px">Добавить текстом</button>
</div>
<div class="row" style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
${manifest ? `<button class="btn primary" id="btn-profile" type="button">🧠 Извлечь профиль</button>` : ''}
${manifest && !manifest.profile ? '<span class="hint">Профиль — LLM-выжимка всех документов в разрезы (опыт/навыки/языки/ожидания).</span>' : ''}
</div>
</div>
${manifestCard}
${profileCard}
</main>
<div id="overlay"><div class="box">Обрабатываю…<p id="overlay-note">Извлекаю текст и определяю тип документа.</p></div></div>
<div class="toast" id="toast"></div>
<script>
(function () {
  var AUTH = ${JSON.stringify({ username, token: token || '' }).replace(/</g, '\\u003c')};
  var CAND = ${JSON.stringify(candidateId || '')};
  var $ = function (id) { return document.getElementById(id); };
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.style.display = 'block'; setTimeout(function () { t.style.display = 'none'; }, 6000); }
  function overlay(on, note) { $('overlay').style.display = on ? 'flex' : 'none'; if (note) $('overlay-note').textContent = note; }
  function qs(extra) { var p = new URLSearchParams(Object.assign({}, AUTH, extra || {})); return p.toString(); }
  function b64(buf) {
    var bytes = new Uint8Array(buf), s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function post(path, body) {
    return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ username: AUTH.username, token: AUTH.token }, body)), signal: AbortSignal.timeout(120000) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); });
  }

  $('btn-files').addEventListener('click', function () { $('files').click(); });
  $('files').addEventListener('change', function () { handleFiles(this.files); this.value = ''; });
  var drop = $('drop');
  drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
  drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('over'); handleFiles(e.dataTransfer.files); });

  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    var nameEl = $('cand-name');
    // Имя больше не блокирует загрузку (#107-UX): пустое → «Кандидат», правится потом
    overlay(true, 'Загружаю и классифицирую документы…');
    var chain = Promise.resolve(); var gotId = CAND;
    files.forEach(function (f) {
      chain = chain.then(function () {
        if (f.size > 256 * 1048576) {
          toast(f.name + ' — больше 256 МБ, добавь ссылкой на Google Drive'); return;
        }
        var useRaw = f.size > 1048576; // >1 МБ — сырыми байтами в GCS (#105), без base64; старые лимиты 15/30 МБ сняты
        var upload = useRaw
          ? function (buf) {
              var q = new URLSearchParams({ username: AUTH.username, token: AUTH.token, filename: f.name });
              if (gotId) q.set('candidate_id', gotId);
              else if (nameEl && nameEl.value.trim()) q.set('candidate_name', nameEl.value.trim());
              var base64Fallback = function () {
                return post('candidate-doc', {
                  candidate_id: gotId || undefined,
                  candidate_name: (!gotId && nameEl) ? nameEl.value.trim() : undefined,
                  filename: f.name, data_base64: b64(buf),
                });
              };
              return fetch('candidate-doc-raw?' + q.toString(), {
                method: 'POST',
                headers: { 'Content-Type': f.type || 'application/octet-stream' },
                body: new Uint8Array(buf),
                signal: AbortSignal.timeout(300000),
              }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
                .then(function (x) {
                  // Любой отказ сырого пути (ядро старое/недоступно/5xx) — терпимо
                  // падаем на base64, если размер в его пределах
                  if ((!x.ok || (x.d && x.d.error)) && f.size <= 31457280) return base64Fallback();
                  return x;
                })
                .catch(function (e) {
                  if (f.size > 31457280) throw e; // >30 МБ base64 не спасёт
                  return base64Fallback();
                });
            }
          : function (buf) {
              return post('candidate-doc', {
                candidate_id: gotId || undefined,
                candidate_name: (!gotId && nameEl) ? nameEl.value.trim() : undefined,
                filename: f.name, data_base64: b64(buf),
              });
            };
        return f.arrayBuffer().then(upload).then(function (x) {
          if (!x.ok || x.d.error) { toast(x.d.error || ('Не удалось: ' + f.name)); return; }
          if (!gotId) { gotId = x.d.candidate_id; CAND = gotId; history.replaceState(null, '', 'candidate-new?' + qs({ candidate_id: gotId })); }
        });
      });
    });
    chain.then(function () { if (gotId) location.href = 'candidate-new?' + qs({ candidate_id: gotId }); else overlay(false); })
      .catch(function (e) { overlay(false); toast(e.message); });
  }

  var linkBtn = $('btn-link');
  if (linkBtn) linkBtn.addEventListener('click', function () {
    var url = $('link-url').value.trim();
    if (!url) { toast('Вставь ссылку'); return; }
    var nameEl = $('cand-name');
    overlay(true, 'Добавляю ссылку…');
    post('candidate-doc', {
      candidate_id: CAND || undefined,
      candidate_name: (!CAND && nameEl) ? nameEl.value.trim() : undefined,
      filename: url, source_url: url, type: $('link-type').value,
    }).then(function (x) {
      if (!x.ok || x.d.error) { overlay(false); toast(x.d.error || 'Не удалось'); return; }
      location.href = 'candidate-new?' + qs({ candidate_id: x.d.candidate_id });
    }).catch(function (e) { overlay(false); toast(e.message); });
  });

  document.querySelectorAll('[data-set-type]').forEach(function (sel) {
    sel.addEventListener('change', function () {
      overlay(true, 'Меняю тип…');
      post('candidate-docs', { candidate_id: CAND, action: 'set_type', doc_id: sel.dataset.setType, type: sel.value })
        .then(function () { location.reload(); })
        .catch(function (e) { overlay(false); toast(e.message); });
    });
  });

  var pasteBtn = $('btn-paste');
  if (pasteBtn) pasteBtn.addEventListener('click', function () {
    var ta = $('paste-text');
    var v = ta.value.trim();
    if (!v) { toast('Вставь текст'); return; }
    var nameEl = $('cand-name');
    overlay(true, 'Добавляю текст…');
    post('candidate-doc', {
      candidate_id: CAND || undefined,
      candidate_name: (!CAND && nameEl) ? nameEl.value.trim() : undefined,
      text: v, type: $('paste-type').value, filename: 'вставлено-вручную.txt',
    }).then(function (x) {
      if (!x.ok || x.d.error) { overlay(false); toast(x.d.error || 'Не удалось добавить'); return; }
      location.href = 'candidate-new?' + qs({ candidate_id: x.d.candidate_id });
    }).catch(function (e) { overlay(false); toast(e.message); });
  });

  document.querySelectorAll('[data-delete]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (!confirm('Удалить документ? Файл и его текст будут удалены безвозвратно.')) return;
      btn.disabled = true;
      overlay(true, 'Удаляю документ…');
      post('candidate-doc-delete', { candidate_id: CAND, doc_id: btn.dataset.delete })
        .then(function (x) {
          if (!x.ok || x.d.error) { overlay(false); btn.disabled = false; toast(x.d.error || 'Не удалось удалить'); return; }
          location.reload();
        })
        .catch(function (e) { overlay(false); btn.disabled = false; toast(e.message); });
    });
  });

  document.querySelectorAll('[data-transcribe]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      btn.disabled = true;
      overlay(true, 'Скачиваю запись и отправляю в Deepgram — до нескольких минут…');
      post('interview-transcribe', { candidate_id: CAND, doc_id: btn.dataset.transcribe, slug: CAND })
        .then(function (x) {
          if (!x.ok || x.d.error) { overlay(false); btn.disabled = false; toast(x.d.error || 'Не удалось расшифровать'); return; }
          location.reload();
        })
        .catch(function (e) { overlay(false); btn.disabled = false; toast(e.message); });
    });
  });

  var photoInput = $('photo-file');
  if (photoInput) photoInput.addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (!f) return;
    if (f.size > 5 * 1048576) { toast('Фото больше 5 МБ'); this.value = ''; return; }
    f.arrayBuffer().then(function (buf) {
      return post('candidate-photo', { candidate_id: CAND, data_base64: b64(buf), mime: f.type || 'image/jpeg' });
    }).then(function (x) {
      if (!x.ok || x.d.error) { toast(x.d.error || 'Не удалось загрузить фото'); return; }
      location.reload();
    }).catch(function (e) { toast(e.message); });
  });

  // ── «Запустить оценку» (#90): старт → поллинг 3с → результат ──
  var evalBtn = $('btn-eval');
  if (evalBtn) {
    var pollTimer = null;
    function renderJob(job) {
      var st = $('eval-status');
      if (!st) return;
      if (job.state === 'queued' || job.state === 'running') {
        st.textContent = '⏳ ' + (job.step || job.state) + ' · ' + (job.progress || 0) + '%';
      } else if (job.state === 'done') {
        st.textContent = '✅ ' + (job.percent != null ? job.percent + '% · ' + (job.score10 != null ? job.score10 : '') + ' / 10 · ' + (job.verdict || '') : (job.verdict || 'готово')) +
          (job.comparison ? ' · место ' + job.comparison.place + ' из ' + job.comparison.total : '') +
          (job.spent_minutes ? ' · ' + job.spent_minutes + ' мин' : '');
        evalBtn.disabled = false; evalBtn.textContent = '▶ Запустить оценку';
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        setTimeout(function () { location.reload(); }, 1200);
      } else if (job.state === 'failed') {
        st.textContent = '❌ ' + (job.error || 'оценка не удалась');
        evalBtn.disabled = false; evalBtn.textContent = '▶ Запустить оценку';
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      }
    }
    function poll() {
      fetch('eval-run?' + qs({ candidate_id: CAND }), { signal: AbortSignal.timeout(15000) })
        .then(function (r) { return r.json(); })
        .then(function (x) { if (x.job) renderJob(x.job); })
        .catch(function () { /* тихий ретрай на следующем тике */ });
    }
    evalBtn.addEventListener('click', function () {
      evalBtn.disabled = true; evalBtn.textContent = 'Запускаю…';
      post('eval-run', { candidate_id: CAND }).then(function (x) {
        if (!x.ok || x.d.error) { evalBtn.disabled = false; evalBtn.textContent = '▶ Запустить оценку'; toast(x.d.error || 'Не удалось запустить'); return; }
        renderJob({ state: 'queued', step: 'queued', progress: 0 });
        pollTimer = setInterval(poll, 3000);
      }).catch(function (e) { evalBtn.disabled = false; evalBtn.textContent = '▶ Запустить оценку'; toast(e.message); });
    });
    // страница открыта после запуска — сразу показываем прогресс
    poll();
    pollTimer = setInterval(poll, 3000);
    setTimeout(function () { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }, 300000);
  }

  var renameBtn = $('btn-rename');
  if (renameBtn) renameBtn.addEventListener('click', function () {
    var v = ($('cand-name').value || '').trim();
    if (!v) { toast('Имя не может быть пустым'); return; }
    renameBtn.disabled = true;
    post('candidate-rename', { candidate_id: CAND, name: v })
      .then(function (x) {
        renameBtn.disabled = false;
        if (!x.ok || x.d.error) { toast(x.d.error || 'Не удалось переименовать'); return; }
        toast('Имя сохранено');
      })
      .catch(function (e) { renameBtn.disabled = false; toast(e.message); });
  });

  var profBtn = $('btn-profile');
  if (profBtn) profBtn.addEventListener('click', function () {
    overlay(true, 'LLM сжимает документы в разрезы профиля…');
    post('candidate-docs', { candidate_id: CAND, action: 'extract_profile' })
      .then(function (x) {
        if (!x.ok || x.d.error) { overlay(false); toast(x.d.error || 'Не удалось извлечь профиль'); return; }
        location.reload();
      })
      .catch(function (e) { overlay(false); toast(e.message); });
  });
})();
</script>
</body>`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Новый кандидат</title>
<style>${CSS}</style>
</head><body>
${body}
</html>`;
}

module.exports = { candidateNewPageHtml };
