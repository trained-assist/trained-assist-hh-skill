'use strict';
// Канон v2 (#120): два документа кандидата из канонического CandidateEvaluation.
//
//   renderCleanEvalMdV2   — внутренняя оценка. Всё: баллы 1–5, evidence, личностные
//                           требования отдельной таблицей, коммуникация отдельной осью,
//                           экспертная проверка колонкой, ATS отдельным показателем.
//   renderClientProfileMdV2 — клиентский профиль. Третье лицо, только одобренные
//                           поля. Внутренние данные (баллы, риск-лог, противоречия,
//                           экспертные замечания, переписка) не попадают ни в текст,
//                           ни в скрытый DOM, ни в embedded JSON, ни в HTML-комментарии.
//
// Оба рендера детерминированные (без LLM) и оба берут ОДИН И ТОТ ЖЕ объект данных —
// онлайн-просмотр, скачиваемый HTML и PDF показывают одну версию (R3).

const { buildCanonical, validateCanonical, SCALE, EXPERT_STATUSES, KINDS } = require('./hh-eval-canonical.js');
const { NEUTRAL } = require('./hh-branding.js');
const {
  adaptInterviewEval,
  adaptJobEval,
  adaptAtsOnly,
  adaptLegacyHrStalker,
  pickRowSource,
  checkVacancyMatch,
} = require('./hh-eval-adapters.js');

const FIT_ICON = { confirmed: '✓', partial: '△', missing: '⚠' };

const KIND_LABEL = { [KINDS.professional]: 'Профессиональное', [KINDS.personality]: 'Личностное' };

const EXPERT_LABEL = {
  verified: 'подтверждено',
  partial: 'частично верно',
  incorrect: 'неверно',
  cannot_verify: 'нельзя проверить',
};

const BASIS_LABEL = { interview: 'интервью', documents: 'документы', both: 'интервью + документы' };

const VERDICT_LABEL = { 'ПРОПУСТИТЬ': 'рекомендован', 'УТОЧНИТЬ': 'нужно уточнение', 'ОТКЛОНИТЬ': 'не рекомендован' };

// Клиентская шкала — словами, без чисел: клиент видит статус, а не внутренний балл.
const FIT_FROM_STATUS = { scored: 'confirmed', not_discussed: 'missing', no_data: 'missing' };

function escMd(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function dash(v) {
  return v === null || v === undefined || v === '' ? '—' : v;
}

function scoreCell(row) {
  if (row.status !== 'scored' || row.score === null) return 'н/д';
  return `${row.score}`;
}

function expertCell(row) {
  const st = row.expert_check?.status || 'cannot_verify';
  return EXPERT_LABEL[st] || EXPERT_LABEL.cannot_verify;
}

// Взвешенная доля «покрыто» для одной группы строк — чтобы в шапке клиентского профиля
// стояло «подтверждено 5 из 8», а не «62.5%».
function fitCounts(rows) {
  const out = { confirmed: 0, partial: 0, missing: 0 };
  for (const r of rows) {
    if (r.status === 'scored') {
      // Без экспертной проверки «подтверждено» означало бы слишком много; при
      // невозможности проверки честно показываем «частично».
      const st = r.expert_check?.status;
      if (st === 'incorrect') out.missing++;
      else if (st === 'partial' || st === 'cannot_verify' || r.score <= 2) out.partial++;
      else out.confirmed++;
    } else {
      out.missing++;
    }
  }
  return out;
}

// ── 3a. Внутренняя оценка ─────────────────────────────────────────────────────

function renderCleanEvalMdV2(ev, { notes = null, candidateName = null } = {}) {
  const e = ev || {};
  const L = [];
  const rows = Array.isArray(e.rows) ? e.rows : [];
  const proRows = rows.filter(r => r.kind === KINDS.professional);
  const perRows = rows.filter(r => r.kind === KINDS.personality);
  const t = e.totals || {};
  const name = candidateName || e.candidate_name || e.candidate_id || '—';

  L.push(`# Внутренняя оценка кандидата — ${name}`, '');
  L.push([
    e.vacancy_title ? `Вакансия: ${e.vacancy_title}` : 'Вакансия не указана',
    e.client_name ? `Заказчик: ${e.client_name}` : null,
    dash(e.generated_at),
  ].filter(Boolean).join(' · '), '');

  // Идентичность оценки видна в шапке: по ней рекрутер понимает, какой версии правил
  // и какому набору требований соответствует документ.
  L.push('| Параметр оценки | Значение |', '|---|---|');
  L.push(`| evaluation_id | \`${dash(e.evaluation_id)}\` |`);
  L.push(`| Версия требований | ${dash(e.requirements?.revision)} (${dash(e.requirements?.source)}, ${dash(e.requirements?.count)} треб.) |`);
  L.push(`| Методика | ${dash(e.policy?.scoring_policy_id)} v${dash(e.policy?.version)} |`);
  L.push(`| Пороги вердикта | ПРОПУСТИТЬ ≥ ${dash(t.thresholds?.pass)}% · УТОЧНИТЬ ≥ ${dash(t.thresholds?.review)}% |`);
  L.push(`| Строки оценки взяты из | ${rowsSourceLabel(e.rows_from)} |`);
  L.push('');

  L.push('## Источники данных', '');
  const provDocs = e.provenance?.docs || [];
  if (provDocs.length) {
    for (const d of provDocs) L.push(`- ${dash(d.type)} · \`${dash(d.doc_id)}\`${d.sha256 ? ` · sha256 \`${d.sha256.slice(0, 12)}\`` : ''}`);
  } else {
    L.push('- Документы не указаны.');
  }
  if (e.provenance?.interview_eval_path) L.push(`- файл оценки интервью: \`${e.provenance.interview_eval_path}\``);
  if (e.provenance?.job_path) L.push(`- файл оценки по документам: \`${e.provenance.job_path}\``);
  if (e.provenance?.ats_path) L.push(`- ATS: \`${e.provenance.ats_path}\``);
  L.push('');

  L.push('## Сводка', '');
  L.push('| Показатель | Значение |', '|---|---|');
  L.push(`| Вердикт | **${VERDICT_LABEL[t.verdict] || dash(t.verdict)}**${t.verdict ? ` (${t.verdict})` : ''} |`);
  const avg = (label, a) => L.push(`| ${label} | ${a && a.percent !== null && a.percent !== undefined ? `**${a.percent}%** · ${a.score10} / 10` : '—'} |`);
  avg('Профессиональные компетенции', t.professional);
  avg('Личностные качества (в итог не входят)', t.personality);
  avg('Общий итог', t.overall);
  const cov = e.coverage || {};
  L.push(`| Покрытие | ${dash(cov.evaluated)} из ${dash(cov.total)} (${dash(cov.percent)}%) · не обсуждалось ${dash(cov.not_discussed)}${cov.no_data ? ` · нет данных ${dash(cov.no_data)}` : ''} |`);
  // ATS — отдельная строка: это шкала HH 0–10, её нельзя смешивать с 1–5.
  L.push(`| HH ATS (отдельно, 0–10) | ${e.ats ? `${e.ats.score} / 10${e.ats.verdict ? ` · ${e.ats.verdict}` : ''}` : 'не рассчитывался'} |`);
  L.push(`| Veto | ${t.veto?.triggered ? `**сработало** — ${t.veto.items.map(i => i.label || i.criterion_id).join(' · ')}` : 'нет'} |`);
  L.push(`| Сравнение с вакансией | ${comparisonLine(e.comparison)} |`);
  L.push('');

  if (!rows.length) {
    // Пустой набор строк — это честный факт, а не повод молча показать процент ATS рядом
    // с пустой таблицей требований.
    L.push('> Строк требований нет — сравнивать нечего. Оценка по документам HH ATS показана выше отдельным показателем.', '');
  }

  if (proRows.length) {
    L.push('## Профессиональные требования', '');
    L.push(rowTableHeader());
    proRows.forEach((r, i) => L.push(rowTableLine(r, i)));
    L.push('');
  }

  if (perRows.length) {
    L.push('## Личностные требования', '');
    L.push('Отдельная средняя, в общий итог не входит (R6). Оценка — только по подтверждённому поступку, с источником.', '');
    L.push(rowTableHeader());
    perRows.forEach((r, i) => L.push(rowTableLine(r, i)));
    L.push('');
  }

  // Коммуникация приходит в двух формах: готовый rows[] (после адаптера) или
  // объект метрик {style:{label,score,evidence}, ...} из #89. Вторую сводим к rows.
  const comm = normalizeComm(e.communication);
  if (comm && comm.rows.length) {
    L.push('## Коммуникация — отдельная ось, в итог не входит', '');
    L.push('| Метрика | Балл | Цитата |', '|---|---|---|');
    for (const m of comm.rows) L.push(`| ${escMd(m.metric || m.name)} | ${m.score === null || m.score === undefined ? '—' : `${m.score} / 5`} | ${escMd(m.quote || m.evidence || '')} |`);
    L.push('');
  }

  L.push('## Внутренние риски и противоречия', '');
  const internal = [
    ...((notes && notes.risks) || []),
    ...((notes && notes.contradictions) || []),
  ];
  if (internal.length) for (const x of internal) L.push(`- ${escMd(x)}`);
  else L.push('- Не зафиксированы.');
  L.push('');

  const questions = (notes && notes.questions_next_stage) || [];
  L.push('## Вопросы следующего этапа', '');
  if (questions.length) for (const x of questions) L.push(`- ${escMd(x)}`);
  else L.push('- Не определены.');
  L.push('');

  L.push('## Не обсуждалось', '');
  const missing = cov.missing || [];
  if (missing.length) for (const m of missing) L.push(`- ${escMd(m.label || m.criterion_id)}${m.status === 'no_data' ? ' (нет данных)' : ''}`);
  else L.push('- Все требования обсуждены.');
  L.push('');

  L.push('## Ограничения', '');
  const lim = e.limitations || [];
  if (lim.length) for (const x of lim) L.push(`- ${escMd(x)}`);
  else L.push('- Ограничений не зафиксировано.');
  if (Array.isArray(e.warnings) && e.warnings.length) {
    L.push('', '### Предупреждения расчёта', '');
    for (const w of e.warnings) L.push(`- ${escMd(w)}`);
  }
  L.push('');
  return L.join('\n');
}

function rowTableHeader() {
  return `| # | Требование | Вид | Must-have | Вес | ${SCALE.min}–${SCALE.max} | Evidence (цитата + источник) | Почему этот балл | Экспертная проверка |`
    + `\n|---|---|---|---|---|---|---|---|---|`;
}

function rowTableLine(r, i = 0) {
  const ev = r.evidence || {};
  const evidence = [ev.quote, ev.source_ref ? `(${ev.source_ref})` : ''].filter(Boolean).join(' ') || '—';
  return `| ${i + 1} | ${escMd(r.label)} | ${KIND_LABEL[r.kind] || r.kind} | ${r.must_have ? 'да' : 'нет'} | ${dash(r.weight)} | **${scoreCell(r)}** | ${escMd(evidence)} | ${escMd(r.score_reason || '—')} | ${expertCell(r)} |`;
}

function comparisonLine(c) {
  if (!c || c.available === false) return c?.reason ? `недоступно — ${c.reason}` : 'не рассчитывалось';
  return `${c.place} из ${c.total} (средний ${c.avg}%, мин ${c.min}%, макс ${c.max}%, срез ${c.snapshot_at || '—'})`;
}

// Схема #89: communication = {style:{label,score,evidence}, politeness:{...}, ...}
// Сводим к {rows:[{metric, score, quote}]}; готовые rows[] пропускаем как есть.
function normalizeComm(comm) {
  if (!comm || typeof comm !== 'object') return null;
  if (Array.isArray(comm.rows)) return comm.rows.length ? { rows: comm.rows } : null;
  if (comm.metrics && typeof comm.metrics === 'object') return comm;
  const rows = Object.entries(comm)
    .filter(([, v]) => v && typeof v === 'object')
    .map(([key, v]) => ({ metric: v.label || key, score: v.score ?? null, quote: v.evidence || v.reason || '' }));
  return rows.length ? { rows } : null;
}

function rowsSourceLabel(from) {
  return from === 'interview' ? 'интервью-оценка (#89)' : from === 'job' ? 'оценка по документам (#90)' : 'нет строк';
}

// ── 3b. Клиентский профиль ────────────────────────────────────────────────────
// Третье лицо, деловой стиль. Клиент видит подтверждённое/частично/нет — без чисел,
// без внутреннего риск-лога, без противоречий и без экспертных замечаний.

// Белый список полей для клиента. Всё, чего здесь нет, не может попасть в документ:
// это делает grep-проверку утечки структурной, а не забывчивой.
const CLIENT_FIELDS = [
  'summary',
  'desired_role',
  'work_format',
  'experience',
  'education',
  'courses',
  'skills',
  'languages',
  'location',
  'professional',
  'personality',
  'fit',
  'client_risks',
  'salary_expectations',
  'recruiter_conclusion',
  'tests',
  'appendices',
  'photo_url',
];

// Проекция draft в клиентский вид. Внутренние поля (score, expert_check,
// evidence, risk-log, contradictions, questions_next_stage) отбрасываются здесь,
// а не «где-то дальше» — иначе они протекают при добавлении нового раздела.
function toClientView(draft) {
  const d = draft || {};
  const ev = d.evaluation || {};
  const rows = Array.isArray(ev.rows) ? ev.rows : [];

  const proRows = rows.filter(r => r.kind === KINDS.professional);
  const perRows = rows.filter(r => r.kind === KINDS.personality);

  const toFit = (r) => ({
    // Текст требования — это требование вакансии, а не внутренний критерий с баллом.
    requirement: r.label,
    status: FIT_FROM_STATUS[r.status] || 'missing',
    comment: r.status === 'scored' ? (r.score_reason || '') : (r.status === 'no_data' ? 'нет данных для проверки' : 'не обсуждалось на интервью'),
  });

  return {
    candidate_name: d.candidate_name,
    position: d.position,
    client_name: d.client_name,
    generated_at: ev.generated_at,
    evaluation_id: ev.evaluation_id,
    summary: d.summary || null,
    desired_role: d.desired_role || null,
    work_format: d.work_format || null,
    experience: Array.isArray(d.experience) ? d.experience : [],
    education: Array.isArray(d.education) ? d.education : [],
    courses: Array.isArray(d.courses) ? d.courses : [],
    skills: Array.isArray(d.skills) ? d.skills : [],
    languages: Array.isArray(d.languages) ? d.languages : [],
    location: d.location || null,
    professional: proRows.map(toFit),
    personality: perRows.map(toFit),
    fit: Array.isArray(d.fit) ? d.fit : [],
    // Клиентские риски — отдельное поле рекрутера, а не копия внутреннего списка.
    client_risks: Array.isArray(d.client_risks) ? d.client_risks : [],
    salary_expectations: d.salary_expectations || null,
    recruiter_conclusion: d.recruiter_conclusion || null,
    tests: Array.isArray(d.tests) ? d.tests : [],
    appendices: Array.isArray(d.appendices) ? d.appendices : [],
    photo_url: d.photo_url || null,
  };
}

function renderClientProfileMdV2(draft, { branding = NEUTRAL } = {}) {
  const d = toClientView(draft);
  const L = [];

  if (branding.agency_name) L.push(`*${branding.agency_name}*`, '');

  L.push(`# ${dash(d.candidate_name)}`, '');
  L.push([
    d.position ? `Позиция: ${d.position}` : null,
    d.client_name ? `Заказчик: ${d.client_name}` : null,
    d.generated_at ? `профиль от ${d.generated_at}` : null,
  ].filter(Boolean).join(' · '), '');

  L.push('## Желаемая роль и формат работы', '');
  if (d.desired_role || d.work_format || d.location) {
    if (d.desired_role) L.push(`- Желаемая роль: ${d.desired_role}`);
    if (d.work_format) L.push(`- Формат работы: ${d.work_format}`);
    if (d.location) L.push(`- Локация: ${d.location}`);
  } else {
    L.push('- Не указаны.');
  }
  L.push('');

  if (d.summary) L.push('## О кандидате', '', d.summary, '');

  if (d.experience.length) {
    L.push('## Опыт работы', '');
    for (const e of d.experience) {
      L.push(`- **${escMd(e.company || '')}** — ${escMd(e.role || '')}${e.period ? ` (${escMd(e.period)})` : ''}`);
      for (const det of e.details || []) L.push(`  - ${escMd(det)}`);
      // Дополнения из интервью — отдельным курсивом, чтобы клиент не принял их за резюме.
      if (e.from_interview) L.push(`  - *Из интервью: ${escMd(e.from_interview)}*`);
    }
    L.push('');
  }

  L.push('## Образование и навыки', '');
  const edu = [];
  if (d.education.length) edu.push(`- Образование: ${d.education.map(escMd).join('; ')}`);
  if (d.courses.length) edu.push(`- Курсы: ${d.courses.map(escMd).join('; ')}`);
  if (d.skills.length) edu.push(`- Навыки: ${d.skills.map(escMd).join('; ')}`);
  if (d.languages.length) edu.push(`- Языки: ${d.languages.map(escMd).join('; ')}`);
  if (edu.length) for (const x of edu) L.push(x);
  else L.push('- Не указаны.');
  L.push('');

  L.push('## Оценка кандидата', '');
  L.push('### Профессиональные компетенции', '');
  if (d.professional.length) {
    L.push('| | Компетенция | Комментарий |', '|---|---|---|');
    for (const f of d.professional) L.push(`| ${FIT_ICON[f.status] || '·'} | ${escMd(f.requirement)} | ${escMd(f.comment)} |`);
  } else {
    L.push('- Отдельная оценка по компетенциям не проводилась.');
  }
  L.push('');

  const perCounts = fitCounts((draft?.evaluation?.rows || []).filter(r => r.kind === KINDS.personality));
  L.push('### Личностные качества', '');
  if (d.personality.length) {
    L.push(`Подтверждено поступком: ${perCounts.confirmed} · частично: ${perCounts.partial} · не подтверждено: ${perCounts.missing}.`, '');
    for (const f of d.personality) L.push(`- ${FIT_ICON[f.status] || '·'} ${escMd(f.requirement)}${f.comment ? ` — ${escMd(f.comment)}` : ''}`);
  } else {
    L.push('- Личностные качества не оценивались.');
  }
  L.push('');

  L.push('### Соответствие требованиям вакансии', '');
  if (d.fit.length) {
    L.push('| | Требование | Комментарий |', '|---|---|---|');
    for (const f of d.fit) L.push(`| ${FIT_ICON[f.status] || '·'} | ${escMd(f.requirement)} | ${escMd(f.comment)} |`);
  } else {
    L.push('- Сетка соответствия не заполнена.');
  }
  L.push('');

  L.push('### Обращаем внимание клиента', '');
  if (d.client_risks.length) for (const x of d.client_risks) L.push(`- ${escMd(x)}`);
  else L.push('- Отдельных замечаний нет.');
  L.push('');

  L.push('## Зарплатные ожидания', '');
  L.push(d.salary_expectations ? escMd(d.salary_expectations) : '- Кандидат не указал.');
  L.push('');

  L.push('## Тесты и ссылки', '');
  if (d.tests.length) {
    L.push('| Тест | Дата | Результат | Ссылка |', '|---|---|---|---|');
    for (const t of d.tests) L.push(`| ${escMd(testTitle(t))} | ${escMd(t.date || '—')} | ${escMd(testResultText(t))} | ${t.source_url ? escMd(t.source_url) : '—'} |`);
  } else {
    // Без файла с тестом раздел пуст — выдуманных результатов быть не может.
    L.push('- Кандидат не предоставил результаты тестов.');
  }
  L.push('');

  L.push('## Заключение рекрутера', '');
  L.push(d.recruiter_conclusion ? d.recruiter_conclusion : '_Заключение добавляет рекрутер — формулировки его, от первого лица._', '');

  L.push('## Приложения', '');
  if (d.appendices.length) {
    for (const a of d.appendices) {
      const trunc = a.truncated ? ` _(показаны первые ${dash(a.shown_chars)} знаков из ${dash(a.total_chars)})_` : '';
      L.push(`- ${escMd(a.name || a.type || 'документ')}${trunc}`);
    }
  } else {
    L.push('- Не приложены.');
  }
  L.push('');

  return L.join('\n');
}

function testTitle(t) {
  if (!t) return '';
  if (t.type === 'DISC') return 'DISC';
  if (t.type === 'MBTI') return `16 Personalities / MBTI${t.mbti_type ? ` (${t.mbti_type})` : ''}`;
  if (t.type === 'Hogan') return 'Hogan';
  return t.name || 'Тест';
}

function testResultText(t) {
  if (!t) return '';
  if (t.type === 'DISC' && t.axes) {
    return ['D', 'I', 'S', 'C']
      .filter(k => t.axes[k] !== undefined && t.axes[k] !== null)
      .map(k => `${k}=${t.axes[k]}`)
      .join(' · ') || '—';
  }
  if (t.type === 'Hogan' && t.scales) {
    return Object.entries(t.scales).map(([k, v]) => `${k}=${v}`).join(' · ') || '—';
  }
  if (t.type === 'MBTI') return t.mbti_type || '—';
  if (t.results && typeof t.results === 'object') {
    return Object.entries(t.results).map(([k, v]) => `${k}=${v}`).join(' · ') || '—';
  }
  return '—';
}

// ── Клиентский HTML (брендированный, из того же клиентского вида) ───────────────

function clientCss(branding) {
  const b = branding || NEUTRAL;
  return `
:root{--acc:${b.primary};--ok:${b.accent};--ink:${b.ink};--mute:${b.mute};--line:${b.line};--surf:${b.surface}}
*{box-sizing:border-box}
body{margin:0;font:14px/1.55 ${b.font};color:var(--ink);background:#fff}
.page{max-width:840px;margin:0 auto;padding:28px 32px}
header{display:flex;gap:20px;align-items:flex-start;border-bottom:2px solid var(--acc);padding-bottom:16px}
.logo{max-height:44px;max-width:180px}
.photo{width:104px;height:104px;border-radius:8px;object-fit:cover;flex:none;background:#eef1f5}
h1{margin:0 0 2px;font-size:24px}
.sub{color:var(--mute);margin:0;font-size:13px}
h2{font-size:16px;color:var(--acc);margin:22px 0 8px;text-transform:uppercase;letter-spacing:.04em}
h3{font-size:14px;margin:14px 0 6px}
table{width:100%;border-collapse:collapse;font-size:13px;margin:6px 0}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{color:var(--mute);font-weight:600}
td.st{width:28px;text-align:center;font-weight:700;font-size:16px}
ul{margin:6px 0 6px 20px;padding:0}li{margin:2px 0}
.note{background:var(--surf);border-left:4px solid var(--acc);padding:10px 14px;break-inside:avoid}
.job{margin-bottom:10px;break-inside:avoid}.job b{font-size:14px}
@page{size:A4;margin:0}
@media print{
  body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .page{max-width:none;padding:14mm 16mm}
  h2,tr,.job,.note{break-inside:avoid}h2{break-after:avoid}
}`;
}

const bulletList = (items) => (items.length ? `<ul>${items.map(x => `<li>${escHtml(x)}</li>`).join('')}</ul>` : '<p>—</p>');

function renderClientHtmlV2(draft, { branding = NEUTRAL, photoDataUri = null } = {}) {
  const d = toClientView(draft);
  const b = branding || NEUTRAL;

  const head = [d.position, d.client_name ? `Заказчик: ${d.client_name}` : null].filter(Boolean).join(' · ');
  const header = `
<header>
  ${b.logo_data_uri ? `<img class="logo" src="${escHtml(b.logo_data_uri)}" alt="">` : ''}
  ${photoDataUri ? `<img class="photo" src="${escHtml(photoDataUri)}" alt="">` : ''}
  <div><h1>${escHtml(d.candidate_name || 'Кандидат')}</h1>${head ? `<p class="sub">${escHtml(head)}</p>` : ''}</div>
</header>`;

  const proTable = d.professional.length
    ? `<table><thead><tr><th></th><th>Компетенция</th><th>Комментарий</th></tr></thead><tbody>${
      d.professional.map(f => `<tr><td class="st">${FIT_ICON[f.status] || '·'}</td><td>${escHtml(f.requirement)}</td><td>${escHtml(f.comment)}</td></tr>`).join('')
    }</tbody></table>`
    : '<p>Отдельная оценка по компетенциям не проводилась.</p>';

  const fitTable = d.fit.length
    ? `<table><thead><tr><th></th><th>Требование</th><th>Комментарий</th></tr></thead><tbody>${
      d.fit.map(f => `<tr><td class="st">${FIT_ICON[f.status] || '·'}</td><td>${escHtml(f.requirement)}</td><td>${escHtml(f.comment)}</td></tr>`).join('')
    }</tbody></table>`
    : '<p>Сетка соответствия не заполнена.</p>';

  const experience = d.experience.length
    ? d.experience.map(e => `<div class="job"><b>${escHtml(e.company || '')}</b> — ${escHtml(e.role || '')}${e.period ? ` (${escHtml(e.period)})` : ''}${
      e.details && e.details.length ? bulletList(e.details) : ''}${
      e.from_interview ? `<p><i>Из интервью: ${escHtml(e.from_interview)}</i></p>` : ''}</div>`).join('')
    : '<p>Опыт не указан.</p>';

  const tests = d.tests.length
    ? `<table><thead><tr><th>Тест</th><th>Дата</th><th>Результат</th></tr></thead><tbody>${
      d.tests.map(t => `<tr><td>${escHtml(testTitle(t))}</td><td>${escHtml(t.date || '—')}</td><td>${escHtml(testResultText(t))}</td></tr>`).join('')
    }</tbody></table>`
    : '<p>Кандидат не предоставил результаты тестов.</p>';

  const inner = `${header}
${d.summary ? `<h2>О кандидате</h2><p>${escHtml(d.summary)}</p>` : ''}
<h2>Желаемая роль и формат</h2>${bulletList([d.desired_role && `Желаемая роль: ${d.desired_role}`, d.work_format && `Формат: ${d.work_format}`, d.location && `Локация: ${d.location}`].filter(Boolean))}
<h2>Опыт работы</h2>${experience}
<h2>Образование и навыки</h2>${bulletList([d.education.length && `Образование: ${d.education.join('; ')}`, d.courses.length && `Курсы: ${d.courses.join('; ')}`, d.skills.length && `Навыки: ${d.skills.join('; ')}`, d.languages.length && `Языки: ${d.languages.join('; ')}`].filter(Boolean))}
<h2>Оценка кандидата</h2>
<h3>Профессиональные компетенции</h3>${proTable}
<h3>Личностные качества</h3>${d.personality.length ? bulletList(d.personality.map(f => `${FIT_ICON[f.status] || '·'} ${f.requirement}${f.comment ? ` — ${f.comment}` : ''}`)) : '<p>Не оценивались.</p>'}
<h3>Соответствие требованиям вакансии</h3>${fitTable}
<h3>Обращаем внимание клиента</h3>${d.client_risks.length ? bulletList(d.client_risks) : '<p>Отдельных замечаний нет.</p>'}
<h2>Зарплатные ожидания</h2><p>${escHtml(d.salary_expectations || 'Кандидат не указал.')}</p>
<h2>Тесты и ссылки</h2>${tests}
<h2>Заключение рекрутера</h2><div class="note">${escHtml(d.recruiter_conclusion || 'Заключение добавляет рекрутер.')}</div>
<h2>Приложения</h2>${d.appendices.length ? bulletList(d.appendices.map(a => {
    const trunc = a.truncated ? ` <i>(показаны первые ${escHtml(dash(a.shown_chars))} знаков из ${escHtml(dash(a.total_chars))})</i>` : '';
    return `${escHtml(a.name || a.type || 'документ')}${trunc}`;
  })) : '<p>Не приложены.</p>'}`;

  // В HTML нет ни data-атрибутов с внутренними полями, ни embedded JSON, ни комментариев:
  // только отрендеренный текст. Это делает grep-проверку утечки проходной по построению.
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(d.candidate_name || 'Кандидат')}</title><style>${clientCss(b)}</style></head>
<body><div class="page">${inner}</div></body></html>`;
}

// Собирает канонический результат из сырых артефактов #89/#90/ATS/legacy.
// Единственная точка, где решается, чьи строки попадут в документ.
function buildReportDataV2({
  username = null,
  candidateId,
  candidateName = null,
  vacancyId = null,
  vacancyTitle = null,
  interviewEval = null,
  job = null,
  ats = null,
  legacy = null,
  requirements = {},
  expertChecks = [],
  docs = [],
  notes = null,
  draft = null,
  policy = null,
  thresholds = null,
  provenance = {},
  prefer = 'interview',
  limitations = [],
  now = new Date(),
} = {}) {
  const warnings = [];

  const interview = interviewEval ? adaptInterviewEval(interviewEval, { warnings }) : null;
  const jobEval = job ? adaptJobEval(job, { warnings }) : null;

  const match = checkVacancyMatch({ requestedVacancyId: vacancyId, interview, job: jobEval });
  if (!match.ok) return { error: match.error };

  // Legacy — запасной источник, а не override: свежая интервью- или job-оценка
// всегда важнее старой выгрузки. Иначе подмешались бы строки третьей оценки.
const primary = pickRowSource({ interview, job: jobEval, prefer });
let picked = primary;
if (!primary.rows.length && legacy) {
  const legacyEval = adaptLegacyHrStalker(legacy, { warnings });
  if (legacyEval.rows.length) picked = { from: 'legacy', rows: legacyEval.rows };
}

  const atsNorm = adaptAtsOnly(ats);

  const evaluation = buildCanonical({
    candidateId,
    vacancyId,
    vacancyTitle: vacancyTitle || jobEval?.meta?.vacancy_title || null,
    rows: picked.rows,
    rowsFrom: picked.from,
    requirements,
    expertChecks,
    ats: atsNorm,
    comparison: jobEval?.meta?.comparison || null,
    docs,
    provenance,
    policy,
    thresholds,
    limitations,
    warnings,
    now,
  });

  const errors = validateCanonical(evaluation);
  if (errors.length) return { error: `Каноническая оценка не прошла контракт: ${errors.join('; ')}` };

  return {
    error: null,
    evaluation,
    client: draft ? renderClientProfileMdV2(draft) : null,
  };
}

// Обёртка: клиентский HTML рендерится из того же draft, что и MD (R3).
function renderClientHtmlFromDraft(draft, opts) {
  return renderClientHtmlV2(draft, opts);
}

// MD и HTML строятся из одного клиентского вида — тест сравнения проверяет, что
// они не разошлись по данным.
function clientViewFor(draft) {
  return toClientView(draft);
}

module.exports = {
  renderCleanEvalMdV2,
  renderClientProfileMdV2,
  renderClientHtmlV2,
  renderClientHtmlFromDraft,
  buildReportDataV2,
  clientViewFor,
  toClientView,
  CLIENT_FIELDS,
  KIND_LABEL,
  EXPERT_STATUSES,
  fitCounts,
  testTitle,
  testResultText,
};