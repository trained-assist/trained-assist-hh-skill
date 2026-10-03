'use strict';
// Канонический результат оценки кандидата — сущность CandidateEvaluation (#120, канон v2).
//
// Одна оценка = один evaluation_id. Итоги, veto, вердикт и coverage ВСЕГДА считаются
// кодом из `rows` этого объекта и никогда не копируются из чужого артефакта. Раньше
// строки таблицы брались из результата интервью (#89), а percent/verdict — приоритетно
// из «Запустить оценку» (#90), и на пересечении вакансий документ рисовал «итог 100%»
// рядом со строкой `1/5` из другой оценки.
//
// Модуль чистый: не ходит в сеть, не вызывает LLM, не читает файлы. На вход — уже
// резолвленные источники (их нормализуют адаптеры src/hh-eval-adapters.js).

const { createHash } = require('crypto');

const SCHEMA_VERSION = 'candidate_evaluation_v2';

// Шкала 1–5 (R1 канона v2, OPM Structured Interview Guide). Ноль на этой шкале
// не имеет смысла: в шкале 0–5 он означал «явное несоответствие», что смешивалось
// с «не спрашивали». «Не обсуждалось» — отдельное состояние status, не 0.
const SCALE = { min: 1, max: 5, notDiscussed: 'n/a' };

// R1: veto вынесен в версионную политику, а не в шкалу.
const DEFAULT_POLICY = {
  scoring_policy_id: 'hh_portrait_v2',
  version: '2.0.0',
  veto_rule: 'must_have_score_lte_2',
  source: 'portrait',
};

const DEFAULT_THRESHOLDS = { pass: 75, review: 50 };

// Статус строки: 'scored' — есть балл, 'not_discussed' — тему не спрашивали,
// 'no_data' — данных нет (нет доступа к источнику).
const STATUSES = ['scored', 'not_discussed', 'no_data'];

// R4: экспертная проверка — поле в данных с 4 статусами; по умолчанию «нельзя проверить».
const EXPERT_STATUSES = ['verified', 'partial', 'incorrect', 'cannot_verify'];

// R6: профессиональные требования входят в итог, личностные — отдельная средняя.
const KINDS = { professional: 'professional', personality: 'personality' };

const BASISES = ['interview', 'documents', 'both'];

const VERDICTS = ['ПРОПУСТИТЬ', 'УТОЧНИТЬ', 'ОТКЛОНИТЬ'];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string';
const isNonEmpty = (v) => isStr(v) && v.trim() !== '';

// Балл приводится к 1–5. null/undefined/'n/a' → null (значит «не обсуждалось»,
// и статус выставит normalizeRow). Вне диапазона — clamp, но об этом пишем warning,
// чтобы молча не подменять оценку рекрутера.
function clampScore(raw, { id, warnings }) {
  if (raw === null || raw === undefined || raw === 'n/a' || raw === 'na') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n < SCALE.min || n > SCALE.max) {
    warnings.push(`${id || 'row'}: балл ${n} вне шкалы 1–5 — приведён к допустимому`);
    return Math.max(SCALE.min, Math.min(SCALE.max, Math.round(n)));
  }
  return Math.round(n);
}

function normalizeKind(raw) {
  const s = isStr(raw) ? raw.toLowerCase() : '';
  if (s === 'personality' || s === 'soft' || s === 'soft_skill' || s === 'личностн') return KINDS.personality;
  return KINDS.professional;
}

// 7 обязательных полей строки + экспертная проверка. Ни одно поле не выдумывается:
// отсутствующее → пустая строка/null, но не «-» и не правдоподобное значение.
function normalizeRow(input, { expertChecks = new Map(), warnings = [] } = {}) {
  const id = isNonEmpty(input?.criterion_id) ? input.criterion_id : null;
  const label = isNonEmpty(input?.label) ? input.label : '';
  const score = clampScore(input?.score, { id, warnings });

  // Статус выводится из балла и данных, а не берётся на веру: строка без балла
  // не может быть 'scored', а строка с баллом обязана быть 'scored'.
  let status = isNonEmpty(input?.status) ? input.status : null;
  if (!STATUSES.includes(status)) {
    status = score === null
      ? (isNonEmpty(input?.missing_reason) ? 'no_data' : 'not_discussed')
      : 'scored';
  }
  if (status === 'scored' && score === null) status = 'not_discussed';

  const basis = BASISES.includes(input?.basis) ? input.basis : null;
  const ev = input?.evidence || {};

  const row = {
    criterion_id: id,
    label,
    kind: normalizeKind(input?.kind),
    must_have: input?.must_have === true,
    weight: isNum(input?.weight) && input.weight > 0 ? input.weight : 1,
    status,
    basis,
    score: status === 'scored' ? score : null,
    evidence: {
      quote: isStr(ev.quote) ? ev.quote : '',
      source_ref: isStr(ev.source_ref) ? ev.source_ref : '',
    },
    score_reason: isStr(input?.score_reason) ? input.score_reason : '',
    clarification: isStr(input?.clarification) ? input.clarification : '',
  };

  // Правило потолка (канон v2, §4): экспертная проверка «неверно» → score ≤ 2,
  // «частично верно» → ≤ 3. Применяется ТОЛЬКО когда проверка проведена и статус
  // выставлен; cannot_verify (проверки не было) потолка не даёт.
  const check = id ? expertChecks.get(id) : null;
  if (check) {
    row.expert_check = {
      status: EXPERT_STATUSES.includes(check.status) ? check.status : 'cannot_verify',
      basis: isStr(check.basis) ? check.basis : '',
      checked_at: isStr(check.checked_at) ? check.checked_at : '',
    };
    if (row.status === 'scored') {
      const cap = { incorrect: 2, partial: 3 }[row.expert_check.status];
      if (cap !== undefined && row.score > cap) {
        warnings.push(`${id || label}: экспертная проверка «${row.expert_check.status}» — балл ${row.score} понижен до ${cap}`);
        row.score = cap;
      }
    }
  } else {
    // Проверки не было — это не «всё верно», а «проверить нельзя».
    row.expert_check = { status: 'cannot_verify', basis: '', checked_at: '' };
  }

  return row;
}

function normalizeExpertChecks(list, warnings) {
  const out = [];
  const seen = new Set();
  for (const c of list || []) {
    if (!isNonEmpty(c?.criterion_id)) {
      warnings.push('экспертная проверка без criterion_id — пропущена');
      continue;
    }
    if (seen.has(c.criterion_id)) {
      warnings.push(`${c.criterion_id}: повторная экспертная проверка — взята последняя`);
    }
    seen.add(c.criterion_id);
    out.push({
      criterion_id: c.criterion_id,
      status: EXPERT_STATUSES.includes(c.status) ? c.status : 'cannot_verify',
      basis: isStr(c.basis) ? c.basis : '',
      checked_at: isStr(c.checked_at) ? c.checked_at : '',
    });
  }
  return out;
}

// Взвешенная средняя подмножества строк. В числитель и знаменатель входят ТОЛЬКО
// строки со статусом 'scored': «не обсуждалось» не должно ни повышать, ни ронять итог,
// иначе покрытие влияет на оценку (тот самый эффект, который ловили в #91).
function aggregate(rows) {
  let sum = 0;
  let max = 0;
  let counted = 0;
  for (const r of rows) {
    if (r.status !== 'scored' || r.score === null) continue;
    const w = r.weight;
    sum += r.score * w;
    max += SCALE.max * w;
    counted++;
  }
  if (!counted || !max) return { percent: null, score10: null, counted: 0, not_discussed: 0, no_data: 0, total: 0 };
  const percent = Math.round((sum / max) * 100);
  return {
    percent,
    score10: Math.round(percent) / 10,
    counted,
    not_discussed: rows.filter(r => r.status === 'not_discussed').length,
    no_data: rows.filter(r => r.status === 'no_data').length,
    total: rows.length,
  };
}

// Политика версии: если правила оценки изменились после расчёта — результат помечается
// устаревшим, но НЕ переписывается (R7).
function resolvePolicy(inputPolicy, atsConfigPolicy) {
  const picked = (inputPolicy && typeof inputPolicy === 'object') ? inputPolicy
    : (atsConfigPolicy && typeof atsConfigPolicy === 'object') ? atsConfigPolicy
      : DEFAULT_POLICY;
  return {
    scoring_policy_id: isNonEmpty(picked.scoring_policy_id) ? picked.scoring_policy_id : DEFAULT_POLICY.scoring_policy_id,
    version: isNonEmpty(picked.version) ? picked.version : DEFAULT_POLICY.version,
    veto_rule: isNonEmpty(picked.veto_rule) ? picked.veto_rule : DEFAULT_POLICY.veto_rule,
    source: isNonEmpty(picked.source) ? picked.source : DEFAULT_POLICY.source,
  };
}

function vetoFor(rows, policy) {
  const items = [];
  const limit = policy.veto_rule === 'must_have_score_lte_1' ? 1 : 2;
  for (const r of rows) {
    if (!r.must_have || r.status !== 'scored' || r.score === null) continue;
    if (r.score <= limit) items.push({ criterion_id: r.criterion_id, label: r.label, score: r.score });
  }
  return { triggered: items.length > 0, items };
}

function verdictFor(totals, veto, thresholds) {
  if (veto.triggered) return 'ОТКЛОНИТЬ';
  if (totals.overall.percent === null) return null;
  if (totals.overall.percent >= thresholds.pass) return 'ПРОПУСТИТЬ';
  if (totals.overall.percent >= thresholds.review) return 'УТОЧНИТЬ';
  return 'ОТКЛОНИТЬ';
}

function coverageFor(rows) {
  const evaluated = rows.filter(r => r.status === 'scored').length;
  const not_discussed = rows.filter(r => r.status === 'not_discussed').length;
  const no_data = rows.filter(r => r.status === 'no_data').length;
  const total = rows.length;
  return {
    evaluated,
    not_discussed,
    no_data,
    total,
    // Покрытие — доля требований, по которым вообще есть балл. Знаменатель = все строки,
    // поэтому низкое покрытие видно сразу и не прячется за «нет данных».
    percent: total ? Math.round((evaluated / total) * 100) : null,
    missing: rows.filter(r => r.status !== 'scored').map(r => ({ criterion_id: r.criterion_id, label: r.label, status: r.status })),
  };
}

// evaluation_id = sha256(candidate_id|vacancy_id|requirements_revision|policy_version|docs_digest).
// Меняется вакансия, версия требований, версия политики или набор документов —
// меняется id, и две разные оценки физически не могут быть помечены одним id.
function evaluationId({ candidateId, vacancyId, requirementsRevision, policyVersion, docsDigest }) {
  const material = [candidateId ?? '', vacancyId ?? '', requirementsRevision ?? '', policyVersion ?? '', docsDigest ?? ''].join('|');
  return createHash('sha256').update(material).digest('hex').slice(0, 12);
}

// Собирает канонический объект. Ничего не выдумывает: отсутствующий источник даёт
// честный ноль строк и null-итоги, а не данные из соседней вакансии.
//
// Опции:
//   rows         — строки от адаптера (уже нормализованные к 1–5)
//   rows_from    — 'interview' | 'job': каким источником взяты строки (для provenance)
//   requirements — { revision, source, count }
//   expert_checks — [{criterion_id, status, basis, checked_at}]
//   ats          — { score, verdict, reasoning } | null (отдельный показатель)
//   comparison   — { available:false, reason } | { available:true, ... }
//   docs         — [{doc_id, type, role, sha256}] ВСЕ документы манифеста
//   now          — дата среза
function buildCanonical({
  candidateId,
  vacancyId = null,
  vacancyTitle = null,
  rows = [],
  rowsFrom = null,
  requirements = {},
  expertChecks = [],
  ats = null,
  comparison = null,
  docs = [],
  provenance = {},
  communication: inputCommunication = null,
  policy: policyInput = null,
  thresholds: thresholdsInput = null,
  limitations = [],
  warnings: warningsInput = [],
  now = new Date(),
} = {}) {
  if (!isNonEmpty(candidateId)) throw new Error('buildCanonical: candidate_id обязателен');

  const warnings = Array.isArray(warningsInput) ? [...warningsInput] : [];

  const req = {
    revision: isNonEmpty(requirements.revision) ? requirements.revision : 'unknown',
    source: isNonEmpty(requirements.source) ? requirements.source : 'unknown',
    count: rows.length,
  };

  const policy = resolvePolicy(policyInput, null);
  const checks = normalizeExpertChecks(expertChecks, warnings);
  const expertChecksById = new Map(checks.map(c => [c.criterion_id, c]));

  const normalized = rows.map(r => normalizeRow(r, { expertChecks: expertChecksById, warnings }));

  // Без критериев стабильных id строки склеиваются при смене порядка — предупреждаем.
  const withoutId = normalized.filter(r => !r.criterion_id).length;
  if (withoutId) warnings.push(`${withoutId} строк без criterion_id — при смене порядка требований строки переставятся местами`);

  // B9: документы вне скоринга не теряются молча — они в warnings списком.
  const scoredTypes = new Set(['resume', 'cover_letter', 'correspondence', 'interview']);
  const outOfScope = (docs || []).filter(d => d && !scoredTypes.has(d.type));
  if (outOfScope.length) {
    warnings.push(`в оценку не вошли: ${outOfScope.map(d => d.type).join(', ')} — на них нет требований в портрете`);
  }

  const professional = aggregate(normalized.filter(r => r.kind === KINDS.professional));
  const personality = aggregate(normalized.filter(r => r.kind === KINDS.personality));
  const overall = aggregate(normalized);
  const veto = vetoFor(normalized, policy);

  const thresholds = {
    pass: isNum(thresholdsInput?.pass) ? thresholdsInput.pass : DEFAULT_THRESHOLDS.pass,
    review: isNum(thresholdsInput?.review) ? thresholdsInput.review : DEFAULT_THRESHOLDS.review,
  };

  const totals = {
    professional,
    personality,
    // R6: личностная средняя не подмешивается в общий итог — она отдельное число.
    overall,
    veto,
    verdict: null,
    thresholds,
  };
  // Вердикт считается после того, как totals собран: он читает overall.percent и veto.
  totals.verdict = verdictFor(totals, veto, thresholds);

  const docsDigest = createHash('sha256')
    .update((docs || []).map(d => `${d?.doc_id ?? ''}:${d?.sha256 ?? ''}`).sort().join('|'))
    .digest('hex')
    .slice(0, 16);

  const evaluationIdValue = evaluationId({
    candidateId,
    vacancyId,
    requirementsRevision: req.revision,
    policyVersion: policy.version,
    docsDigest,
  });

  const comparisonValue = (() => {
    if (!comparison) return { available: false, reason: 'сравнение не рассчитывалось' };
    if (comparison.available === false) {
      return { available: false, reason: isNonEmpty(comparison.reason) ? comparison.reason : 'сравнение недоступно' };
    }
    return { available: true, ...comparison };
  })();

  const generatedAt = now instanceof Date ? now.toISOString() : new Date().toISOString();

  return {
    schema_version: SCHEMA_VERSION,
    evaluation_id: evaluationIdValue,
    candidate_id: candidateId,
    vacancy_id: vacancyId,
    vacancy_title: isNonEmpty(vacancyTitle) ? vacancyTitle : null,
    requirements: req,
    rows: normalized,
    rows_from: rowsFrom,
    expert_checks: checks,
    coverage: coverageFor(normalized),
    communication: (provenance && provenance.communication) || (inputCommunication) || null,
    totals,
    policy,
    // ATS — отдельный показатель, в rows не подмешивается (иначе «10-балльный HH»
    // сравнивался бы с «5-балльными» требованиями).
    ats: ats && isNum(ats.score) ? { score: ats.score, verdict: ats.verdict ?? null, reasoning: isStr(ats.reasoning) ? ats.reasoning : '' } : null,
    comparison: comparisonValue,
    provenance: {
      docs: Array.isArray(docs) ? docs.map(d => ({
        doc_id: isStr(d?.doc_id) ? d.doc_id : '',
        type: isStr(d?.type) ? d.type : 'other',
        role: isStr(d?.role) ? d.role : 'source',
        sha256: isStr(d?.sha256) ? d.sha256 : '',
      })) : [],
      interview_eval_path: isStr(provenance?.interview_eval_path) ? provenance.interview_eval_path : null,
      job_path: isStr(provenance?.job_path) ? provenance.job_path : null,
      ats_path: isStr(provenance?.ats_path) ? provenance.ats_path : null,
    },
    limitations: Array.isArray(limitations) ? limitations.filter(isStr) : [],
    warnings,
    generated_at: generatedAt,
  };
}

// Проверка контракта: типы обязательны, значения — из допустимых множеств.
// Рендеры и JSON-экспорт полагаются на эти инварианты, поэтому валидатор обязателен.
function validateCanonical(ev) {
  const errors = [];
  const fail = (m) => errors.push(m);
  if (!ev || typeof ev !== 'object') return ['evaluation: не объект'];
  if (!isNonEmpty(ev.evaluation_id)) fail('evaluation_id обязателен');
  if (!isNonEmpty(ev.candidate_id)) fail('candidate_id обязателен');
  if (!Array.isArray(ev.rows)) fail('rows обязан быть массивом');
  else {
    ev.rows.forEach((r, i) => {
      if (!isNonEmpty(r.criterion_id)) fail(`rows[${i}]: criterion_id обязателен`);
      if (!isNonEmpty(r.label)) fail(`rows[${i}]: label обязателен`);
      if (!STATUSES.includes(r.status)) fail(`rows[${i}]: status «${r.status}» не из ${STATUSES.join('|')}`);
      if (r.status === 'scored' && (r.score === null || r.score < SCALE.min || r.score > SCALE.max)) {
        fail(`rows[${i}]: балл ${r.score} вне 1–5 при status=scored`);
      }
      if (r.status !== 'scored' && r.score !== null) fail(`rows[${i}]: score обязан быть null при status=${r.status}`);
      if (!KINDS[r.kind]) fail(`rows[${i}]: kind «${r.kind}» неизвестен`);
      if (r.expert_check && !EXPERT_STATUSES.includes(r.expert_check.status)) fail(`rows[${i}]: expert_check.status неизвестен`);
    });
  }
  if (ev.totals?.veto && typeof ev.totals.veto.triggered !== 'boolean') fail('totals.veto.triggered обязан быть boolean');
  if (ev.totals?.verdict !== null && !VERDICTS.includes(ev.totals.verdict)) fail(`totals.verdict «${ev.totals.verdict}» неизвестен`);
  if (ev.comparison && ev.comparison.available === false && !isNonEmpty(ev.comparison.reason)) {
    fail('comparison.available=false обязан нести причину');
  }
  return errors;
}

module.exports = {
  SCHEMA_VERSION,
  SCALE,
  DEFAULT_POLICY,
  DEFAULT_THRESHOLDS,
  STATUSES,
  EXPERT_STATUSES,
  KINDS,
  BASISES,
  VERDICTS,
  aggregate,
  clampScore,
  evaluationId,
  buildCanonical,
  validateCanonical,
  vetoFor,
  verdictFor,
  coverageFor,
  normalizeRow,
};