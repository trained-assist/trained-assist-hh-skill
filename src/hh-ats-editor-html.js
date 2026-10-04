'use strict';
const { revisionMetaTag } = require('./hh-version');
const { stageTemplates } = require('./hh-stage-templates');
// mcp-skill-conformance: browser-fetch — every fetch() here is emitted client-side JS inside <script>.

// Generates the ATS Template Editor HTML page.
// opts: { callbackBase, username, pageToken } — pageToken is the recruiter's own HMAC,
// never the master AGENT_SECRET (this HTML is delivered to the recruiter's browser).
// currentConfig: the saved ats_config value (may be null)

const TEMPLATES = {
  webinar: {
    label: 'Вебинарный специалист',
    config: {
      vacancy_title: 'Вебинарный специалист / Webinar Manager',
      vacancy_context: 'Проведение обучающих и продающих вебинаров, взаимодействие с аудиторией, работа с платформами (Zoom, Bizon365, Webinar.ru).',
      required: [
        { name: 'Опыт проведения вебинаров / онлайн-мероприятий', weight: 3.0 },
        { name: 'Работа с вебинарными платформами (Zoom, Bizon365, Webinar.ru)', weight: 2.5 },
        { name: 'Навыки презентации и публичных выступлений', weight: 2.5 },
      ],
      preferred: [
        { name: 'Опыт в EdTech или онлайн-образовании', weight: 1.5 },
        { name: 'Продающие вебинары / конверсия', weight: 1.5 },
        { name: 'Работа с чатами и модерация аудитории', weight: 1.0 },
        { name: 'Базовая работа с видео и стримингом (OBS, Restream)', weight: 1.0 },
      ],
      filters: { min_experience_years: 1, remote_ok: true, salary_max_rub: null },
      pass_threshold: 7.0,
      review_threshold: 4.5,
    },
  },
  marketing: {
    label: 'Маркетолог',
    config: {
      vacancy_title: 'Маркетолог / Marketing Manager',
      vacancy_context: 'Продвижение B2C/B2B продуктов. Работа с рекламными каналами, аналитика, контент.',
      required: [
        { name: 'Digital marketing (SEO/SEM/SMM)', weight: 2.5 },
        { name: 'Аналитика (Google Analytics, Яндекс.Метрика)', weight: 2.0 },
        { name: 'Работа с рекламными кабинетами', weight: 2.0 },
      ],
      preferred: [
        { name: 'CRM-системы', weight: 1.0 },
        { name: 'A/B тестирование', weight: 1.0 },
        { name: 'Автоматизация маркетинга', weight: 1.0 },
      ],
      filters: { min_experience_years: 2, remote_ok: true, salary_max_rub: null },
      pass_threshold: 6.0,
      review_threshold: 4.0,
    },
  },
  cpp3d: {
    label: 'C++ / 3D Программист',
    config: {
      vacancy_title: 'C++ / 3D Программист',
      vacancy_context: 'Разработка рендеринга реального времени, симуляций или игровых систем.',
      required: [
        { name: 'C++ (STL, C++17/20)', weight: 3.0 },
        { name: '3D-математика (матрицы, кватернионы, трансформации)', weight: 2.5 },
        { name: 'OpenGL / DirectX / Vulkan / Metal', weight: 2.5 },
      ],
      preferred: [
        { name: 'Unreal Engine или Unity (C++/C#)', weight: 1.5 },
        { name: 'Оптимизация / профилирование', weight: 1.5 },
        { name: 'Gamedev или симуляции', weight: 1.0 },
      ],
      filters: { min_experience_years: 2, remote_ok: true, salary_max_rub: null },
      pass_threshold: 7.0,
      review_threshold: 5.0,
    },
  },
  office: {
    label: 'Офисный сотрудник',
    config: {
      vacancy_title: 'Офисный сотрудник / административная роль',
      vacancy_context: 'Работа с документами, координация, взаимодействие с клиентами и партнёрами.',
      required: [
        { name: 'MS Office / Google Workspace', weight: 2.0 },
        { name: 'Деловая коммуникация', weight: 2.0 },
        { name: 'Организация и тайм-менеджмент', weight: 2.0 },
      ],
      preferred: [
        { name: 'CRM / ERP системы', weight: 1.0 },
        { name: 'Английский язык (B1+)', weight: 1.0 },
      ],
      filters: { min_experience_years: 1, remote_ok: false, salary_max_rub: null },
      pass_threshold: 5.5,
      review_threshold: 3.5,
    },
  },
  backend: {
    label: 'Backend Developer',
    config: {
      vacancy_title: 'Backend Developer (Node.js / Python / Go)',
      vacancy_context: 'Разработка серверных приложений, REST/gRPC API, микросервисы.',
      required: [
        { name: 'Node.js / Python / Go / Java (хотя бы один)', weight: 3.0 },
        { name: 'REST API + HTTP протокол', weight: 2.0 },
        { name: 'SQL (PostgreSQL / MySQL)', weight: 2.0 },
      ],
      preferred: [
        { name: 'Docker / Kubernetes', weight: 1.5 },
        { name: 'Очереди сообщений (Kafka, RabbitMQ)', weight: 1.0 },
        { name: 'Опыт с облачными платформами (GCP/AWS/Azure)', weight: 1.0 },
      ],
      filters: { min_experience_years: 2, remote_ok: true, salary_max_rub: null },
      pass_threshold: 6.5,
      review_threshold: 4.5,
    },
  },
};

// ── communication_plan (epic #142) ──────────────────────────────────────────────
//
// The scenario lives in the saved per-vacancy ATS config as `communication_plan`
// ({version:1, stages:[{id,title,instruction,completion_result,material,material_mode,template_id?}]}).
// Only the SAVED plan is live: a migration draft built from the legacy `test_task` /
// profile `ats_stages.json` is shown for review and becomes live only when the recruiter
// presses Save. Nothing here guesses a stage's meaning from its title or position.

// The plan model (src/hh-communication-plan.js) is owned by #143 and may not exist in
// every checkout yet. The editor must still render without it, so the require is
// optional and the migration draft falls back to listing the legacy sources instead of
// silently inventing stages.
function planModel() {
  try { return require('./hh-communication-plan'); } catch { return null; }
}

function coerceDraft(out) {
  if (!out || typeof out !== 'object') return null;
  const plan = out.plan || out.draft || out.communication_plan;
  if (!plan || !Array.isArray(plan.stages)) return null;
  return {
    plan: { version: 1, stages: plan.stages.map(s => ({ ...(s || {}) })) },
    notes: Array.isArray(out.notes || out.warnings) ? (out.notes || out.warnings).map(String) : [],
    sources: Array.isArray(out.sources) ? out.sources.map(String) : [],
  };
}

function migrationDraft(config, legacyStages) {
  const model = planModel();
  if (!model || typeof model.prepareLegacyPlan !== 'function') return null;
  try {
    return coerceDraft(model.prepareLegacyPlan(config || {}, legacyStages || []));
  } catch (err) {
    console.error('[hh/ats-editor] prepareLegacyPlan failed:', err && err.message);
    return null;
  }
}

// What the legacy data actually holds, for the panel that asks the recruiter to review
// it. Deliberately does not decide which stage a text belongs to — that is the recruiter's
// call, and #143's migration draft is the only place that may propose it.
function legacySources(config, legacyStages) {
  const sources = [];
  const names = (Array.isArray(legacyStages) ? legacyStages : [])
    .map(s => (typeof s === 'string' ? s : s && s.title))
    .filter(Boolean);
  if (names.length) sources.push({ label: 'Этапы подбора (профиль)', detail: names.join(' → ') });
  const testTask = config && typeof config.test_task === 'string' ? config.test_task.trim() : '';
  if (testTask) sources.push({ label: 'Тестовое задание (отдельное поле)', detail: `${testTask.length} симв. — перенесите его в материал нужного этапа` });
  return sources;
}

// JSON that is safe to drop inside a <script>: escaping <, >, & and the line separators
// keeps a config value containing "</script>" from breaking out of the block.
function jsonForScript(value) {
  return JSON.stringify(value === undefined ? null : value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function atsEditorHtml(currentConfig, currentStages, opts = {}) {
  const { callbackBase = '', username = '', pageToken = '', vacancies = [], activeVacancyId = '', isDraft = false, prefill = {} } = opts;
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const vacancyToken = pageToken;
  const templatesJson = JSON.stringify(TEMPLATES);
  const stageTemplatesJson = jsonForScript(stageTemplates());
  const initConfigJson = jsonForScript(currentConfig || null);
  const initStagesJson = jsonForScript(currentStages || null);
  // HH text for fields the recruiter has not filled yet (issue #126). The server
  // already blanked the ones the saved config provides, so this never overwrites
  // anything the recruiter typed.
  const prefillJson = jsonForScript({ vacancyTitle: prefill.vacancyTitle || '', vacancyContext: prefill.vacancyContext || '' });
  const isLive = Boolean(callbackBase);

  // The plan the page starts from. A saved plan is live; a migration draft is not.
  const savedPlan = currentConfig && currentConfig.communication_plan;
  const hasSavedPlan = Boolean(savedPlan && Array.isArray(savedPlan.stages) && !opts.migration?.requires_review && !isDraft);
  const legacy = legacySources(currentConfig, currentStages);
  const draft = hasSavedPlan ? null : (opts.migration ? coerceDraft(opts.migration) : migrationDraft(currentConfig, currentStages));
  const initPlanJson = jsonForScript(hasSavedPlan ? savedPlan : (draft && draft.plan) || null);
  const planState = hasSavedPlan ? 'saved' : (draft || legacy.length ? 'draft' : 'none');
  const planNotesJson = jsonForScript(draft && draft.notes ? draft.notes : []);
  const legacySourcesJson = jsonForScript(legacy);

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
${revisionMetaTag()}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Candidate Funnel Editor</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f1117;color:#e8e9ed;min-height:100vh}
:root{
  --bg:#0f1117;--panel:#1a1d27;--border:#2e3347;--accent:#4f8ef7;--accent2:#7c5ce4;
  --green:#27c97b;--red:#ff6b6b;--yellow:#f0b429;--text:#e8e9ed;--muted:#8b8fa8;
  --radius:10px;--shadow:0 4px 20px rgba(0,0,0,.4)
}
/* Layout */
header{background:var(--panel);border-bottom:1px solid var(--border);padding:14px 24px;display:flex;align-items:center;gap:16px;position:sticky;top:0;z-index:100}
.logo{font-size:17px;font-weight:700;color:var(--accent);letter-spacing:-.3px}
.badge{font-size:11px;padding:3px 8px;border-radius:20px;font-weight:600}
.badge.live{background:rgba(39,201,123,.15);color:var(--green);border:1px solid rgba(39,201,123,.3)}
.badge.offline{background:rgba(139,143,168,.1);color:var(--muted);border:1px solid var(--border)}
.spacer{flex:1}
select#tplSelect{background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:7px 12px;font-size:13px;cursor:pointer;outline:none}
select#tplSelect:focus{border-color:var(--accent)}
.btn{padding:8px 18px;border-radius:6px;border:none;cursor:pointer;font-size:13px;font-weight:600;transition:all .15s}
.btn-primary{background:var(--accent);color:#fff}.btn-primary:hover{filter:brightness(1.1)}
.btn-secondary{background:var(--panel);color:var(--text);border:1px solid var(--border)}.btn-secondary:hover{border-color:var(--accent)}
.btn-danger{background:rgba(255,107,107,.15);color:var(--red);border:1px solid rgba(255,107,107,.2)}.btn-danger:hover{background:rgba(255,107,107,.25)}
.btn-sm{padding:4px 10px;font-size:12px;border-radius:5px}
.btn:disabled{opacity:.45;cursor:default}
main{max-width:960px;margin:0 auto;padding:28px 20px;display:flex;flex-direction:column;gap:24px}

/* Scenario stages: one vertical accordion, full width, phone-sized tap targets */
.section-title{font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:14px}
.plan-status{border-radius:var(--radius);padding:12px 16px;font-size:13px;line-height:1.6;border:1px solid var(--border);background:var(--panel)}
.plan-status.draft{border-color:rgba(240,180,41,.4);background:rgba(240,180,41,.08);color:#f0b429}
.plan-status.saved{border-color:rgba(39,201,123,.35);background:rgba(39,201,123,.07);color:var(--green)}
.plan-status.none{border-style:dashed;color:var(--muted)}
.plan-status ul{margin:6px 0 0;padding-left:18px}
.plan-status li{margin-top:2px;word-break:break-word}
.stages-wrap{display:flex;flex-direction:column;gap:10px;min-width:0}
.stage-item{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);min-width:0;overflow:hidden}
.stage-summary{display:flex;align-items:center;gap:10px;width:100%;background:none;border:none;color:var(--text);padding:14px 16px;cursor:pointer;text-align:left;min-height:48px}
.stage-summary:hover{background:rgba(79,142,247,.06)}
.stage-num{font-size:10px;font-weight:700;color:var(--accent);letter-spacing:.5px;flex-shrink:0}
.stage-title-text{font-size:14px;font-weight:600;min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stage-hint{font-size:12px;color:var(--muted);min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stage-chevron{color:var(--muted);font-size:12px;flex-shrink:0}
.stage-body{display:flex;flex-direction:column;gap:12px;padding:0 16px 16px;border-top:1px solid var(--border)}
.stage-body[hidden]{display:none}
.stage-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
.stage-actions .btn{min-height:36px}
.stage-template-note{font-size:11px;color:var(--muted)}
.add-stage-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.add-stage-row select{flex:1;min-width:180px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:9px 10px;font-size:13px;outline:none}
.add-stage-row .btn{min-height:40px}
@media (max-width:480px){
  main{padding:16px 12px;gap:16px}
  .stage-summary{flex-wrap:wrap;gap:6px}
  .stage-hint{flex-basis:100%;order:3}
  .stage-actions .btn{flex:1}
}

/* Config card */
.config-card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:20px;display:flex;flex-direction:column;gap:16px}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.field{display:flex;flex-direction:column;gap:5px}
.field label{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
.field input[type=text],.field input[type=number],.field textarea{background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:8px 10px;font-size:13px;outline:none;font-family:inherit;width:100%}
.field input:focus,.field textarea:focus{border-color:var(--accent)}
.field textarea{resize:vertical;min-height:60px}
.field input[type=number]{width:90px}

/* Criteria list */
.criteria-section{display:flex;flex-direction:column;gap:8px}
.criteria-label{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;display:flex;align-items:center;justify-content:space-between}
.criteria-item{display:flex;align-items:center;gap:8px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:7px 10px}
.criteria-item input[type=text]{flex:1;background:transparent;border:none;color:var(--text);font-size:13px;outline:none}
.criteria-item .weight-label{font-size:11px;color:var(--muted);white-space:nowrap}
.criteria-item input[type=number]{width:60px;background:var(--panel);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:3px 6px;font-size:12px;text-align:center;outline:none}
.criteria-item .del-btn{background:none;border:none;color:var(--muted);cursor:pointer;font-size:15px;line-height:1;flex-shrink:0}.del-btn:hover{color:var(--red)}

/* Must-haves the writer already receives on its own — shown next to the instruction
   textarea so nobody types them in there a second time (a copy goes stale the moment
   the skills below change, and the two lists then contradict each other). */
.autocriteria{font-size:11px;color:var(--muted);margin-top:8px;padding:8px 10px;border:1px dashed var(--border);border-radius:6px}
.autocriteria b{color:var(--text);font-weight:600}
.autocriteria ul{margin:6px 0 0;padding-left:18px}
.autocriteria li{margin-top:2px}

/* Thresholds */
.thresholds{display:flex;gap:20px;align-items:center;flex-wrap:wrap}
.threshold-field{display:flex;flex-direction:column;gap:5px}
.threshold-field label{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
.threshold-field input{width:80px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:7px 10px;font-size:14px;font-weight:700;outline:none;text-align:center}
.threshold-field input:focus{border-color:var(--accent)}
.threshold-bar{height:6px;background:var(--bg);border:1px solid var(--border);border-radius:3px;margin-top:4px;position:relative;width:200px}
.threshold-bar-fill{position:absolute;height:100%;border-radius:3px;transition:width .2s}

/* Filters */
.filters-row{display:flex;gap:16px;align-items:flex-end;flex-wrap:wrap}
.filter-field{display:flex;flex-direction:column;gap:5px}
.filter-field label{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
.filter-field input[type=number]{width:90px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:7px 10px;font-size:13px;outline:none}
.filter-field input[type=number]:focus{border-color:var(--accent)}
.toggle-wrap{display:flex;align-items:center;gap:8px;margin-top:4px}
.toggle{position:relative;width:38px;height:20px}
.toggle input{opacity:0;width:0;height:0}
.toggle-slider{position:absolute;inset:0;background:var(--border);border-radius:10px;cursor:pointer;transition:.2s}
.toggle input:checked+.toggle-slider{background:var(--accent)}
.toggle-slider:before{content:"";position:absolute;height:14px;width:14px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s}
.toggle input:checked+.toggle-slider:before{transform:translateX(18px)}

/* Validation / Toast */
.validation-box{border-radius:8px;padding:12px 16px;font-size:13px;line-height:1.6;display:none}
.validation-box.ok{background:rgba(39,201,123,.1);border:1px solid rgba(39,201,123,.25);color:var(--green)}
.validation-box.err{background:rgba(255,107,107,.1);border:1px solid rgba(255,107,107,.25);color:var(--red)}
.validation-box.warn{background:rgba(240,180,41,.1);border:1px solid rgba(240,180,41,.3);color:#f0b429}
.toast{position:fixed;bottom:24px;right:24px;background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:12px 18px;font-size:13px;box-shadow:var(--shadow);transition:opacity .3s;z-index:200;max-width:300px}
.toast.hidden{opacity:0;pointer-events:none}
.toast.success{border-color:rgba(39,201,123,.4);color:var(--green)}
.toast.error{border-color:rgba(255,107,107,.4);color:var(--red)}

/* JSON preview */
details summary{cursor:pointer;font-size:12px;color:var(--muted);padding:6px 0;user-select:none}
details summary:hover{color:var(--accent)}
pre.json-preview{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:12px;font-size:11px;overflow-x:auto;color:#a8b5d0;margin-top:8px;white-space:pre-wrap;word-break:break-word}

/* Vacancy tabs */
@media (max-width:640px){
header{flex-wrap:wrap;padding:12px;gap:10px;position:static}
.header-actions{flex-wrap:wrap;min-width:0}
select#tplSelect{max-width:100%;min-width:0;width:100%}
main{min-width:0}
.row2{grid-template-columns:minmax(0,1fr)}
.field,.config-card,.criteria-item{min-width:0}
.config-card{padding:16px}
.add-stage-row select{min-width:0;max-width:100%;width:100%;flex-basis:100%}
.json-preview{white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}
}
</style>
</head>
<body>

${require('./hh-nav').vacancyPickerHtml(vacancies, activeVacancyId, v => `${callbackBase}/hh/ats-editor?username=${encodeURIComponent(username)}&token=${vacancyToken}&vacancy_id=${encodeURIComponent(v.id)}`, `${callbackBase}/hh/vacancy-new?username=${encodeURIComponent(username)}&token=${vacancyToken}`)}

<header>
  <span class="logo">Candidate Funnel</span>
  ${isLive ? '<span class="badge live">● Live</span>' : '<span class="badge offline">○ Offline</span>'}
  <div class="spacer"></div>
  <label for="tplSelect" style="font-size:12px;color:var(--muted);margin-right:4px">Шаблон:</label>
  <select id="tplSelect">
    <option value="">— выбрать шаблон —</option>
    <option value="webinar">Вебинарный специалист</option>
    <option value="marketing">Маркетолог</option>
    <option value="cpp3d">C++ / 3D Программист</option>
    <option value="office">Офисный сотрудник</option>
    <option value="backend">Backend Developer</option>
  </select>
  &nbsp;
  <button class="btn btn-secondary btn-sm" id="validateBtn">Проверить</button>
  &nbsp;
  <button class="btn btn-secondary btn-sm" id="exportBtn">↓ JSON</button>
  &nbsp;
  <button class="btn btn-primary" id="saveBtn" ${isLive ? '' : 'disabled title="Сохранение недоступно в offline-режиме"'}>Save Funnel</button>
  &nbsp;
  <button class="btn btn-danger" id="resetAtsBtn" ${isLive ? '' : 'disabled title="Недоступно в offline-режиме"'} title="Re-run Funnel: сбросить оценки всех кандидатов и переоценить с текущим конфигом">↺ Re-run Funnel</button>
</header>

<main>

  ${isDraft ? '<div style="background:rgba(240,180,41,.12);border:1px solid rgba(240,180,41,.35);color:var(--yellow);border-radius:var(--radius);padding:12px 16px;font-size:13px">Черновик, сформированный по тексту вакансии — фоновый скоринг его ещё не использует. Проверь критерии и веса и нажми «Save Funnel», чтобы включить.</div>' : ''}

  <!-- Vacancy meta -->
  <div class="config-card">
    <div class="section-title" style="margin-bottom:0">Вакансия</div>
    <div class="row2">
      <div class="field">
        <label>Название вакансии</label>
        <input type="text" id="fTitle" placeholder="Backend Developer / Маркетолог ...">
      </div>
      <div class="thresholds">
        <div class="threshold-field">
          <label>Pass ≥</label>
          <input type="number" id="fPass" step="0.5" min="0" max="10" value="6.5">
        </div>
        <div class="threshold-field">
          <label>Review ≥</label>
          <input type="number" id="fReview" step="0.5" min="0" max="10" value="4.0">
        </div>
      </div>
    </div>
    <div class="field">
      <label>Контекст вакансии</label>
      <textarea id="fContext" rows="2" placeholder="Краткое описание: продукт, команда, задачи..."></textarea>
    </div>
    <div class="field">
      <label>Инструкция для сообщений кандидатам</label>
      <textarea id="fMessageInstructions" rows="4" placeholder="Порядок работы с кандидатом для этой вакансии. Обязательные требования подставляются автоматически из «★ Обязательные навыки» — перечислять их здесь не нужно."></textarea>
      <div style="font-size:11px;color:var(--muted);margin-top:4px">Порядок работы с кандидатом для этой вакансии. Дополнительные ограничения для этой вакансии. Порядок работы и результат каждого этапа задаются ниже в сценарии.</div>
      <div class="autocriteria" id="autoCriteria"></div>
      <button type="button" class="btn btn-secondary btn-sm" id="resetInstructionBtn" ${isLive ? '' : 'disabled title="Недоступно в offline-режиме"'} style="margin-top:8px;align-self:flex-start">↩ Вернуть общий шаблон</button>
    </div>
  </div>

  <!-- Required + Preferred -->
  <div class="config-card">
    <div class="criteria-section">
      <div class="criteria-label">
        <span style="color:var(--accent)">★ Обязательные навыки</span>
        <button class="btn btn-sm btn-secondary" onclick="addRequired()">+ добавить</button>
      </div>
      <div id="requiredList"></div>
    </div>
    <div class="criteria-section" style="margin-top:16px">
      <div class="criteria-label">
        <span style="color:var(--accent2)">◆ Желательные навыки</span>
        <button class="btn btn-sm btn-secondary" onclick="addPreferred()">+ добавить</button>
      </div>
      <div id="preferredList"></div>
    </div>
  </div>

  <!-- Filters -->
  <div class="config-card">
    <div class="section-title" style="margin-bottom:8px">Фильтры</div>
    <div class="filters-row">
      <div class="filter-field">
        <label>Мин. опыт (лет)</label>
        <input type="number" id="fMinExp" min="0" max="20" value="2" placeholder="0">
      </div>
      <div class="filter-field">
        <label>Макс. зарплата (₽)</label>
        <input type="number" id="fMaxSalary" min="0" step="10000" placeholder="не ограничено">
      </div>
      <div class="filter-field">
        <label>Удалённая работа</label>
        <div class="toggle-wrap">
          <label class="toggle"><input type="checkbox" id="fRemote" checked><span class="toggle-slider"></span></label>
          <span id="fRemoteLabel" style="font-size:13px;color:var(--text)">Да</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Interview / call config -->
  <div class="config-card">
    <div class="section-title" style="margin-bottom:8px">Приглашение на звонок</div>
    <div class="filters-row">
      <div class="filter-field">
        <label>Уровень позиции</label>
        <input type="text" id="fIcLevel" placeholder="Junior / Middle / Senior">
      </div>
      <div class="filter-field">
        <label>Ссылка для записи (Calendly и т.п.)</label>
        <input type="text" id="fIcBookingUrl" placeholder="https://calendly.com/...">
      </div>
      <div class="filter-field">
        <label>Разрешить авто-приглашение с конкретным временем</label>
        <div class="toggle-wrap">
          <label class="toggle"><input type="checkbox" id="fIcEnabled"><span class="toggle-slider"></span></label>
          <span id="fIcEnabledLabel" style="font-size:13px;color:var(--text)">Нет</span>
        </div>
      </div>
    </div>
    <div class="field">
      <label>Требования к звонку (что взять с собой, формат)</label>
      <input type="text" id="fIcRequirements" placeholder="Например: подключение к Zoom, тестовое задание уже готово">
    </div>
    <div class="field">
      <label>Реальная доступность рекрутера</label>
      <textarea id="fIcAvailability" rows="2" placeholder="Например: Пн–Пт 10:00–18:00 МСК, слоты по 30 минут"></textarea>
    </div>
    <div style="font-size:11px;color:var(--muted);margin-top:4px">Без ссылки на запись или указанной доступности бот НЕ будет предлагать кандидату конкретное время — вместо этого спросит, когда ему удобно.</div>
  </div>

  <!-- Communication scenario: vertical accordion of editable stages, below the ATS block -->
  <section>
    <div class="section-title">Сценарий общения</div>
    <div class="plan-status" id="planStatus" data-testid="plan-status" data-state="none"></div>
    <div class="stages-wrap" id="stagesWrap" data-testid="stages-wrap" style="margin-top:12px"></div>
    <div class="add-stage-row" style="margin-top:12px">
      <select id="stageTemplate" data-testid="stage-template-select" aria-label="Шаблон этапа">
        <option value="">— выбрать шаблон —</option>
      </select>
      <button class="btn btn-secondary" id="addStageBtn" data-testid="add-stage-btn">＋ Добавить этап</button>
    </div>
    <div style="font-size:11px;color:var(--muted);margin-top:8px">Порядок этапов — обычная последовательность общения, а не жёсткая машинка состояний: название и номер этапа не включают никакой логики. Материал в режиме «дословно» уходит кандидату без правок.</div>
  </section>

  <!-- Validation output -->
  <div class="validation-box" id="validationBox"></div>

  <!-- JSON preview -->
  <details>
    <summary>JSON (raw config)</summary>
    <pre class="json-preview" id="jsonPreview"></pre>
  </details>

</main>

<div class="toast hidden" id="toast"></div>

<script>
const TEMPLATES = ${templatesJson};
const STAGE_TEMPLATES = ${stageTemplatesJson};
const CALLBACK_BASE = ${jsonForScript(callbackBase)};
const HH_USER = ${jsonForScript(username)};
const HH_PAGE_TOKEN = ${jsonForScript(pageToken)};
let CONFIG_REVISION = ${jsonForScript(opts.configRevision || null)};
const VACANCY_ID = ${jsonForScript(activeVacancyId || null)};
const HH_PREFILL = ${prefillJson};
const INIT_PLAN = ${initPlanJson};
const PLAN_STATE = ${JSON.stringify(planState)};
const PLAN_NOTES = ${planNotesJson};
const LEGACY_SOURCES = ${legacySourcesJson};

let initConfig = ${initConfigJson};
let initStages = ${initStagesJson};

// ── State ─────────────────────────────────────────────────────────────────────

let stages = [];
let planState = PLAN_STATE;
let planNotes = PLAN_NOTES;
let legacySources = LEGACY_SOURCES;
let openStages = new Set();
let required = [];
let preferred = [];

// ── Init ──────────────────────────────────────────────────────────────────────

function applyHhPrefill() {
  // Issue #126: title/context are known to HH, so the recruiter is not asked to retype
  // them. Only fills blanks — anything the recruiter typed (or the saved config has)
  // stays untouched, and the fields are still editable.
  const t = document.getElementById('fTitle');
  const c = document.getElementById('fContext');
  if (t && !t.value.trim() && HH_PREFILL.vacancyTitle) t.value = HH_PREFILL.vacancyTitle;
  if (c && !c.value.trim() && HH_PREFILL.vacancyContext) c.value = HH_PREFILL.vacancyContext;
}

function init() {
  if (initConfig) {
    loadPlan();
    loadFromConfig(initConfig);
  } else {
    required = [{ name: '', weight: 2.0 }];
    preferred = [{ name: '', weight: 1.0 }];
    loadPlan();
    renderRequired();
    renderPreferred();
    applyHhPrefill();
  }
  // The banner "letters stopped updating" on the review page links here with extract=1.
  // The extraction runs FROM the editor, not from the review page: the public edge
  // only exposes part of the HH routes, and this page already talks to the agent over
  // the channel that works (CALLBACK_BASE = AGENT_PUBLIC_URL). Called from the review
  // page the same request came back 401 before it ever reached the route.
  if (new URLSearchParams(location.search).get('extract') === '1' && !initConfig) {
    extractCriteriaFromVacancy();
  }
}

async function extractCriteriaFromVacancy() {
  if (!CALLBACK_BASE || !VACANCY_ID) return;
  toast('⏳ Собираю критерии из текста вакансии…', 'success');
  try {
    const r = await fetch(CALLBACK_BASE + '/hh/ats-extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: HH_USER, token: HH_PAGE_TOKEN, vacancy_id: VACANCY_ID }),
    });
    const data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || ('HTTP ' + r.status));
    if (data.config) {
      const extractedPlan = data.config.communication_plan;
      loadFromConfig({ ...data.config, vacancy_title: data.config.vacancy_title || HH_PREFILL.vacancyTitle, vacancy_context: data.config.vacancy_context || HH_PREFILL.vacancyContext });
      // A plan that came out of the vacancy text is a DRAFT: it must not become the
      // live scenario just because the recruiter pressed «Собрать критерии».
      if (extractedPlan && Array.isArray(extractedPlan.stages)) {
        planState = 'draft';
        planNotes = ['План собран из текста вакансии — это черновик, он ещё не сохранён.'];
        renderStages();
      }
      updateJsonPreview();
    }
    const dropped = (data.dropped_criteria || []).length;
    toast('✅ Критерии собраны' + (dropped ? ', убрано неизмеримых: ' + dropped : '') + '. Проверь и нажми Save Funnel.', 'success');
  } catch (e) {
    toast('❌ Не удалось собрать критерии: ' + e.message, 'error');
  }
}

// ── Template selector ─────────────────────────────────────────────────────────

document.getElementById('tplSelect').addEventListener('change', e => {
  const key = e.target.value;
  if (!key) return;
  const t = TEMPLATES[key];
  if (!t) return;
  // A vacancy template only fills the ATS block. It never touches the scenario: the
  // stages belong to the vacancy, and picking a different job must not silently reset
  // the recruiter's plan.
  loadFromConfig(t.config);
  e.target.value = '';
});

function loadFromConfig(config) {
  document.getElementById('fTitle').value = config.vacancy_title || '';
  document.getElementById('fContext').value = config.vacancy_context || '';
  document.getElementById('fMessageInstructions').value = config.message_instructions || '';
  document.getElementById('fPass').value = config.pass_threshold ?? 6.5;
  document.getElementById('fReview').value = config.review_threshold ?? 4.0;
  const f = config.filters || {};
  document.getElementById('fMinExp').value = f.min_experience_years ?? '';
  document.getElementById('fMaxSalary').value = f.salary_max_rub || '';
  document.getElementById('fRemote').checked = f.remote_ok !== false;
  updateRemoteLabel();
  const ic = config.interview_config || {};
  document.getElementById('fIcLevel').value = ic.level || '';
  document.getElementById('fIcBookingUrl').value = ic.booking_url || '';
  document.getElementById('fIcRequirements').value = ic.requirements || '';
  document.getElementById('fIcAvailability').value = ic.availability || '';
  document.getElementById('fIcEnabled').checked = !!ic.invite_call_enabled;
  updateIcEnabledLabel();
  if (config.communication_plan && Array.isArray(config.communication_plan.stages)) {
    stages = config.communication_plan.stages.map(normalizeStage);
    renderStages();
  }
  required = config.required && config.required.length ? config.required.map(x => ({ ...x })) : [{ name: '', weight: 2.0 }];
  preferred = config.preferred && config.preferred.length ? config.preferred.map(x => ({ ...x })) : [{ name: '', weight: 1.0 }];
  renderRequired();
  renderPreferred();
  updateJsonPreview();
}

// ── Communication plan ────────────────────────────────────────────────────────

function newStageId() {
  return 'stg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Every field of the schema is always present, so a consumer never has to guess.
// material is kept byte-for-byte: it is the exact text a candidate must receive.
function normalizeStage(s) {
  const stage = {
    id: String((s && s.id) || newStageId()),
    title: String((s && s.title) || '').trim(),
    instruction: String((s && s.instruction) || '').trim(),
    completion_result: String((s && s.completion_result) || '').trim(),
    material: s && s.material != null ? String(s.material) : '',
    material_mode: s && s.material_mode === 'verbatim' ? 'verbatim' : 'context',
  };
  if (s && s.template_id) stage.template_id = String(s.template_id);
  return stage;
}

function stageById(id) {
  return stages.find(s => s.id === id) || null;
}

function templateLabel(id) {
  const t = STAGE_TEMPLATES.find(x => x.id === id);
  return t ? t.label : '';
}

function loadPlan() {
  const saved = initConfig && initConfig.communication_plan;
  const source = (saved && Array.isArray(saved.stages)) ? saved
    : (INIT_PLAN && Array.isArray(INIT_PLAN.stages)) ? INIT_PLAN : null;
  stages = source ? source.stages.map(normalizeStage) : [];
  planState = PLAN_STATE;
  planNotes = PLAN_NOTES;
  legacySources = LEGACY_SOURCES;
  renderStages();
}

function renderPlanStatus() {
  const box = document.getElementById('planStatus');
  box.dataset.state = planState;
  const count = stages.length;
  if (planState === 'saved') {
    box.className = 'plan-status saved';
    box.innerHTML = '<b>Сценарий сохранён</b> — этапов: ' + count + '. Правки применятся после нажатия «Save Funnel».';
  } else if (planState === 'draft') {
    box.className = 'plan-status draft';
    box.innerHTML = '<b>Черновик миграции</b> — показанные этапы ещё НЕ сохранены и бот их не использует. Сверь их и нажми «Save Funnel», чтобы включить сценарий.'
      + (planNotes.length ? '<ul>' + planNotes.map(n => '<li>' + escHtml(n) + '</li>').join('') + '</ul>' : '')
      + legacyListHtml();
  } else {
    box.className = 'plan-status none';
    box.innerHTML = '<b>Автоматического сценария нет</b> — добавь этап из шаблона или пустой этап. Пустой сценарий не дополняется скрытыми этапами.' + legacyListHtml();
  }
}

function legacyListHtml() {
  if (!legacySources || !legacySources.length) return '';
  return '<ul>' + legacySources.map(s => '<li><b>' + escHtml(s.label) + ':</b> ' + escHtml(s.detail) + '</li>').join('') + '</ul>';
}

function renderStages() {
  const wrap = document.getElementById('stagesWrap');
  wrap.innerHTML = '';
  stages.forEach((s, i) => wrap.appendChild(renderStage(s, i)));
  renderPlanStatus();
}

function shortHint(stage) {
  const text = String(stage.instruction || '').split('\\n')[0].trim();
  return text.length > 90 ? text.slice(0, 90) + '…' : text;
}

function renderStage(stage, index) {
  const item = document.createElement('div');
  item.className = 'stage-item';
  item.dataset.stageId = stage.id;
  item.dataset.testid = 'stage-item';

  const summary = document.createElement('button');
  summary.type = 'button';
  summary.className = 'stage-summary';
  summary.dataset.testid = 'stage-summary';
  summary.setAttribute('aria-expanded', openStages.has(stage.id) ? 'true' : 'false');
  summary.innerHTML =
    '<span class="stage-num">ЭТАП ' + (index + 1) + '</span>' +
    '<span class="stage-title-text" data-testid="stage-title-text">' + escHtml(stage.title || 'Без названия') + '</span>' +
    '<span class="stage-hint" data-testid="stage-hint">' + escHtml(shortHint(stage)) + '</span>' +
    '<span class="stage-chevron">' + (openStages.has(stage.id) ? '▲' : '▼') + '</span>';
  summary.addEventListener('click', () => toggleStage(stage.id));
  item.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'stage-body';
  body.dataset.testid = 'stage-body';
  if (!openStages.has(stage.id)) body.hidden = true;
  body.innerHTML = stageFieldsHtml(stage);
  item.appendChild(body);
  wireStageFields(item, stage);
  return item;
}

function stageFieldsHtml(stage) {
  const id = escHtml(stage.id);
  return (
    '<div class="field"><label>Название этапа</label>' +
    '<input type="text" data-field="title" data-stage-id="' + id + '" value="' + escHtml(stage.title) + '" placeholder="Например: Тестовое задание"></div>' +
    '<div class="field"><label>Инструкция (что сделать на этом этапе)</label>' +
    '<textarea rows="3" data-field="instruction" data-stage-id="' + id + '" placeholder="Что спросить или предложить кандидату...">' + escHtml(stage.instruction) + '</textarea></div>' +
    '<div class="field"><label>Когда этап выполнен</label>' +
    '<textarea rows="2" data-field="completion_result" data-stage-id="' + id + '" placeholder="Какой факт означает, что этап закрыт">' + escHtml(stage.completion_result) + '</textarea></div>' +
    '<div class="field"><label>Материал (необязательно)</label>' +
    '<textarea rows="6" data-field="material" data-stage-id="' + id + '" placeholder="Текст, который уйдёт кандидату дословно, или контекст для сообщения">' + escHtml(stage.material) + '</textarea></div>' +
    '<div class="field"><label>Как использовать материал</label>' +
    '<select data-field="material_mode" data-stage-id="' + id + '">' +
    '<option value="verbatim"' + (stage.material_mode === 'verbatim' ? ' selected' : '') + '>дословно — отправить текст без правок</option>' +
    '<option value="context"' + (stage.material_mode !== 'verbatim' ? ' selected' : '') + '>как контекст — модель перескажет своими словами</option>' +
    '</select></div>' +
    (stage.template_id ? '<div class="stage-template-note">Скопировано из шаблона «' + escHtml(templateLabel(stage.template_id) || stage.template_id) + '» — дальше этап принадлежит этой вакансии.</div>' : '') +
    '<div class="stage-actions">' +
    '<button type="button" class="btn btn-secondary btn-sm" data-action="up" data-stage-id="' + id + '">↑ Выше</button>' +
    '<button type="button" class="btn btn-secondary btn-sm" data-action="down" data-stage-id="' + id + '">↓ Ниже</button>' +
    '<button type="button" class="btn btn-danger btn-sm" data-action="delete" data-stage-id="' + id + '">✕ Удалить</button>' +
    '</div>'
  );
}

function wireStageFields(item, stage) {
  item.querySelectorAll('[data-field]').forEach(el => {
    const field = el.dataset.field;
    const apply = () => {
      stage[field] = el.value;
      updateStageSummary(item, stage);
      updateJsonPreview();
    };
    el.addEventListener('input', apply);
    el.addEventListener('change', apply);
  });
  item.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.action === 'delete') removeStage(stage.id);
      else moveStage(stage.id, btn.dataset.action === 'up' ? -1 : 1);
    });
  });
}

function updateStageSummary(item, stage) {
  const title = item.querySelector('.stage-title-text');
  const hint = item.querySelector('.stage-hint');
  if (title) title.textContent = stage.title || 'Без названия';
  if (hint) hint.textContent = shortHint(stage);
}

function toggleStage(id) {
  if (openStages.has(id)) openStages.delete(id); else openStages.add(id);
  const item = [...document.querySelectorAll('.stage-item')].find(el => el.dataset.stageId === id);
  if (!item) return;
  const body = item.querySelector('.stage-body');
  const summary = item.querySelector('.stage-summary');
  const chevron = item.querySelector('.stage-chevron');
  const open = openStages.has(id);
  if (body) body.hidden = !open;
  if (summary) summary.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (chevron) chevron.textContent = open ? '▲' : '▼';
}

function moveStage(id, delta) {
  const i = stages.findIndex(s => s.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= stages.length) return;
  const [moved] = stages.splice(i, 1);
  stages.splice(j, 0, moved);
  renderStages();
  updateJsonPreview();
}

function removeStage(id) {
  stages = stages.filter(s => s.id !== id);
  openStages.delete(id);
  renderStages();
  updateJsonPreview();
}

function templateToStage(key) {
  const t = STAGE_TEMPLATES.find(x => x.id === key);
  if (!t) return null;
  return {
    id: newStageId(),
    title: t.title,
    instruction: t.instruction,
    completion_result: t.completion_result,
    material: t.material,
    material_mode: t.material_mode,
    template_id: t.id,
  };
}

function renderStageTemplateOptions() {
  const sel = document.getElementById('stageTemplate');
  STAGE_TEMPLATES.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.label + ' — ' + t.hint;
    sel.appendChild(opt);
  });
  const blank = document.createElement('option');
  blank.value = 'blank';
  blank.textContent = 'Пустой этап (без шаблона)';
  sel.appendChild(blank);
}

function addStageFromSelect() {
  const sel = document.getElementById('stageTemplate');
  const key = sel.value;
  if (!key) return;
  const stage = key === 'blank'
    ? { id: newStageId(), title: '', instruction: '', completion_result: '', material: '', material_mode: 'context' }
    : templateToStage(key);
  if (!stage) return;
  stages.push(stage);
  openStages.add(stage.id);
  sel.value = '';
  renderStages();
  updateJsonPreview();
  const item = [...document.querySelectorAll('.stage-item')].find(el => el.dataset.stageId === stage.id);
  if (item) {
    item.scrollIntoView({ block: 'nearest' });
    const title = item.querySelector('[data-field="title"]');
    if (title) title.focus();
  }
}

function buildPlan() {
  return {
    version: 1,
    stages: stages.map(s => {
      const stage = {
        id: s.id,
        title: s.title.trim(),
        instruction: s.instruction.trim(),
        completion_result: s.completion_result.trim(),
        material: s.material,
        material_mode: s.material_mode === 'verbatim' ? 'verbatim' : 'context',
      };
      if (s.template_id) stage.template_id = s.template_id;
      return stage;
    }),
  };
}

// ── Required ──────────────────────────────────────────────────────────────────

// ── Auto-injected must-haves ─────────────────────────────────────────────────
// The writer prompt already gets the required criteria from the config
// (buildCriteriaBlock in src/hh-message-prompts.js) — nothing to configure here. On
// vacancy 138004863 the must-haves were ALSO written out by hand inside this very
// textarea, in a wording that had already drifted from the ★ list, so the letters asked
// questions the rubric no longer scored. Render what is injected automatically: same list,
// same source, visibly live next to the field that must not duplicate it.
function renderAutoCriteria() {
  const box = document.getElementById('autoCriteria');
  if (!box) return;
  const names = required.map(r => r.name.trim()).filter(Boolean);
  if (!names.length) {
    box.innerHTML = '<b>Обязательные требования</b> — список «★ Обязательные навыки» пуст, поэтому в письма ничего не подставляется. Добавь навыки ниже или на этом же экране.';
    return;
  }
  box.innerHTML = '<b>Уже подставляется в каждое письмо автоматически</b> — из «★ Обязательные навыки»,'
    + ' не из этого поля. Перечислять их в инструкции не нужно: правка навыков ниже не обновит текст здесь,'
    + ' и письма начнут спрашивать не то, что оценивается.'
    + '<ul>' + names.map(n => '<li>' + escHtml(n) + '</li>').join('') + '</ul>';
}

function addRequired() { required.push({ name: '', weight: 2.0 }); renderRequired(); }

function renderRequired() {
  const list = document.getElementById('requiredList');
  list.innerHTML = '';
  required.forEach((r, i) => {
    const item = document.createElement('div');
    item.className = 'criteria-item';
    item.innerHTML = \`
      <span style="color:var(--accent);font-size:14px;flex-shrink:0">★</span>
      <input type="text" value="\${escHtml(r.name)}" data-idx="\${i}" data-field="name" placeholder="Навык / технология...">
      <span class="weight-label">вес</span>
      <input type="number" value="\${r.weight}" data-idx="\${i}" data-field="weight" step="0.5" min="0.5" max="5" style="width:60px">
      <button class="del-btn" data-idx="\${i}">×</button>
    \`;
    list.appendChild(item);
  });
  renderAutoCriteria();
  list.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', e => {
      const idx = +e.target.dataset.idx;
      const field = e.target.dataset.field;
      required[idx][field] = field === 'weight' ? +e.target.value : e.target.value;
      updateJsonPreview();
      renderAutoCriteria();
    });
  });
  list.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      required.splice(+e.target.dataset.idx, 1);
      if (required.length === 0) required.push({ name: '', weight: 2.0 });
      renderRequired();
      updateJsonPreview();
    });
  });
}

// ── Preferred ─────────────────────────────────────────────────────────────────

function addPreferred() { preferred.push({ name: '', weight: 1.0 }); renderPreferred(); }

function renderPreferred() {
  const list = document.getElementById('preferredList');
  list.innerHTML = '';
  preferred.forEach((p, i) => {
    const item = document.createElement('div');
    item.className = 'criteria-item';
    item.innerHTML = \`
      <span style="color:var(--accent2);font-size:14px;flex-shrink:0">◆</span>
      <input type="text" value="\${escHtml(p.name)}" data-idx="\${i}" data-field="name" placeholder="Желательный навык...">
      <span class="weight-label">вес</span>
      <input type="number" value="\${p.weight}" data-idx="\${i}" data-field="weight" step="0.5" min="0.5" max="5" style="width:60px">
      <button class="del-btn" data-idx="\${i}">×</button>
    \`;
    list.appendChild(item);
  });
  list.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', e => {
      const idx = +e.target.dataset.idx;
      const field = e.target.dataset.field;
      preferred[idx][field] = field === 'weight' ? +e.target.value : e.target.value;
      updateJsonPreview();
    });
  });
  list.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      preferred.splice(+e.target.dataset.idx, 1);
      if (preferred.length === 0) preferred.push({ name: '', weight: 1.0 });
      renderPreferred();
      updateJsonPreview();
    });
  });
}

// ── Field events ──────────────────────────────────────────────────────────────

['fTitle','fContext','fMessageInstructions','fPass','fReview','fMinExp','fMaxSalary','fIcLevel','fIcBookingUrl','fIcRequirements','fIcAvailability'].forEach(id => {
  document.getElementById(id).addEventListener('input', updateJsonPreview);
});
document.getElementById('fRemote').addEventListener('change', () => { updateRemoteLabel(); updateJsonPreview(); });
document.getElementById('fIcEnabled').addEventListener('change', () => { updateIcEnabledLabel(); updateJsonPreview(); });

// ── Reset instruction to the global template (epic #112) ─────────────────────
document.getElementById('resetInstructionBtn').addEventListener('click', async () => {
  const btn = document.getElementById('resetInstructionBtn');
  btn.disabled = true;
  try {
    const u = new URL(CALLBACK_BASE + '/hh/message-instructions-template');
    u.searchParams.set('username', HH_USER);
    u.searchParams.set('token', HH_PAGE_TOKEN);
    const r = await fetch(u.toString());
    const d = await r.json();
    if (r.ok && d.ok) {
      document.getElementById('fMessageInstructions').value = d.text || '';
      updateJsonPreview();
      toast('Поле очищено до общего шаблона. Нажми «Save Funnel» чтобы сохранить.');
    } else {
      toast('Ошибка: ' + (d.error || r.status), 'error');
    }
  } catch (e) {
    toast('Ошибка сети: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

function updateRemoteLabel() {
  document.getElementById('fRemoteLabel').textContent = document.getElementById('fRemote').checked ? 'Да' : 'Нет';
}

function updateIcEnabledLabel() {
  document.getElementById('fIcEnabledLabel').textContent = document.getElementById('fIcEnabled').checked ? 'Да' : 'Нет';
}

// ── Build config object ───────────────────────────────────────────────────────

function buildConfig() {
  const pass = +document.getElementById('fPass').value;
  const review = +document.getElementById('fReview').value;
  const minExp = document.getElementById('fMinExp').value;
  const maxSal = document.getElementById('fMaxSalary').value;
  return {
    vacancy_title: document.getElementById('fTitle').value.trim(),
    vacancy_context: document.getElementById('fContext').value.trim(),
    message_instructions: document.getElementById('fMessageInstructions').value.trim(),
    required: required.filter(r => r.name.trim()).map(r => ({ name: r.name.trim(), weight: +r.weight })),
    preferred: preferred.filter(p => p.name.trim()).map(p => ({ name: p.name.trim(), weight: +p.weight })),
    filters: {
      min_experience_years: minExp ? +minExp : null,
      remote_ok: document.getElementById('fRemote').checked,
      salary_max_rub: maxSal ? +maxSal : null,
    },
    pass_threshold: isNaN(pass) ? 6.5 : pass,
    review_threshold: isNaN(review) ? 4.0 : review,
    // The scenario is saved INSIDE the config, per vacancy. The legacy standalone
    // test_task field is not edited here any more: the material belongs to a stage, and
    // #143 owns the migration of the old value. The stages array is deliberately NOT
    // sent — the profile-wide ats_stages.json singleton must not be written from this UI.
    communication_plan: buildPlan(),
    interview_config: {
      level: document.getElementById('fIcLevel').value.trim(),
      requirements: document.getElementById('fIcRequirements').value.trim(),
      availability: document.getElementById('fIcAvailability').value.trim(),
      booking_url: document.getElementById('fIcBookingUrl').value.trim(),
      invite_call_enabled: document.getElementById('fIcEnabled').checked,
    },
  };
}

function updateJsonPreview() {
  const preview = document.getElementById('jsonPreview');
  if (!preview.parentElement.open) return;
  preview.textContent = JSON.stringify({ config: buildConfig() }, null, 2);
}

document.querySelector('details').addEventListener('toggle', updateJsonPreview);

// ── Validate ──────────────────────────────────────────────────────────────────

document.getElementById('validateBtn').addEventListener('click', validate);

function validate() {
  const config = buildConfig();
  // Blockers: the config cannot mean anything without them — saving produces a
  // silently broken funnel (thresholds inverted, no stages).
  const errors = [];
  if (config.pass_threshold <= config.review_threshold) errors.push('Pass threshold должен быть выше review threshold.');
  if (config.pass_threshold < 1 || config.pass_threshold > 10) errors.push('Pass threshold: от 1 до 10.');
  if (config.review_threshold < 0 || config.review_threshold >= config.pass_threshold) errors.push('Review threshold: от 0 до pass threshold.');
  // One stage is a legitimate scenario, and so is an empty one — the old «минимум 2
  // этапа» rule existed when the cards were decorative. What still has to be true is
  // that every stage that IS there can be recognised and executed.
  if (stages.some(s => !s.title.trim())) errors.push('У одного из этапов не заполнено название — заполни или удали этап.');
  if (stages.some(s => !s.instruction.trim())) errors.push('У этапа не заполнена инструкция — заполни или удали этап.');
  if (stages.some(s => !s.completion_result.trim())) errors.push('У этапа не заполнен результат — заполни или удали этап.');
  if (stages.some(s => s.material_mode !== 'verbatim' && s.material_mode !== 'context')) errors.push('У этапа неизвестный режим материала.');
  const seenIds = new Set();
  stages.forEach(s => {
    if (seenIds.has(s.id)) errors.push('Дублируется идентификатор этапа — пересоздай этап.');
    seenIds.add(s.id);
  });
  if (config.interview_config.invite_call_enabled && !config.interview_config.availability && !config.interview_config.booking_url) {
    errors.push('Чтобы разрешить авто-приглашение на звонок с конкретным временем — укажи доступность рекрутера или ссылку на запись.');
  }
  // Warnings (issue #126): these used to BLOCK the save, which meant a recruiter who
  // only wanted to set the recruiter availability could not save at all — and with no
  // config on disk the background loop skips the vacancy entirely, so letters stopped
  // updating (see hh-negotiations.js). An intentionally thin config is a legitimate
  // starting point; say what it costs instead of refusing.
  const warnings = [];
  if (!config.vacancy_title) warnings.push('Название вакансии не задано — подставится из HH при сохранении.');
  if (!config.vacancy_context) warnings.push('Контекст вакансии пуст — оценка будет только по резюме кандидата.');
  if (config.required.length === 0) warnings.push('Нет обязательных навыков — оценка не будет различать кандидатов по требованиям.');
  if (stages.length && stages.some(s => !s.instruction.trim())) warnings.push('Есть этап без инструкции — бот не будет знать, что на нём делать.');
  if (stages.length && stages.some(s => !s.completion_result.trim())) warnings.push('Есть этап без ожидаемого результата — такой этап нельзя закрыть.');
  if (stages.some(s => s.material_mode === 'verbatim' && !s.material.trim())) warnings.push('Материал помечен «дословно», но пуст — отправлять будет нечего.');

  const box = document.getElementById('validationBox');
  box.style.display = 'block';
  const errHtml = errors.map(e => '• ' + e).join('<br>');
  const warnHtml = warnings.map(w => '• ' + w).join('<br>');
  if (errors.length > 0) {
    box.className = 'validation-box err';
    box.innerHTML = errHtml + (warnHtml ? '<br><br>Также:<br>' + warnHtml : '');
  } else if (warnings.length > 0) {
    box.className = 'validation-box warn';
    box.innerHTML = '⚠ Сохранить можно, но:<br>' + warnHtml;
  } else {
    box.className = 'validation-box ok';
    box.textContent = '✓ Конфиг валиден. Всё готово для сохранения.';
  }
  return errors.length === 0;
}

// ── Save to context ───────────────────────────────────────────────────────────

document.getElementById('saveBtn').addEventListener('click', async () => {
  if (!CALLBACK_BASE) return;
  if (!validate()) return;
  const btn = document.getElementById('saveBtn');
  btn.disabled = true;
  btn.textContent = 'Сохраняю...';
  try {
    const wasDraft = planState === 'draft';
    // No stages array in the payload: the scenario travels inside
    // config.communication_plan, and the profile-wide ats_stages.json singleton is not
    // written from this UI.
    const payload = { username: HH_USER, token: HH_PAGE_TOKEN, config: buildConfig(), vacancy_id: VACANCY_ID, expected_revision: CONFIG_REVISION };
    const r = await fetch(CALLBACK_BASE + '/hh/ats-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (r.ok && data.ok) {
      // The saved plan is the live one. Say so explicitly when a migration draft was
      // just adopted — otherwise the recruiter cannot tell whether the old data is gone.
      if (data.revision) CONFIG_REVISION = data.revision;
      planState = 'saved';
      renderPlanStatus();
      toast(wasDraft ? 'Сценарий перенесён и сохранён ✓' : 'Конфиг сохранён в контекст ✓', 'success');
    } else {
      toast('Ошибка: ' + (data.error || r.status), 'error');
    }
  } catch(e) {
    toast('Ошибка сети: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Сохранить в контекст';
  }
});

// ── Reset ATS results ─────────────────────────────────────────────────────────

document.getElementById('resetAtsBtn').addEventListener('click', async () => {
  if (!CALLBACK_BASE) return;
  if (!confirm('Re-run Funnel: сбросить оценки всех кандидатов? Они будут переоценены с текущим конфигом при следующем запуске.')) return;
  const btn = document.getElementById('resetAtsBtn');
  btn.disabled = true;
  btn.textContent = 'Сбрасываю...';
  try {
    const r = await fetch(CALLBACK_BASE + '/hh/reset-ats-results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: HH_USER, token: HH_PAGE_TOKEN, vacancy_id: VACANCY_ID }),
    });
    const data = await r.json();
    if (r.ok && data.ok) {
      toast(\`Funnel re-run: \${data.reset} кандидатов сброшено. Запускай hh_batch_review.\`, 'success');
    } else {
      toast('Ошибка: ' + (data.error || r.status), 'error');
    }
  } catch(e) {
    toast('Ошибка сети: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '↺ Re-run Funnel';
  }
});

// ── Export JSON ───────────────────────────────────────────────────────────────

document.getElementById('exportBtn').addEventListener('click', () => {
  const full = { config: buildConfig() };
  const blob = new Blob([JSON.stringify(full, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'ats-config.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

// ── Toast ─────────────────────────────────────────────────────────────────────

function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + type;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.className = 'toast hidden', 3500);
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderAll() {
  renderStages();
  renderRequired();
  renderPreferred();
  updateJsonPreview();
}

document.getElementById('addStageBtn').addEventListener('click', addStageFromSelect);
renderStageTemplateOptions();

init();
</script>
</body>
</html>`;
}

module.exports = { atsEditorHtml, TEMPLATES };
