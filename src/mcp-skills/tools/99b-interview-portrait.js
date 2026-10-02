'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Интервью → требования портрета (#89, эпик #83 фаза 3).
//
// Вход (контракт #88): ~/agent-data/hh/<user>/interviews/<slug>/structure.json =
//   {speakers_detected: bool, turns: [{speaker, role: recruiter|candidate, text, t}]}.
// Требования: contexts/hh/portrait:{vacancyId}.json (src/hh-portrait.js).
// Веса/пороги: ats_config:{vacancyId} (src/hh-scoring.js readAtsConfig).
//
// Канон оценки (канон документов v2 #120, исследование из #83):
//   * балл 1–5 целыми с поведенческими анкерами: 1 = явно нет опыта, 3 = делал,
//     5 = системный опыт с измеримыми результатами; «не обсуждалось» = n/a, НЕ 0;
//   * веса из ats_config: required = 2 (must-have), preferred = 1; без конфига —
//     hard skills / опыт = 2, soft skills / образование = 1;
//   * итог Σ(s×w)/Σ(5×w) → percent + перевод в 0–10 под пороги 6.5 / 4.0;
//   * veto: must-have с баллом ≤1 → вердикт ОТКЛОНИТЬ независимо от суммы;
//   * evidence — обязательная цитата из транскрипта, балл без цитаты не засчитывается;
//   * communication — параллельная ось (стиль, вежливость, словарный запас,
//     структурированность): отдельный блок, В итоговый скор требований не входит;
//   * coverage — что прозвучало / что нет (для отчёта и вопросов на следующий этап).
//
// Механика (как в 99-interview-analysis.js): один JSON-only LLM-вызов через
// hh-llm (purpose default, temperature 0.2), идемпотентный кэш
// <slug>.interview-eval.json + markdown-рендер, force — пересчёт.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { hhLlm, ladderToken } = require('../../hh-llm');
const { readPortrait } = require('../../hh-portrait');
const { readAtsConfig } = require('../../hh-scoring');
const { dataRoot, profileWorkDir } = require('../../data-paths');

// Маркер системного промпта — по нему фикстуры LLM (tests/support/llm-provider-fixture.cjs)
// узнают этот вызов и отдают структурированную оценку.
const PROMPT_MARKER = 'ОЦЕНКА ИНТЕРВЬЮ ПО ТРЕБОВАНИЯМ ПОРТРЕТА';

const DEFAULT_THRESHOLDS = { pass: 6.5, review: 4.0 };
const COMM_KEYS = ['style', 'politeness', 'vocabulary', 'structure'];
const COMM_LABELS = {
  style: 'Стиль общения',
  politeness: 'Вежливость',
  vocabulary: 'Глубина словарного запаса',
  structure: 'Структурированность ответов',
};

function userId() {
  return process.env.USER_ID || 'default';
}

function slugName(name) {
  return String(name || '')
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'candidate';
}

// Хранение — по контракту #88: ~/agent-data/hh/<user>/interviews/<slug>/.
function interviewDir(slug) {
  return path.join(dataRoot(), 'hh', userId(), 'interviews', slugName(slug));
}

function structureFile(slug) {
  return path.join(interviewDir(slug), 'structure.json');
}

function evalFile(slug) {
  return path.join(interviewDir(slug), `${slugName(slug)}.interview-eval.json`);
}

function evalMdFile(slug) {
  return path.join(interviewDir(slug), `${slugName(slug)}.interview-eval.md`);
}

function resolveVacancyId(vacancyId) {
  if (vacancyId && String(vacancyId).trim()) return String(vacancyId).trim();
  try {
    const file = path.join(profileWorkDir(), 'contexts', 'hh', 'active_vacancy.json');
    const active = JSON.parse(fs.readFileSync(file, 'utf8'))?.value;
    return active?.id || 'draft';
  } catch {
    return 'draft';
  }
}

// ── Вход: structure.json ──────────────────────────────────────────────────────

function loadStructure(slug) {
  const file = structureFile(slug);
  if (!fs.existsSync(file)) {
    return { error: `Структура интервью не найдена: ${file}. Нужен structure.json {speakers_detected, turns[{speaker, role, text, t}]} — сначала распознай интервью (issue #88), затем оценивай.` };
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { error: `structure.json не читается как JSON (${e.message}): ${file}` };
  }
  const turns = (Array.isArray(data?.turns) ? data.turns : [])
    .filter(t => t && typeof t === 'object' && String(t.text || '').trim());
  if (!turns.length) return { error: `structure.json без реплик: ${file}` };
  return { data: { ...data, turns }, file };
}

function formatT(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n)) return null;
  const s = Math.max(0, Math.round(n));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ── Диалог: реплики рекрутера = вопросы, кандидата = ответы ──────────────────
// speakers_detected:false → работаем построчно БЕЗ ролей: роль по первому вопросу
// не выдумываем, честно помечаем в ответе (эпик #83 фаза 3).

function buildDialogue(structure) {
  const turns = structure?.turns || [];
  const rolesPresent = turns.some(t => t.role === 'recruiter') && turns.some(t => t.role === 'candidate');
  const rolesDetected = structure?.speakers_detected !== false && rolesPresent;

  if (!rolesDetected) {
    return {
      roles_detected: false,
      qa: [],
      lines: turns.map((t, i) => {
        const stamp = formatT(t.t);
        return `[${i + 1}] ${t.speaker || 'Спикер'}${stamp ? ` (${stamp})` : ''}: ${String(t.text).trim()}`;
      }),
    };
  }

  const qa = [];
  for (const t of turns) {
    const text = String(t.text).trim();
    const stamp = formatT(t.t);
    if (t.role === 'recruiter') {
      qa.push({ question: text, t: t.t, answers: [] });
    } else if (qa.length) {
      qa[qa.length - 1].answers.push({ text, t: t.t, speaker: t.speaker });
    } else {
      // Ответ без предыдущего вопроса (обрезанное начало) — сохраняем как есть.
      qa.push({ question: null, answers: [{ text, t: t.t, speaker: t.speaker }] });
    }
  }

  const lines = [];
  qa.forEach((item, i) => {
    const qStamp = formatT(item.t);
    lines.push(`[${i + 1}] Вопрос${qStamp ? ` (${qStamp})` : ''}: ${item.question || '(вопрос не записан)'}`);
    for (const a of item.answers) {
      const aStamp = formatT(a.t);
      lines.push(`    Ответ${aStamp ? ` (${aStamp})` : ''}: ${a.text}`);
    }
  });
  return { roles_detected: true, qa, lines };
}

// ── Требования: портрет + веса/пороги из ats_config ──────────────────────────

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?"«»]+$/g, '')
    .trim();
}

function atsNameMaps(cfg) {
  const required = new Map();
  const preferred = new Map();
  const fill = (list, target, defWeight) => {
    for (const c of Array.isArray(list) ? list : []) {
      const key = normName(c && typeof c === 'object' ? (c.name || c.criterion) : c);
      if (!key) continue;
      const w = Number(c && typeof c === 'object' ? c.weight : NaN);
      target.set(key, Number.isFinite(w) && w > 0 ? w : defWeight);
    }
  };
  fill(cfg?.required, required, 2);
  fill(cfg?.preferred, preferred, 1);
  return { required, preferred };
}

// Каждое требование портрета → пункт оценки. Веса: ats_config, если он есть
// (required→2 must-have, preferred→1), иначе правила портрета (hard/опыт→2,
// soft/образование→1). Требования, которые есть только в АТС (правил редактора),
// добавляются — иначе итог разошёлся бы с фоновым скорингом.
function buildRequirements(portrait, atsConfig) {
  const req = portrait?.requirements || {};
  const { required, preferred } = atsNameMaps(atsConfig);
  const items = [];
  const seen = new Set();

  const weightsFor = (label, defWeight, defMust) => {
    const key = normName(label);
    if (required.has(key)) return [required.get(key), true];
    if (preferred.has(key)) return [preferred.get(key), false];
    return [defWeight, defMust];
  };

  const add = (kind, label, weight, must) => {
    const key = normName(label);
    if (!key || seen.has(key)) return;
    seen.add(key);
    items.push({ id: `req-${items.length + 1}`, kind, label: String(label).trim(), weight, must_have: must });
  };
  const addLabeled = (kind, label, defWeight, defMust) => {
    const [weight, must] = weightsFor(label, defWeight, defMust);
    add(kind, label, weight, must);
  };

  for (const s of req.hard_skills || []) addLabeled('hard_skill', s, 2, true);
  for (const s of req.soft_skills || []) addLabeled('soft_skill', s, 1, false);
  if (req.experience) addLabeled('experience', `Опыт работы: ${req.experience}`, 2, true);
  if (req.education) addLabeled('education', `Образование: ${req.education}`, 1, false);

  for (const c of atsConfig?.required || []) {
    const name = c && typeof c === 'object' ? (c.name || c.criterion) : c;
    add('ats_required', name, Number(c?.weight) > 0 ? Number(c.weight) : 2, true);
  }
  for (const c of atsConfig?.preferred || []) {
    const name = c && typeof c === 'object' ? (c.name || c.criterion) : c;
    add('ats_preferred', name, Number(c?.weight) > 0 ? Number(c.weight) : 1, false);
  }
  return items;
}

// ── Промпт ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = [
  `Ты — рекрутер-аналитик. Перед тобой список ТРЕБОВАНИЙ ПОРТРЕТА вакансии и расшифровка интервью: ${PROMPT_MARKER}.`,
  'Ответ — ТОЛЬКО валидный JSON без markdown и пояснений, по схеме:',
  '{"requirements":[{"id":str,"score":1..5|"n/a","evidence":str,"comment":str}],"communication":{"style":{"score":1..5,"evidence":str},"politeness":{"score":1..5,"evidence":str},"vocabulary":{"score":1..5,"evidence":str},"structure":{"score":1..5,"evidence":str}}}',
  '',
  'ШКАЛА 1–5 по каждому требованию (анкоры обязательны):',
  '1 — явно нет опыта / не соответствует требованию: кандидат прямо подтвердил отсутствие навыка или опыта;',
  '2 — теория без практики: тема затронута, но кандидат сам этого не делал, ответы общие;',
  '3 — делал, но без достаточной самостоятельности или без деталей: опыт есть, глубина не раскрыта;',
  '4 — уверенно и самостоятельно: подтверждено конкретными примерами из своей практики;',
  '5 — системный опыт с измеримыми результатами: заметно больше требуемого, с цифрами и масштабом.',
  '"n/a" — тема НЕ обсуждалась: не спрашивали или ответа нет. Это ОТДЕЛЬНОЕ состояние, а не ноль: НЕ СТАВЬ 1 за молчание — 1 означает явное несоответствие.',
  '',
  'Правила:',
  '- Оцени ровно тот список id, который дан, и верни КАЖДОЙ id ровно один раз.',
  '- evidence ОБЯЗАТЕЛЕН при числовом балле: точная цитата из ответа кандидата + [реплика N] (и время, если есть). Балл без цитаты не засчитывается — ставь n/a и объясни в comment.',
  '- Не выдумывай оценки: если в транскрипте нет ответа на требование — это n/a, а не 1.',
  '- Ничего не выдумывай: только то, что есть в транскрипте. ASR-ошибки и сленг игнорируй, опирайся на смысл.',
  '- communication — ОТДЕЛЬНАЯ ось (стиль общения, вежливость, глубина словарного запаса, структурированность ответов): каждая 1–5 + цитата. Она НЕ входит в итоговый скор требований.',
].join('\n');

function buildUserPrompt(requirements, dialogue) {
  const reqLines = requirements.map(r =>
    `${r.id} [${r.kind} · вес ${r.weight}${r.must_have ? ' · must-have' : ''}] ${r.label}`);
  const rolesLine = dialogue.roles_detected
    ? 'Роли распознаны: реплики рекрутера — вопросы, кандидата — ответы.'
    : 'Роли НЕ распознаны в этой расшифровке — не выдумывай, кто кого спрашивал; оценивай только содержание реплик.';
  return [
    '=== ТРЕБОВАНИЯ ПОРТРЕТА (оценить каждое, вернуть все id) ===',
    reqLines.join('\n'),
    '',
    '=== РОЛИ ===',
    rolesLine,
    '',
    '=== РАСШИФРОВКА ИНТЕРВЬЮ ===',
    dialogue.lines.join('\n'),
  ].join('\n');
}

// Достаём JSON даже если модель обернула в ```json ... ``` (паттерн 99-interview-analysis).
function parseLlmJson(content) {
  let c = String(content).trim();
  if (c.startsWith('```')) c = c.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(c);
  } catch {
    const s = c.indexOf('{');
    const e = c.lastIndexOf('}');
    if (s >= 0 && e > s) return JSON.parse(c.slice(s, e + 1));
    throw new Error('LLM did not return valid JSON');
  }
}

// ── Нормализация ответа модели ────────────────────────────────────────────────

function normalizeScore(v) {
  if (v === null || v === undefined) return { score: null, kind: 'na' };
  if (typeof v === 'number' && Number.isFinite(v)) return { score: Math.max(0, Math.min(5, Math.round(v))), kind: 'number' };
  const s = String(v).trim();
  if (!s || /^n\/?a$/i.test(s) || s === '-') return { score: null, kind: 'na' };
  const n = Number(s.replace(',', '.'));
  if (Number.isFinite(n)) return { score: Math.max(0, Math.min(5, Math.round(n))), kind: 'number' };
  return { score: null, kind: 'invalid' };
}

function normalizeRequirements(raw, requirements) {
  const byId = new Map();
  for (const r of Array.isArray(raw?.requirements) ? raw.requirements : []) {
    if (r && r.id !== undefined && r.id !== null) byId.set(String(r.id), r);
  }
  const warnings = [];
  const items = requirements.map(req => {
    const r = byId.get(req.id);
    const evidence = String(r?.evidence || '').trim() || null;
    const comment = r?.comment ? String(r.comment).trim() : null;
    const out = { ...req, score: null, evidence, comment, reason: null };
    if (!r) {
      out.reason = 'модель не вернула оценку по этому требованию';
      warnings.push(`${req.id}: оценка отсутствует в ответе модели`);
      return out;
    }
    const { score, kind } = normalizeScore(r.score);
    if (kind === 'invalid') {
      out.reason = 'некорректный балл от модели — не засчитан';
      warnings.push(`${req.id}: некорректный балл ${JSON.stringify(r.score)}`);
      return out;
    }
    if (score === null) {
      out.reason = 'не прозвучало в интервью';
      return out;
    }
    if (!evidence) {
      out.reason = 'нет цитаты (evidence) — балл не засчитан';
      warnings.push(`${req.id}: балл ${score} без evidence — понижен до n/a`);
      return out;
    }
    out.score = score;
    return out;
  });

  const known = new Set(requirements.map(r => r.id));
  const unknown = [...byId.keys()].filter(id => !known.has(id));
  if (unknown.length) warnings.push(`модель вернула неизвестные id: ${unknown.join(', ')}`);
  return { items, warnings };
}

function normalizeCommunication(raw) {
  const src = raw?.communication && typeof raw.communication === 'object' ? raw.communication : {};
  const out = {};
  for (const key of COMM_KEYS) {
    const entry = Array.isArray(src) ? src[COMM_KEYS.indexOf(key)] : src[key];
    const { score, kind } = normalizeScore(entry?.score);
    const evidence = String(entry?.evidence || '').trim() || null;
    out[key] = {
      label: COMM_LABELS[key],
      score: kind === 'number' && evidence ? score : null,
      evidence,
      reason: kind === 'number' && evidence
        ? null
        : (kind === 'number' ? 'нет цитаты (evidence)' : 'не прозвучало в интервью'),
    };
  }
  return out;
}

// ── Итоги: Σ(s×w)/Σ(5×w) → percent + 0–10; veto must-have ≤1 ────────────────

function computeTotals(items) {
  let sum = 0;
  let max = 0;
  let counted = 0;
  let na = 0;
  for (const it of items) {
    if (it.score === null) { na += 1; continue; }
    sum += it.score * it.weight;
    max += 5 * it.weight;
    counted += 1;
  }
  const percent = max ? Math.round((sum / max) * 100) : null;
  return {
    formula: 'Σ(score×weight)/Σ(5×weight)',
    sum_sw: sum,
    sum_5w: max,
    percent,
    score_10: percent === null ? null : Math.round(percent) / 10,
    counted,
    na,
    total: items.length,
  };
}

function decideVerdict(totals, items, thresholds) {
  const vetoRequirements = items
    .filter(i => i.must_have && i.score !== null && i.score <= 1)
    .map(i => ({ id: i.id, label: i.label, score: i.score }));
  let verdict;
  if (vetoRequirements.length) verdict = 'ОТКЛОНИТЬ';
  else if (totals.score_10 === null) verdict = 'НЕТ ДАННЫХ';
  else if (totals.score_10 >= thresholds.pass) verdict = 'ПРОПУСТИТЬ';
  else if (totals.score_10 >= thresholds.review) verdict = 'УТОЧНИТЬ';
  else verdict = 'ОТКЛОНИТЬ';
  return { verdict, veto: vetoRequirements.length > 0, veto_requirements: vetoRequirements };
}

function buildCoverage(items) {
  const covered = items.filter(i => i.score !== null)
    .map(i => ({ id: i.id, kind: i.kind, label: i.label, score: i.score, weight: i.weight }));
  const missing = items.filter(i => i.score === null)
    .map(i => ({ id: i.id, kind: i.kind, label: i.label, reason: i.reason || 'не прозвучало в интервью' }));
  return {
    covered,
    missing,
    covered_count: covered.length,
    missing_count: missing.length,
    percent: items.length ? Math.round((covered.length / items.length) * 100) : 0,
  };
}

// ── Markdown-рендер (паттерн renderMarkdown из 99-interview-analysis.js) ─────

function renderMarkdown(d) {
  const sec = t => `\n## ${t}\n\n`;
  const m = [`# Интервью → требования портрета: ${d.slug} (вакансия ${d.vacancy_id})\n`];
  const t = d.totals || {};
  m.push(`**Итог: ${t.percent ?? '?'}% · ${t.score_10 ?? '?'} / 10 — ${d.verdict || '?'}**` +
    `${d.veto ? ` (veto: must-have ≤1 — ${d.veto_requirements.map(v => v.label).join('; ')})` : ''}\n`);
  m.push(`Роли в интервью: ${d.roles_detected ? 'распознаны (рекрутер ↔ кандидат)' : 'НЕ распознаны — оценка по тексту без разделения ролей'}\n`);
  if (d.warnings?.length) m.push(sec('Замечания') + d.warnings.map(w => `- ${w}`).join('\n'));

  if (d.requirements?.length) {
    m.push(sec('Требования') + '| Требование | Вес | Must-have | Балл 0-5 | Evidence |\n|---|---|---|---|---|');
    for (const r of d.requirements) {
      const ev = `${r.evidence || r.reason || ''}${r.comment ? ` — ${r.comment}` : ''}`
        .replace(/\|/g, '\\|').replace(/\n/g, ' ');
      m.push(`| ${r.label} | ${r.weight} | ${r.must_have ? 'да' : 'нет'} | ${r.score === null ? 'n/a' : r.score} | ${ev} |`);
    }
  }

  const c = d.coverage || {};
  m.push(sec('Покрытие интервью'));
  m.push(`Было в интервью (${c.covered_count ?? 0}):\n` +
    ((c.covered || []).map(x => `- ${x.label} → ${x.score}/5`).join('\n') || '- нет') + '\n');
  m.push(`\nНе прозвучало (${c.missing_count ?? 0}) — спросить на следующем этапе:\n` +
    ((c.missing || []).map(x => `- ${x.label} (${x.reason})`).join('\n') || '- нет') + '\n');

  const comm = d.communication || {};
  if (Object.keys(comm).length) {
    m.push(sec('Коммуникация — отдельная ось, в итоговый скор не входит'));
    for (const key of COMM_KEYS) {
      const item = comm[key];
      if (!item) continue;
      m.push(`- **${item.label || COMM_LABELS[key]}**: ${item.score === null ? 'n/a' : `${item.score}/5`}` +
        `${item.evidence ? ` — «${item.evidence}»` : item.reason ? ` — ${item.reason}` : ''}`);
    }
  }
  return m.join('\n') + '\n';
}

// ── Tools ────────────────────────────────────────────────────────────────────

async function evaluateHandler({ slug, vacancy_id, force } = {}) {
  if (!slug || !String(slug).trim()) {
    return { error: 'slug обязателен: папка интервью interviews/<slug> со structure.json.' };
  }
  const name = slugName(slug);
  const vid = resolveVacancyId(vacancy_id);
  const wd = profileWorkDir();

  const portrait = readPortrait(wd, vid);
  if (!portrait) {
    return { error: `Портрет для вакансии «${vid}» не найден (contexts/hh/portrait:${vid}.json). Сначала собери требования через hh_portrait_extract — оценивать интервью «в пустоту» нельзя.` };
  }

  const structure = loadStructure(name);
  if (structure.error) return { error: structure.error };

  const atsConfig = readAtsConfig(wd, vid);
  const requirements = buildRequirements(portrait, atsConfig);
  if (!requirements.length) {
    return { error: 'В портрете нет требований (hard skills / soft skills / опыт / образование) и в ats_config критериев нет — нечего оценивать. Заполни требования (hh_portrait_update) и повтори.' };
  }

  const thresholds = {
    pass: Number(atsConfig?.pass_threshold) || DEFAULT_THRESHOLDS.pass,
    review: Number(atsConfig?.review_threshold) || DEFAULT_THRESHOLDS.review,
  };

  const jsonPath = evalFile(name);
  const mdPath = evalMdFile(name);
  if (!force && fs.existsSync(jsonPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      // Кэш делается по слагу, а не по вакансии: оценка под другую вакансию — не кэш.
      if (cached.vacancy_id === vid) {
        let markdown = null;
        try { markdown = fs.readFileSync(mdPath, 'utf8'); } catch { /* md — производный артефакт */ }
        return { ok: true, cached: true, ...cached, ...(markdown ? { markdown } : {}), json_path: jsonPath, md_path: mdPath };
      }
    } catch { /* битый кэш — пересчитываем */ }
  }

  if (!ladderToken()) return { error: 'llm-ladder token не найден (LLM_LADDER_TOKEN / agent-tokens/llm-ladder/token).' };

  const dialogue = buildDialogue(structure.data);
  const rolesNote = dialogue.roles_detected
    ? null
    : 'Роли в интервью не распознаны — оценка сделана по тексту без разделения рекрутер/кандидат, роли не выдумывались.';

  let parsed;
  try {
    const raw = await hhLlm({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(requirements, dialogue) },
      ],
      purpose: 'default',
      temperature: 0.2,
      maxTokens: 4000,
      timeoutMs: 180_000,
      source: 'hh-interview-eval',
    });
    parsed = parseLlmJson(raw);
  } catch (e) {
    return { error: `Не удалось оценить интервью: ${e.message}` };
  }

  const { items, warnings } = normalizeRequirements(parsed, requirements);
  const communication = normalizeCommunication(parsed);
  const totals = computeTotals(items);
  const decision = decideVerdict(totals, items, thresholds);
  const coverage = buildCoverage(items);

  const payload = {
    slug: name,
    vacancy_id: vid,
    roles_detected: dialogue.roles_detected,
    ...(rolesNote ? { roles_note: rolesNote } : {}),
    requirements: items,
    coverage,
    totals,
    thresholds,
    ...decision,
    communication,
    warnings,
    generated_at: new Date().toISOString(),
  };

  fs.mkdirSync(interviewDir(name), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf-8');
  const markdown = renderMarkdown(payload);
  fs.writeFileSync(mdPath, markdown, 'utf-8');

  return { ok: true, cached: false, ...payload, markdown, json_path: jsonPath, md_path: mdPath };
}

function coverageHandler({ slug, vacancy_id } = {}) {
  if (!slug || !String(slug).trim()) {
    return { error: 'slug обязателен: папка интервью interviews/<slug>.' };
  }
  const name = slugName(slug);
  const vid = resolveVacancyId(vacancy_id);
  const jsonPath = evalFile(name);
  if (!fs.existsSync(jsonPath)) {
    return { error: `Оценки интервью ещё нет (${jsonPath}). Сначала hh_interview_evaluate {slug: "${name}", vacancy_id: "${vid}"} — покрытие считается по результату оценки.` };
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    return { error: `Файл оценки не читается (${e.message}): ${jsonPath}` };
  }
  if (data.vacancy_id !== vid) {
    return { error: `Оценка сделана для вакансии «${data.vacancy_id}», а запрошен «${vid}». Пересчитай: hh_interview_evaluate {slug: "${name}", vacancy_id: "${vid}", force: true}.` };
  }
  const coverage = data.coverage || { covered: [], missing: [], covered_count: 0, missing_count: 0, percent: 0 };
  return {
    ok: true,
    slug: name,
    vacancy_id: vid,
    roles_detected: data.roles_detected,
    ...(data.roles_note ? { roles_note: data.roles_note } : {}),
    coverage,
    missing_topics: coverage.missing.map(m => m.label),
    hint: coverage.missing_count
      ? `Не прозвучало ${coverage.missing_count} из ${coverage.covered_count + coverage.missing_count} требований — это готовый список вопросов на следующий этап.`
      : 'Все требования портрета в интервью прозвучали.',
    totals: data.totals,
    verdict: data.verdict,
    json_path: jsonPath,
  };
}

module.exports = {
  isReady: () => true,
  // Для юнит-тестов: чистая логика без I/O.
  PROMPT_MARKER,
  SYSTEM_PROMPT,
  DEFAULT_THRESHOLDS,
  slugName,
  interviewDir,
  structureFile,
  evalFile,
  evalMdFile,
  loadStructure,
  buildDialogue,
  buildRequirements,
  buildUserPrompt,
  parseLlmJson,
  normalizeScore,
  normalizeRequirements,
  normalizeCommunication,
  computeTotals,
  decideVerdict,
  buildCoverage,
  renderMarkdown,
  tools: {
    hh_interview_evaluate: {
      description:
        'Оценить интервью по ТРЕБОВАНИЯМ ПОРТРЕТА вакансии: для каждого hard/soft skill, опыта и ключевых полей — связанные вопросы-ответы и балл 1–5 с обязательной цитатой (evidence), покрытие (что прозвучало / что нет) и отдельный блок коммуникативного стиля, который в итоговый скор не входит. Итог Σ(s×w)/Σ(5×w) → percent + 0–10, veto must-have ≤1 → ОТКЛОНИТЬ. Вход: interviews/<slug>/structure.json (issue #88) + portrait:{vacancy_id}. Идемпотентно по слагу — force пересчитывает.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Слаг интервью: папка interviews/<slug> со structure.json.' },
          vacancy_id: { type: 'string', description: 'Вакансия (portrait:{id} + ats_config:{id}). По умолчанию — активная вакансия.' },
          force: { type: 'boolean', description: 'Пересчитать, даже если оценка уже есть (по умолчанию возвращается кэш).' },
        },
        required: ['slug'],
      },
      handler: async (args) => evaluateHandler(args || {}),
    },

    hh_interview_coverage: {
      description:
        'Покрытие интервью по требованиям портрета: какие требования прозвучали, какие нет («не прозвучало» — список вопросов на следующий этап). Дешёвый чтение результата hh_interview_evaluate, без LLM.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Слаг интервью: папка interviews/<slug>.' },
          vacancy_id: { type: 'string', description: 'Вакансия. По умолчанию — активная вакансия.' },
        },
        required: ['slug'],
      },
      handler: async (args) => coverageHandler(args || {}),
    },
  },
};
