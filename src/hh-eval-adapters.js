'use strict';
// Адаптеры источников оценки в строки канонического результата (#120).
//
// Каждый источник говорит на своём языке, а документы читают один формат:
//   #89 interviews/<slug>/interview-eval.json → adaptInterviewEval
//   #90 candidate-eval/<candidate_id>.job.json → adaptJobEval
//   ATS-only (candidates/<neg_id>.json)     → adaptAtsOnly
//   legacy HR-Stalker (score: 0)             → adaptLegacyHrStalker
//
// Ключевое правило: `veto` в старых схемах — это либо `boolean` + список, либо
// `string[]` имён. На выходе всегда `{triggered, items[]}`, иначе рендер получает
// `.length` от boolean и рисует «нет» при сработавшем veto.

const { SCALE } = require('./hh-eval-canonical.js');

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string';
const isNonEmpty = (v) => isStr(v) && v.trim() !== '';

// Нормализация veto из обеих схем в единый вид.
//   #89: { veto: true, veto_requirements: [{id,label,score}] }
//   #90: { veto: ['Опыт B2B', ...] }
//   оба отсутствуют → triggered:false, items:[]
function normalizeVeto(source) {
  const items = [];
  const raw = source?.veto;

  if (Array.isArray(raw)) {
    for (const x of raw) {
      if (isNonEmpty(x)) items.push({ criterion_id: null, label: String(x).trim(), score: null });
    }
  } else if (raw === true) {
    const list = source.veto_requirements || source.veto_items || [];
    for (const x of list) {
      // Элементы здесь — объекты {id,label,score}, поэтому проверяем наличие объекта,
      // а не непустую строку (строковая проверка отбрасывала бы весь список целиком).
      if (!x || typeof x !== 'object') continue;
      items.push({ criterion_id: x.id ?? x.criterion_id ?? null, label: x.label || x.name || '', score: isNum(x.score) ? x.score : null });
    }
    // Флаг без списка — это факт сработавшего veto; строки рекрутер увидит по вердикту,
    // но пустой список молчать не должен.
    if (!items.length) items.push({ criterion_id: null, label: 'сработавший must-have (детали в источнике не приведены)', score: null });
  }

  return { triggered: raw === true || items.length > 0, items };
}

function weightOf(r) {
  const w = r?.weight;
  return isNum(w) && w > 0 ? w : 1;
}

function mustHaveOf(r) {
  if (r?.must_have === true || r?.must === true) return true;
  if (r?.must_have === false || r?.must === false) return false;
  const k = isStr(r?.klass) || isStr(r?.class) ? String(r.klass ?? r.class).toLowerCase() : '';
  if (k === 'must' || k === 'must-have' || k === 'required') return true;
  if (k === 'nice' || k === 'nice-to-have' || k === 'preferred') return false;
  return weightOf(r) >= 2;
}

function evidenceOf(r) {
  const ev = r?.evidence;
  if (isStr(ev) && ev.trim()) return { quote: ev.trim(), source_ref: isStr(r?.source_ref) ? r.source_ref : (isStr(r?.source) ? r.source : '') };
  if (ev && typeof ev === 'object') {
    return {
      quote: isStr(ev.quote) ? ev.quote : (isStr(ev.text) ? ev.text : ''),
      source_ref: isStr(ev.source_ref) ? ev.source_ref : (isStr(ev.source) ? ev.source : ''),
    };
  }
  return { quote: '', source_ref: '' };
}

// ── #89: результат интервью ───────────────────────────────────────────────────
// Фактическая схема: requirements[]{id,label,kind,must_have,weight,score,evidence,
// comment,reason}, coverage{covered[],missing[],...}, totals{...}, veto:boolean,
// communication{}, verdict, thresholds, slug, vacancy_id.
function adaptInterviewEval(json, { warnings = [] } = {}) {
  if (!json || typeof json !== 'object') return { rows: [], communication: null, veto: null, meta: null };

  const srcRows = Array.isArray(json.requirements)
    ? json.requirements
    : (Array.isArray(json.scoring) ? json.scoring : []);

  const rows = srcRows.map((r, i) => {
    const score = r?.score === null || r?.score === undefined || r?.score === 'n/a' ? null : r?.score;
    return {
      criterion_id: isNonEmpty(r?.id) ? r.id : `iv-${i + 1}`,
      label: r?.label || r?.criterion || r?.requirement || r?.name || '',
      kind: r?.kind,
      must_have: mustHaveOf(r),
      weight: weightOf(r),
      // null → статус выставит канон как not_discussed. Важно: 0 в этой схеме
      // допустим и означает явное несоответствие, а не «не обсуждалось».
      score: score === null ? null : score,
      evidence: evidenceOf(r),
      score_reason: r?.reason || r?.comment || '',
      clarification: '',
      basis: 'interview',
    };
  });

  // coverage.missing приходит как массив объектов {id,kind,label,reason}. Раньше рендер
  // склеивал String(obj) и получал «[object Object]» — здесь нормализуем в label.
  const coverage = (() => {
    const raw = json.coverage || {};
    const missing = Array.isArray(raw.missing)
      ? raw.missing.map(m => (isStr(m) ? { criterion_id: null, label: m } : { criterion_id: m?.id ?? null, label: m?.label || m?.name || '', reason: m?.reason || '' }))
      : [];
    if (missing.length) warnings.push(`покрытие интервью: не прозвучало ${missing.length} тем(ы)`);
    return { missing };
  })();

  const communication = normalizeCommunicationShape(json.communication);

  return {
    rows,
    communication,
    veto: normalizeVeto(json),
    coverage,
    meta: {
      vacancy_id: isStr(json.vacancy_id) ? json.vacancy_id : null,
      slug: isStr(json.slug) ? json.slug : null,
      verdict: isStr(json.verdict) ? json.verdict : null,
      roles_detected: json.roles_detected === true,
      thresholds: isStr(json.thresholds) ? json.thresholds : null,
    },
  };
}

// Схема #89: communication = {style:{label,score,evidence}, politeness:{...}, ...}
// Сводим к rows[]; готовые rows[]/metrics{} пропускаем как есть.
function normalizeCommunicationShape(comm) {
  if (!comm || typeof comm !== 'object') return null;
  if (Array.isArray(comm.rows)) return comm;
  if (comm.metrics && typeof comm.metrics === 'object') return comm;
  const rows = Object.entries(comm)
    .filter(([, v]) => v && typeof v === 'object')
    .map(([key, v]) => ({ metric: v.label || key, score: v.score ?? null, quote: v.evidence || v.reason || '' }));
  return rows.length ? { rows } : null;
}

// ── #90: результат «Запустить оценку» ──────────────────────────────────────────
// rows[]{name,klass,weight,score,evidence,source}. Единственный источник строк,
// когда интервью-оценки нет — иначе таблица требований была пустой при непустом проценте.
function adaptJobEval(json, { warnings = [] } = {}) {
  if (!json || typeof json !== 'object') return { rows: [], veto: null, meta: null };

  const src = Array.isArray(json.rows) && json.rows.length ? json.rows : [];
  if (!src.length && (json.percent !== null && json.percent !== undefined)) {
    warnings.push('у job-результата есть процент, но нет строк требований — таблица соответствия будет пустой');
  }

  const rows = src.map((r, i) => ({
    criterion_id: isNonEmpty(r?.id) ? r.id : `job-${i + 1}`,
    label: r?.name || r?.label || r?.criterion || '',
    kind: r?.kind,
    must_have: mustHaveOf(r),
    weight: weightOf(r),
    score: r?.score === null || r?.score === undefined || r?.score === 'n/a' ? null : r?.score,
    evidence: evidenceOf(r),
    score_reason: r?.reason || r?.comment || '',
    clarification: '',
    // Строки job — это оценка по документам, даже если часть подтверждена ATS.
    basis: r?.basis === 'interview' ? 'both' : 'documents',
  }));

  return {
    rows,
    veto: normalizeVeto(json),
    meta: {
      vacancy_id: isStr(json.vacancy_id) ? json.vacancy_id : null,
      vacancy_title: isStr(json.vacancy_title) ? json.vacancy_title : null,
      state: isStr(json.state) ? json.state : null,
      percent: isNum(json.percent) ? json.percent : null,
      verdict: isStr(json.verdict) ? json.verdict : null,
      comparison: json.comparison || null,
      spent_minutes: isNum(json.spent_minutes) ? json.spent_minutes : null,
    },
  };
}

// ── ATS-only ───────────────────────────────────────────────────────────────────
// Оценка по документам HH-ATS: отдельный индикатор, без строк. totals = null —
// документ показывает ATS отдельным показателем с явной пометкой, а не пустую
// таблицу требований с процентом рядом.
function adaptAtsOnly(json) {
  const ats = json?.ats_result || json?.ats || (json && typeof json === 'object' && isNum(json.score) ? json : null);
  if (!ats || !isNum(ats.score)) return null;
  return {
    score: ats.score,
    verdict: isStr(ats.verdict) ? ats.verdict : null,
    reasoning: isStr(ats.reasoning) ? ats.reasoning : '',
    matched: Array.isArray(ats.matched) ? ats.matched : [],
    gaps: Array.isArray(ats.gaps) ? ats.gaps : [],
  };
}

// ── legacy HR-Stalker ──────────────────────────────────────────────────────────
// В старой схеме score: 0 означало «не обсуждалось». На шкале 1–5 ноль не имеет
// смысла, поэтому 0 → status not_discussed, а НЕ «явное несоответствие».
function adaptLegacyHrStalker(json, { warnings = [] } = {}) {
  const list = Array.isArray(json?.rows) ? json.rows : (Array.isArray(json?.criteria) ? json.criteria : []);
  if (!list.length) return { rows: [], adapter_id: 'legacy_hr_stalker_v0' };

  let converted = 0;
  const rows = list.map((r, i) => {
    const raw = r?.score;
    const isZero = raw === 0 || raw === '0';
    if (isZero) converted++;
    return {
      criterion_id: isNonEmpty(r?.id) ? r.id : `legacy-${i + 1}`,
      label: r?.label || r?.name || r?.criterion || '',
      kind: r?.kind,
      must_have: mustHaveOf(r),
      weight: weightOf(r),
      // Ноль старой схемы — это «не обсуждалось», не отказ.
      score: isZero ? null : (raw === null || raw === undefined || raw === 'n/a' ? null : raw),
      evidence: evidenceOf(r),
      score_reason: isZero ? 'в старой схеме 0 = «не обсуждалось»' : (r?.reason || ''),
      clarification: '',
      basis: r?.basis || 'interview',
    };
  });

  if (converted) warnings.push(`legacy: ${converted} строк со score 0 переведены в «не обсуждалось»`);
  return { rows, adapter_id: 'legacy_hr_stalker_v0' };
}

// ── Выбор источника строк ─────────────────────────────────────────────────────
// Строки берутся РОВНО из одного источника: смешивать строки двух разных оценок
// запрещено (иначе «итог 100%» рядом со строкой 1/5 из чужой вакансии).
function pickRowSource({ interview, job, prefer = 'interview' }) {
  if (prefer === 'job' && job && job.rows.length) return { from: 'job', rows: job.rows };
  if (prefer === 'interview' && interview && interview.rows.length) return { from: 'interview', rows: interview.rows };
  if (interview && interview.rows.length) return { from: 'interview', rows: interview.rows };
  if (job && job.rows.length) return { from: 'job', rows: job.rows };
  return { from: null, rows: [] };
}

// Привязка к вакансии: тихая подмена чужой оценки недопустима — возвращаем ошибку
// с текстом «оценка для вакансии X, запрошена Y».
function checkVacancyMatch({ requestedVacancyId, ...sources }) {
  const checked = [
    ['интервью', sources.interview?.meta?.vacancy_id],
    ['оценка по документам', sources.job?.meta?.vacancy_id],
  ].filter(([, id]) => isNonEmpty(id));

  const mismatched = checked.filter(([, id]) => isNonEmpty(requestedVacancyId) && id !== requestedVacancyId);
  if (mismatched.length) {
    const got = [...new Set(mismatched.map(([, id]) => id))].join(', ');
    return { ok: false, error: `оценка для вакансии ${got}, запрошена ${requestedVacancyId} — пересчитай` };
  }
  if (!isNonEmpty(requestedVacancyId) && new Set(checked.map(([, id]) => id)).size > 1) {
    const got = [...new Set(checked.map(([, id]) => id))].join(', ');
    return { ok: false, error: `у кандидата оценки для разных вакансий (${got}) — укажи вакансию, чтобы выбрать` };
  }
  return { ok: true };
}

module.exports = {
  SCALE,
  adaptInterviewEval,
  adaptJobEval,
  adaptAtsOnly,
  adaptLegacyHrStalker,
  normalizeVeto,
  normalizeCommunicationShape,
  pickRowSource,
  checkVacancyMatch,
};