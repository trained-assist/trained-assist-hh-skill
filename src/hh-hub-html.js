'use strict';
// Server-rendered pages of the recruiting hub v1 (trained-assist-agent#1742):
//   /hh/vacancies — vacancy cards + «▶ Собрать» launch dialog (UX spec §2.1, §3);
//   /hh/plan      — durable-plan status with client polling (UX spec §2.2).
// Links are relative to /hh/ (works for legacy /agent/hh/ too); the shared nav bar is
// injected by hh-nav.js, not rendered here.
const { escHtml } = require('./hh-nav');

const BASE_CSS = `*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f1f5f9;color:#1e293b}
main{max-width:960px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;font-weight:700;margin-bottom:4px}
.sub{font-size:13px;color:#64748b;margin-bottom:20px}
.card{background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.08);padding:16px 20px;margin-bottom:12px}
.badge{display:inline-block;font-size:12px;font-weight:600;padding:2px 10px;border-radius:999px;background:#e2e8f0;color:#475569}
.badge.tracked{background:#dcfce7;color:#166534}.badge.draft_ready{background:#e0e7ff;color:#3730a3}.badge.collecting{background:#fef3c7;color:#92400e}
.btn{display:inline-block;font:600 14px/1 inherit;font-family:inherit;padding:9px 14px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;color:#1e293b;text-decoration:none;cursor:pointer}
.btn.primary{background:#4f46e5;border-color:#4f46e5;color:#fff}
.btn[disabled],.btn.disabled{opacity:.45;cursor:not-allowed;pointer-events:none}
.hint{font-size:12px;color:#64748b;margin-top:6px}
.toast{position:fixed;top:20px;right:20px;padding:10px 18px;border-radius:8px;background:#dc2626;color:#fff;font-size:14px;font-weight:600;z-index:9999;display:none}
@media(prefers-color-scheme:dark){body{background:#0f172a;color:#e2e8f0}.card{background:#1e293b;box-shadow:none}.btn{background:#1e293b;color:#e2e8f0;border-color:#334155}.sub,.hint{color:#94a3b8}}`;

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(typeof ts === 'number' ? ts : String(ts));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// JSON literal safe inside an inline <script>: no `</script>` / `<!--` breakout.
function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function pageShell(title, body) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title>
<style>${BASE_CSS}</style>
</head><body>
${body}
</body></html>`;
}

function vacancyCardHtml(card, q) {
  const vq = `${q}&vacancy_id=${encodeURIComponent(card.id)}`;
  const facts = [];
  if (card.responses != null) facts.push(`Откликов: <b>${card.responses}</b>`);
  if (card.synced_at) facts.push(`синхронизировано ${escHtml(fmtDate(card.synced_at))}`);
  if (card.draft && card.tracked) facts.push(`черновик: ${escHtml(card.draft.status_label)}`);
  const landing = card.draft?.landing_url
    ? ` <a class="btn" href="${escHtml(card.draft.landing_url)}" target="_blank" rel="noopener">Лендинг ↗</a>` : '';
  const untracked = 'title="Вакансия ещё не отслеживается на HH"';
  const funnel = card.tracked
    ? `<a class="btn" href="review?${escHtml(vq)}">Открыть воронку</a>`
    : `<span class="btn disabled" ${untracked}>Открыть воронку</span>`;
  const cold = card.tracked
    ? `<a class="btn" href="proactive?${escHtml(vq)}">Холодный поиск</a>`
    : `<span class="btn disabled" ${untracked}>Холодный поиск</span>`;
  const launchable = !!card.draft?.launchable;
  const launch = launchable
    ? `<button class="btn primary" type="button" data-launch="${escHtml(card.id)}" data-title="${escHtml(card.title)}" data-ats="${card.ats_configured ? '1' : ''}">▶ Собрать</button>`
    : `<button class="btn primary" type="button" disabled title="Доскажи драфт боту: /new_job_post">▶ Собрать</button>`;
  const launchHint = launchable ? '' : '<p class="hint">▶ Собрать станет доступна, когда черновик будет готов — доскажи драфт боту, команда <code>/new_job_post</code>.</p>';
  return `<div class="card vacancy-card" data-vacancy-id="${escHtml(card.id)}">
  <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap">
    <h2 style="font-size:17px;font-weight:600">${escHtml(card.title)}</h2>
    <span class="badge ${escHtml(card.status)}">${escHtml(card.status_label)}</span>
  </div>
  ${facts.length ? `<p class="sub" style="margin:6px 0 0">${facts.join(' · ')}</p>` : ''}
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">${funnel}${cold}${landing}${launch}</div>
  ${launchHint}
</div>`;
}

function vacanciesPageHtml({ username, token, cards = [], lastScoredAt = null, hhConnected = false }) {
  const q = new URLSearchParams({ username, token: token || '' }).toString();
  const list = cards.length
    ? cards.map(c => vacancyCardHtml(c, q)).join('\n')
    : '<div class="card"><p>Вакансий пока нет.</p></div>';
  const body = `<main>
<h1>Вакансии</h1>
<p class="sub">${escHtml(username)}${lastScoredAt ? ` · последний скоринг ${escHtml(fmtDate(lastScoredAt))}` : ''}</p>
<div class="card" style="background:#eef2ff;box-shadow:none"><b>Создать вакансию</b> — напиши боту в Telegram команду <code>/new_job_post</code> и опиши роль; черновик появится здесь.</div>
${list}
</main>
<dialog id="launch-dialog" style="border:none;border-radius:12px;padding:20px;max-width:440px;width:calc(100% - 32px)">
<form method="dialog" id="launch-form">
  <h2 style="font-size:17px;margin-bottom:12px">Запустить процесс</h2>
  <label style="display:block;font-size:13px;color:#64748b;margin-bottom:4px" for="launch-goal">Цель</label>
  <input id="launch-goal" name="goal" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;margin-bottom:12px" required maxlength="300">
  <ul style="list-style:none;font-size:14px;line-height:1.8;margin-bottom:12px">
    <li>${hhConnected ? '✅' : '❌'} HH подключён${hhConnected ? '' : ' — скажи боту «подключи HH»'}</li>
    <li>✅ Вакансия: <span id="launch-title"></span></li>
    <li id="launch-ats"></li>
  </ul>
  <p class="hint" style="margin-bottom:16px">Плейбук: <b>recruiting-vacancy-launch</b> — лендинг, синхронизация откликов и скоринг, итог в Telegram.</p>
  <div style="display:flex;gap:8px;justify-content:flex-end">
    <button class="btn" value="cancel" formnovalidate>Отмена</button>
    <button class="btn primary" id="launch-submit" value="run"${hhConnected ? '' : ' disabled'}>▶ Запустить</button>
  </div>
</form>
</dialog>
<div class="toast" id="toast"></div>
<script>
(function () {
  var AUTH = ${jsonForScript({ username, token: token || '' })};
  var dlg = document.getElementById('launch-dialog');
  var current = null;
  function toast(msg) {
    var t = document.getElementById('toast'); t.textContent = msg; t.style.display = 'block';
    setTimeout(function () { t.style.display = 'none'; }, 5000);
  }
  document.querySelectorAll('[data-launch]').forEach(function (b) {
    b.addEventListener('click', function () {
      current = { id: b.dataset.launch, title: b.dataset.title };
      document.getElementById('launch-goal').value = 'Запустить подбор по вакансии «' + current.title + '»';
      document.getElementById('launch-title').textContent = current.title;
      document.getElementById('launch-ats').textContent = b.dataset.ats ? 'ℹ️ ATS конфиг настроен' : 'ℹ️ ATS конфиг не настроен — скоринг возьмёт черновой (не блокирует)';
      dlg.showModal();
    });
  });
  document.getElementById('launch-form').addEventListener('submit', function (e) {
    if (e.submitter && e.submitter.value !== 'run') return;
    e.preventDefault();
    var btn = document.getElementById('launch-submit'); btn.disabled = true; btn.textContent = 'Запускаю…';
    fetch('playbook-run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: AUTH.username, token: AUTH.token, vacancy_id: current.id, goal: document.getElementById('launch-goal').value }),
      signal: AbortSignal.timeout(45000),
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        if (!x.ok || !x.d.status_url) throw new Error(x.d.error || 'Не удалось запустить');
        location.href = 'plan' + x.d.status_url.slice(x.d.status_url.indexOf('?'));
      })
      .catch(function (err) { dlg.close(); toast(err.message); btn.disabled = false; btn.textContent = '▶ Запустить'; });
  });
})();
</script>`;
  return pageShell('Вакансии', body);
}

const TASK_STATUS = {
  draft: 'черновик', active: 'выполняется', paused: 'на паузе', blocked: 'заблокирован',
  done: 'готово', failed: 'ошибка', cancelled: 'отменён',
};
const ITEM_STATUS = {
  pending: ['⏳', 'ожидает'], running: ['🔄', 'выполняется'], waiting: ['⏸', 'ждёт'],
  done: ['✅', 'готово'], failed: ['❌', 'ошибка'], skipped: ['⏭', 'пропущен'],
};
const FINAL_TASK_STATUSES = ['done', 'failed', 'cancelled'];

function planPageHtml({ username, token, taskId, data = null, error = null }) {
  if (error || !data?.task) {
    return pageShell('Статус процесса', `<main><h1>Статус процесса</h1><div class="card"><p>${escHtml(error || 'Процесс не найден.')}</p></div></main>`);
  }
  const { task } = data;
  const items = (Array.isArray(data.items) ? data.items : []).slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const current = items.find(i => i.status === 'running') ||
    (task.status === 'active' ? items.find(i => i.status === 'pending' || i.status === 'waiting') : null);
  const rows = items.map(i => {
    const [icon, label] = ITEM_STATUS[i.status] || ['•', i.status || ''];
    const meta = [i.stage, i.execution_kind].filter(Boolean).map(escHtml).join(' · ');
    const err = i.status === 'failed' && i.last_error ? `<div class="hint" style="color:#dc2626">${escHtml(String(i.last_error).slice(0, 300))}</div>` : '';
    return `<li class="plan-item" data-status="${escHtml(i.status)}" style="display:flex;gap:10px;padding:10px 0;border-bottom:1px solid #e2e8f0">
  <span aria-hidden="true">${icon}</span>
  <div style="flex:1"><div>${escHtml(i.title)}</div>${meta ? `<div class="hint">${meta}</div>` : ''}${err}</div>
  <span class="hint" style="margin:0">${escHtml(label)}</span>
</li>`;
  }).join('\n');
  const statusLabel = TASK_STATUS[task.status] || task.status || '';
  const playbook = task.playbook_id ? `${task.playbook_id}${task.playbook_version ? ` v${task.playbook_version}` : ''}` : '—';
  const final = FINAL_TASK_STATUSES.includes(task.status);
  const pollQuery = new URLSearchParams({ username, token: token || '', task_id: taskId, format: 'json' }).toString();
  const signature = `${task.status}|${items.map(i => i.status).join(',')}`;
  const body = `<main>
<h1>${escHtml(task.goal || 'Процесс')}</h1>
<p class="sub">Плейбук: <b>${escHtml(playbook)}</b>${task.created_at ? ` · запущен ${escHtml(fmtDate(task.created_at))}` : ''}</p>
<div class="card">
  <p>Статус: <span class="badge ${escHtml(task.status)}" id="plan-status">${escHtml(statusLabel)}</span></p>
  ${current ? `<p style="margin-top:8px">Сейчас: <b>${escHtml(current.title)}</b></p>` : ''}
</div>
<div class="card"><h2 style="font-size:16px;margin-bottom:4px">Шаги</h2><ol style="list-style:none">${rows || '<li class="hint">Шагов нет.</li>'}</ol></div>
<p class="hint" id="poll-note">${final ? 'Процесс завершён.' : 'Страница обновляется автоматически.'}</p>
</main>
${final ? '' : `<script>
(function () {
  var started = Date.now(), SIG = ${jsonForScript(signature)};
  function delay() { return Date.now() - started < 60000 ? 4000 : 20000; }
  function tick() {
    fetch('plan?' + ${jsonForScript(pollQuery)}, { cache: 'no-store', signal: AbortSignal.timeout(15000) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var items = (d.items || []).slice().sort(function (a, b) { return (a.position || 0) - (b.position || 0); });
        var sig = (d.task && d.task.status) + '|' + items.map(function (i) { return i.status; }).join(',');
        if (d.task && sig !== SIG) return location.reload();
        setTimeout(tick, delay());
      })
      .catch(function () { setTimeout(tick, delay()); });
  }
  setTimeout(tick, delay());
})();
</script>`}`;
  return pageShell('Статус процесса', body);
}

module.exports = { vacanciesPageHtml, planPageHtml, FINAL_TASK_STATUSES };
