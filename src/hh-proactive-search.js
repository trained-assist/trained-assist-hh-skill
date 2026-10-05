'use strict';
const { dataRoot, usersRoot } = require('./data-paths.js');

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readHhToken, readCredentialFileSafe } = require('./hh-utils');

const { resolveSearchAreas, searchResumes } = require('./hh-cold-search-transport');
const { hhLlm } = require('./hh-llm');
const { ladderChat, ladderToken } = require('./llm-ladder');

// Words that appear in almost every criterion and almost every resume. Counting them
// as a match put a «Программист 1С» on top of an «Инженер-конструктор» list: his
// resume contains «опыт» and «работы», so «опыт работы инженером-конструктором» hit.
const GENERIC_WORDS = new Set([
  'опыт', 'опыта', 'опытом', 'работы', 'работа', 'работе', 'знание', 'знания', 'умение',
  'умения', 'навык', 'навыки', 'навыков', 'владение', 'уверенное', 'уверенный', 'понимание',
  'отсутствие', 'наличие', 'также', 'более', 'менее', 'года', 'годы', 'лет', 'желательно',
  'обязательно', 'хорошее', 'хорошие', 'высокий', 'высшее', 'образование', 'внимание',
  'деталям', 'умеет', 'готовность', 'работать', 'других', 'сферы', 'сфере', 'области',
  'with', 'experience', 'knowledge', 'skills', 'years',
]);

// Significant words (4+ chars, not generic) from a criterion name, used for cheap
// substring matching before the AI does the real evaluation.
function extractKeywords(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !GENERIC_WORDS.has(w));
}

// Normalize ATS config to the canonical shape that this module reads.
// The ATS editor UI and the LLM `hh_extract_ats_config` tool historically produced
// different field names for the same concept — without normalization the proactive
// search ends up looking at an empty `required`/`preferred` list, generates queries
// from the vacancy title alone, and returns 30 "Аналитик данных" for a "Финансовый
// советник" vacancy. Mirrors the same logic used in src/hh-scoring.js.
function normalizeAtsConfig(raw) {
  // context_set sometimes stores the config as a JSON *string* inside the
  // value field (double serialization). Every other consumer (hh-scoring.js,
  // 90-hh.js) already guards against this; without it here the proactive
  // search reads empty criteria, generates off-topic queries ("Менеджер по
  // продажам" for "Финансовый советник") and scores candidates against
  // nothing. See #953 / #961.
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return raw; }
  }
  if (!raw || typeof raw !== 'object') return raw;
  const required = raw.required?.length
    ? raw.required.map(c => ({ name: c.name || c.skill || c.criterion || '', weight: Number(c.weight) || 0 }))
    : (raw.required_skills || []).map(c => ({ name: c.skill || c.name || c.criterion || '', weight: Number(c.weight) || 0 }));
  const preferred = raw.preferred?.length
    ? raw.preferred.map(c => ({ name: c.name || c.skill || c.criterion || '', weight: Number(c.weight) || 0 }))
    : (raw.preferred_skills || []).map(c => ({ name: c.skill || c.name || c.criterion || '', weight: Number(c.weight) || 0 }));
  const knockout = (raw.knockout || [])
    .map(k => (typeof k === 'string' ? k : (k.criterion || k.name || k.skill || '')))
    .filter(Boolean);
  // Experience threshold lives under different keys depending on who wrote the
  // config (UI/LLM → filters.min_experience_years, older extract → experience_min_years).
  // Unify into filters.min_experience_years so scoreCandidate never silently falls
  // back to the 2-year default for a vacancy that requires 6.
  const minExp = Number(raw.experience_min_years) || Number(raw.filters?.min_experience_years) || 2;
  const filters = { min_experience_years: minExp, ...(raw.filters || {}) };
  return {
    ...raw,
    vacancy_title: raw.vacancy_title || raw.title || 'Вакансия',
    required,
    preferred,
    knockout,
    filters,
  };
}

// Generic pre-filter: driven entirely by this vacancy's ATS config (min experience +
// required/preferred criteria with weights), no hardcoded domain keywords. It only
// decides who gets AI-scored first — the order the recruiter sees is the AI score
// against the ATS funnel (see atsScoreFields), never this number.
function scoreCandidate(r, atsConfig) {
  const minExpMonths = Math.round((atsConfig.filters?.min_experience_years ?? 2) * 12);
  const totalMonths = r.total_experience?.months ?? 0;
  if (totalMonths < minExpMonths) return null;

  const expList = r.experience || [];
  let allText = (r.title || '').toLowerCase();
  for (const e of expList) {
    allText += ' ' + (e.position || '').toLowerCase() + ' ' + (e.company || '').toLowerCase() + ' ' + (e.description || '').toLowerCase();
  }
  const certText = (r.certificate || []).map(c => (c.title || '').toLowerCase()).join(' ');
  allText += ' ' + certText;

  const baseScore = 1.5;
  let score = baseScore;
  const signals = [`опыт ${Math.floor(totalMonths / 12)}л +1.5`];

  const criteria = [...(atsConfig.required || []), ...(atsConfig.preferred || [])];
  for (const c of criteria) {
    const weight = c.weight || 0;
    const words = extractKeywords(c.name);
    if (words.length && words.some(w => allText.includes(w))) {
      score += weight;
      signals.push(`${c.name} +${weight}`);
    }
  }

  const totalPossible = baseScore + criteria.reduce((s, c) => s + (c.weight || 0), 0);
  const passThreshold = totalPossible * 0.55;
  const reviewThreshold = totalPossible * 0.32;
  const tag = score >= passThreshold ? 'PASS' : score >= reviewThreshold ? 'REVIEW' : 'WEAK';

  return { score, signals, tag, totalPossible };
}

// Bump when the scoring prompt/rules change: cached assessments made under an older
// version are re-scored instead of being served from cache.
const ATS_SCORING_VERSION = 2;
// How many best pre-scored candidates get the AI assessment during the search itself;
// the rest are scored by the background pass (scoreUnscoredProactiveCandidates).
const TOP_ENRICH = 60;

// Fingerprint of everything in the ATS funnel that changes a score. A candidate whose
// stored ats_hash differs was scored under other criteria and is re-scored in the
// background — that is how an edit in the ATS editor reaches the cold-search list.
function atsScoringHash(atsConfig) {
  const cfg = normalizeAtsConfig(atsConfig) || {};
  const key = JSON.stringify({
    v: ATS_SCORING_VERSION,
    title: cfg.vacancy_title || '',
    context: cfg.vacancy_context || '',
    required: (cfg.required || []).map(c => [c.name, c.weight]),
    preferred: (cfg.preferred || []).map(c => [c.name, c.weight]),
    knockout: cfg.knockout || [],
    min_exp: cfg.filters?.min_experience_years ?? null,
    pass: cfg.pass_threshold ?? cfg.thresholds?.strong ?? null,
    review: cfg.review_threshold ?? cfg.thresholds?.consider ?? null,
  });
  return require('crypto').createHash('md5').update(key).digest('hex').slice(0, 12);
}

function needsAtsScore(candidate, hash) {
  return !candidate?.ats_scored || candidate.ats_hash !== hash;
}

function atsRefreshProgressFile(username, vacancyId) {
  return path.join(dataRoot(), 'hh', String(username), 'proactive', `ats-progress-${String(vacancyId)}.json`);
}

function writeAtsRefreshProgress(username, vacancyId, fields) {
  const file = atsRefreshProgressFile(username, vacancyId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ vacancy_id: String(vacancyId), ...fields, updated_at: new Date().toISOString() }), { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) { console.warn('[proactive-ats-progress] write failed:', error.message); }
}

function readAtsRefreshProgress(username, vacancyId) {
  try { return JSON.parse(fs.readFileSync(atsRefreshProgressFile(username, vacancyId), 'utf8')); }
  catch { return null; }
}

function getAtsRefreshProgress(username, vacancyId) {
  const file = require('./hh-cold-search-snapshots').latestProactiveFile(username, vacancyId);
  if (!file) return { status: 'idle', completed: 0, total: 0, pending: 0, progress: 100, message: 'Холодный поиск ещё не запускался.' };
  let results;
  try { results = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { status: 'unavailable', completed: 0, total: 0, pending: 0, progress: 0, message: 'Не удалось прочитать результаты холодного поиска.' }; }
  let config = results.ats_config || {};
  try { config = require('./hh-cold-search-context').resolveSearchContext(path.join(usersRoot(), String(username)), vacancyId).config; }
  catch { /* the last search snapshot remains a safe read-only fallback */ }
  const hash = atsScoringHash(config);
  const candidates = results.candidates || [];
  const completed = candidates.filter(candidate => !needsAtsScore(candidate, hash)).length;
  const pending = Math.max(0, candidates.length - completed);
  const saved = readAtsRefreshProgress(username, vacancyId);
  const isFreshRun = saved?.config_hash === hash && Date.now() - Date.parse(saved.updated_at || 0) < 90_000;
  let status = pending === 0 ? 'complete' : isFreshRun && saved.status === 'running' ? 'running' : !ladderToken() ? 'blocked' : 'queued';
  let message = status === 'complete' ? 'Все кандидаты оценены по текущей ATS-воронке.'
    : status === 'running' ? 'Идёт переоценка кандидатов по ATS-воронке.'
      : status === 'blocked' ? 'Нужен доступ к сервису AI-оценки; обновление пока не запущено.'
        : 'Оценка ожидает фоновой обработки и продолжится автоматически.';
  const age = saved?.updated_at ? Math.max(0, Math.round((Date.now() - Date.parse(saved.updated_at)) / 1000)) : null;
  if (status === 'running' && age != null) message += ` Обновлено ${age} сек. назад.`;
  return { status, vacancy_id: String(vacancyId), completed, total: candidates.length, pending,
    progress: candidates.length ? Math.round(completed * 100 / candidates.length) : 100,
    message, updated_at: saved?.updated_at || null, failures: isFreshRun ? Number(saved.failures) || 0 : 0 };
}

// The fields that make up an ATS assessment. A fresh search snapshot rebuilds
// candidates from the HH payload (score/tags are absent until enriched), so the
// assessment is carried over from the unified store instead of being bought from
// the LLM again — a re-found candidate is the same person, not a new one.
const ATS_ASSESSMENT_FIELDS = [
  'score', 'score_pct', 'tag', 'knockout_failed',
  'ats_scored', 'ats_hash', 'ats_degraded',
  'plus_tags', 'yellow_tags', 'red_tags', 'summary_why', 'summary_pitch',
];

// prev = store record (already vacancy-scoped), atsHash = current funnel fingerprint.
// Returns `candidate` untouched unless prev holds an assessment made under exactly
// this funnel: a stale hash means the funnel was edited and a re-score IS due.
function carryAssessment(candidate, prev, atsHash) {
  if (!prev || !prev.ats_scored || prev.ats_hash !== atsHash) return candidate;
  const carried = {};
  for (const f of ATS_ASSESSMENT_FIELDS) if (prev[f] !== undefined) carried[f] = prev[f];
  return { ...candidate, ...carried };
}

// The unified-store record as it applies to one vacancy, WITHOUT candidateForVacancy's
// default-fill (that helper fabricates score:0/REVIEW for records it can't scope —
// fine for rendering a card, wrong for deciding whether an assessment exists).
// vacancy_data wins per-field; top-level fills the rest.
function storeAssessment(raw, vacancyId) {
  if (!raw) return null;
  const scoped = raw.vacancy_data && raw.vacancy_data[String(vacancyId)];
  return scoped ? { ...raw, ...scoped } : raw;
}

// The candidate's place in the list comes from the ATS funnel the recruiter edits in
// /hh/ats-editor (стоп-факторы, обязательные, желательные, пороги) — the same source
// the scoring of responses uses. Score 0-10; any violated stop-factor caps it at 2.
function atsScoreFields(ai, atsConfig) {
  const raw = Number(ai?.score);
  if (!Number.isFinite(raw)) {
    // The model answered valid JSON but no usable score. Mark the assessment as
    // done anyway (flagged): returning nothing here left the record permanently
    // "unscored", and the background pass re-bought it from the LLM on every tick
    // (2026-09-30: 510 such records in one profile). No score is fabricated — the
    // card shows "н/д" and a funnel edit / ATS_SCORING_VERSION bump re-scores it.
    if (ai == null || typeof ai !== 'object') return {};
    return { ats_scored: true, ats_degraded: true, ats_hash: atsScoringHash(atsConfig) };
  }
  const knockoutFailed = (Array.isArray(ai.knockout_failed) ? ai.knockout_failed : [])
    .map(k => String(k || '').trim()).filter(Boolean);
  let score = Math.max(0, Math.min(10, raw));
  if (knockoutFailed.length) score = Math.min(score, 2);
  score = Math.round(score * 2) / 2;
  const pass = Number(atsConfig?.pass_threshold ?? atsConfig?.thresholds?.strong) || 7;
  const review = Number(atsConfig?.review_threshold ?? atsConfig?.thresholds?.consider) || 5;
  return {
    score,
    score_pct: Math.round(score * 10),
    tag: score >= pass ? 'PASS' : score >= review ? 'REVIEW' : 'WEAK',
    knockout_failed: knockoutFailed,
    ats_scored: true,
    ats_hash: atsScoringHash(atsConfig),
  };
}

// Sort key for lists: AI-scored candidates by their ATS score; not-yet-scored ones
// after all of them (their heuristic number is not comparable), by pre-score.
function compareByAtsScore(a, b) {
  const sa = a?.ats_scored ? Number(a.score) || 0 : -1;
  const sb = b?.ats_scored ? Number(b.score) || 0 : -1;
  if (sa !== sb) return sb - sa;
  return (Number(b?.pre_score) || 0) - (Number(a?.pre_score) || 0);
}

// AI assessment against the ATS funnel: score + plus/yellow/red tags + summary.
async function enrichCandidate(candidate, atsConfig) {
  const cfg = normalizeAtsConfig(atsConfig);
  const knockoutStr = (cfg.knockout || []).map(k => `- ${k}`).join('\n') || '—';
  const requiredStr = (cfg.required || []).map(r => `- ${r.name} (вес ${r.weight})`).join('\n') || '—';
  const preferredStr = (cfg.preferred || []).map(r => `- ${r.name} (вес ${r.weight})`).join('\n') || '—';
  const expStr = (candidate.experience || [])
    .map(e => `${e.position} — ${e.company} (${e.start || '?'} – ${e.end || 'н.в.'})`)
    .join('\n') || '—';

  const minExp = cfg.filters?.min_experience_years;
  const prompt = `Ты — опытный рекрутер. Оцени кандидата из базы резюме HH для вакансии "${cfg.vacancy_title || 'Вакансия'}".
${cfg.vacancy_context ? `\nКонтекст вакансии: ${cfg.vacancy_context}` : ''}${minExp ? `\nМинимальный опыт: ${minExp} лет.` : ''}

СТОП-ФАКТОРЫ (knockout, критичны):
${knockoutStr}

Обязательные критерии (с весами):
${requiredStr}

Желательные:
${preferredStr}

Кандидат:
Должность: ${candidate.title}
Опыт: ${candidate.total_exp_years} лет
Компании: ${(candidate.recent_companies || []).join(', ')}
Карьера:
${expStr}

Верни ТОЛЬКО JSON без markdown:
{
  "score": 6.5,
  "knockout_failed": ["стоп-фактор дословно из списка выше", ...],
  "plus_tags": ["3-6 слов", ...],
  "yellow_tags": ["3-6 слов", ...],
  "red_tags": ["3-6 слов", ...],
  "summary_why": "2-3 предложения: почему кандидат сильный, конкретные факты из карьеры",
  "summary_pitch": "1-2 предложения: что конкретно сказать клиенту о кандидате"
}

Правила:
- score — соответствие вакансии по шкале 0–10, абсолютная (не подгоняй под пул):
  9–10: все обязательные критерии подтверждены карьерой + большинство желательных
  7–8: большинство обязательных подтверждены
  5–6: часть обязательных есть, остальное неясно из резюме
  3–4: мало обязательных или опыт в смежной, но другой профессии
  0–2: другая профессия или нарушен стоп-фактор
- knockout_failed — только стоп-факторы, которые ЯВНО нарушены по карьере (другая профессия, нет нужного опыта). Нарушен хотя бы один → score не выше 2. Если по резюме просто неясно — не включай, а снизь score и добавь yellow_tag
- Обязательные критерии весят больше желательных; учитывай веса
- plus_tags (2-5 штук): сильные стороны, явно подходящие под требования
- yellow_tags (0-3): моменты стоит уточнить на интервью, небольшие риски
- red_tags (0-2): только явные несоответствия knockout-критериям; если много плюсов — не стоп
- Теги КРАТКО (3-6 слов каждый)
- summary_why — живо, как рекрутер рассказывает коллеге
- summary_pitch — конкретные факты которые продают кандидата клиенту`;

  // Enrichment = candidate evaluation → the ladder's free tier (owner decision,
  // A/B 2026-09-30: free-ladder, temp 0.1 — docs/evals/ladder-enrichment-ab-2026-09-30.md).
  // Query generation is the only OpenRouter call left here and reads its own key.
  const { content: text } = await ladderChat({
    messages: [{ role: 'user', content: prompt }],
    ladder: 'free',
    temperature: 0.1,
    maxTokens: 600,
    timeoutMs: 25_000,
    source: 'hh-enrich',
  });
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('no JSON in AI response');
  const parsed = JSON.parse(match[0]);
  return { ...parsed, ...atsScoreFields(parsed, cfg) };
}

// Enrich top-N candidates in parallel batches of 5
async function enrichCandidates(candidates, atsConfig, onBatch = null) {
  const BATCH = 10;
  const enriched = [...candidates];
  for (let i = 0; i < enriched.length; i += BATCH) {
    const batch = enriched.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(c => enrichCandidate(c, atsConfig))
    );
    for (let j = 0; j < batch.length; j++) {
      const r = results[j];
      if (r.status === 'fulfilled') {
        Object.assign(enriched[i + j], r.value);
      } else {
        console.error(`[proactive-enrich] candidate ${batch[j].id} failed:`, r.reason?.message);
      }
    }
    if (typeof onBatch === 'function') await onBatch({ attempted: Math.min(i + BATCH, enriched.length), total: enriched.length, failed: results.filter(r => r.status === 'rejected').length });
    if (i + BATCH < enriched.length) await new Promise(r => setTimeout(r, 500));
  }
  return enriched;
}

// Cheap overlap check: do the AI-generated queries actually relate to this vacancy?
// Without this, generateSearchQueries sometimes returns off-topic terms (e.g. for a
// "Финансовый советник" vacancy it has produced "Аналитик данных", "Data Scientist",
// "ML Engineer" — none of which match the vacancy's title, context, or required
// criteria). The downstream search then pulls 30 random "Аналитик данных" instead of
// private bankers, and the recruiter sees a meaningless candidate list.
function queriesLookSane(queries, cfg) {
  if (!Array.isArray(queries) || queries.length === 0) return false;
  const titleWords = extractKeywords(cfg.vacancy_title || '');
  const ctxWords = extractKeywords(cfg.vacancy_context || '');
  const reqWords = (cfg.required || []).flatMap(c => extractKeywords(c.name));
  const prefWords = (cfg.preferred || []).flatMap(c => extractKeywords(c.name));
  const domainWords = new Set([...titleWords, ...ctxWords, ...reqWords, ...prefWords]);
  if (!domainWords.size) {
    // No domain anchors at all (vacancy title/context/criteria all empty).
    // Trust the LLM — we can't really check, accept what it said.
    return queries.length > 0;
  }
  // At least 40% of queries must share a 4+ char word with the vacancy's domain.
  // The old "any one query" threshold was too loose: "Sales Manager" shared "sales"
  // with "Private Banking Sales" and acted as a hall-pass for a fully generic set
  // like ["Аналитик данных", "Data Scientist", "Sales Manager", ...].
  const matchCount = queries.filter(q => {
    const qWords = extractKeywords(q);
    return qWords.some(w => domainWords.has(w));
  }).length;
  return matchCount >= Math.max(1, Math.ceil(queries.length * 0.4));
}

// Generate a small fallback set of queries from the vacancy's own title + top-3
// weighted criteria. Used when the LLM returns off-topic queries so we never
// search for the wrong profession. Returns 4-6 short queries.
function deriveFallbackQueries(cfg) {
  const title = String(cfg.vacancy_title || '').trim();
  const topCriteria = [...(cfg.required || []), ...(cfg.preferred || [])]
    .filter(c => c.name)
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
    .slice(0, 3)
    .map(c => c.name);
  const out = [];
  if (title) out.push(title);
  for (const name of topCriteria) {
    // Take only the leading noun phrase (first 3 significant words)
    const short = name.split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
    if (short && !out.includes(short)) out.push(short);
  }
  return out.slice(0, 6);
}

// Persistent seen-IDs store: prevents losing candidates between runs and lets us
// tell the recruiter "X new since you last looked". Per-vacancy bucket so switching
// vacancies doesn't reset the counter. Atomic writes (write-temp + rename) so a
// crash mid-write never corrupts the file. Schema:
//   { "<vacancy_id>": { "<hh_resume_id>": "ISO date when first seen", ... }, ... }
function seenIdsPath(username) {
  const dataDir = dataRoot();
  return path.join(dataDir, 'hh', String(username), 'proactive', 'seen-ids.json');
}

function loadSeenIds(username) {
  const file = seenIdsPath(username);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[proactive-search] seen-ids read failed:', e.message);
    return {};
  }
}

function saveSeenIds(username, data) {
  const file = seenIdsPath(username);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// Merge freshly-collected candidate IDs into the per-vacancy seen bucket.
// Returns:
//   { newIds: Set<string>, newCount, totalSeenAfter, firstRun }
// firstRun=true means there was no prior seen file for this vacancy — every
// collected ID is treated as "new" (the recruiter expects to see the full
// backfill when they first turn the search on).
function mergeSeenIds(username, vacancyId, collectedIds) {
  const seen = loadSeenIds(username);
  const firstRun = !seen[vacancyId] || Object.keys(seen[vacancyId] || {}).length === 0;
  const bucket = seen[vacancyId] || {};
  const today = new Date().toISOString().slice(0, 10);
  const newIds = [];
  for (const id of collectedIds) {
    if (!bucket[id]) {
      bucket[id] = today;
      newIds.push(id);
    }
  }
  if (newIds.length) {
    seen[vacancyId] = bucket;
    saveSeenIds(username, seen);
  }
  return { newIds: new Set(newIds), newCount: newIds.length, totalSeenAfter: Object.keys(bucket).length, firstRun };
}

// Unified candidate store: consolidates auto-discovered (source:'search') and
// manually-added (source:'manual') candidates into one persistent, accumulating
// list so the proactive page can render a single scrollable feed instead of the
// old "overwritten every search run" search-results-<date>.json snapshot.
// Keyed by HH resume id (global, not per-vacancy — a candidate found for one
// vacancy today is the same person if added manually tomorrow).
// Schema: { "<hh_resume_id>": { ...candidate fields, source, found_at|added_at }, ... }
function allCandidatesPath(username) {
  const dataDir = dataRoot();
  return path.join(dataDir, 'hh', String(username), 'proactive', 'all-candidates.json');
}

function loadAllCandidates(username, vacancyId) {
  try {
    const raw = fs.readFileSync(allCandidatesPath(username), 'utf8');
    const parsed = JSON.parse(raw);
    const store = parsed && typeof parsed === 'object' ? parsed : {};
    if (!vacancyId) return store;
    return Object.fromEntries(Object.entries(store)
      .filter(([, c]) => candidateMatchesVacancy(c, vacancyId))
      .map(([id, c]) => [id, candidateForVacancy(c, vacancyId)]));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[proactive-search] all-candidates read failed:', e.message);
    return {};
  }
}

function saveAllCandidates(username, data) {
  const file = allCandidatesPath(username);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// Dedup-merge a vacancy id into an existing vacancy_ids[] array without dropping
// entries from other vacancies. Returns a new array (never mutates the input).
// Missing/empty vacancy_ids means "wildcard — belongs to all vacancies" (see
// candidateMatchesVacancy below); we only start populating the array once a
// vacancy_id is actually known for this record.
function mergeVacancyId(existingIds, vacancyId) {
  const ids = Array.isArray(existingIds) ? existingIds.map(String) : [];
  if (!vacancyId) return ids;
  const vid = String(vacancyId);
  return ids.includes(vid) ? ids : [...ids, vid];
}

// Multi-vacancy step 7/7: does `candidate` belong to the given vacancy?
// A missing/empty vacancy_ids field is a wildcard — it means the record predates
// this field (backfill case) or was manually added with no active vacancy resolvable,
// and should show up under every vacancy tab rather than silently disappearing.
// No vacancyId filter requested (falsy) → everything passes through unfiltered.
function candidateMatchesVacancy(candidate, vacancyId) {
  if (!vacancyId) return true;
  const ids = candidate?.vacancy_ids;
  if (!Array.isArray(ids) || ids.length === 0) return true; // wildcard
  return ids.map(String).includes(String(vacancyId));
}

function candidateForVacancy(candidate, vacancyId) {
  const scoped = candidate.vacancy_data?.[String(vacancyId)];
  if (scoped) return { ...candidate, ...scoped };
  if (candidate.vacancy_ids?.length === 1 && String(candidate.vacancy_ids[0]) === String(vacancyId)) return candidate;
  return { ...candidate, status: 'active', score: 0, score_pct: 0, tag: 'REVIEW',
    plus_tags: [], yellow_tags: [], red_tags: [], summary_why: '', summary_pitch: '' };
}

// Merge a batch of freshly-scored/enriched search candidates into the unified store.
// Existing records (e.g. manually-added, or already found+annotated) are NOT clobbered
// wholesale — we merge new fields in while preserving the original found_at/source so
// re-running search doesn't reset "when we first found this person" or flip a manual
// candidate back to source:'search'. `vacancyId` (optional — omitted callers keep the
// pre-step-7 behavior of leaving vacancy_ids untouched) is dedup-appended into each
// record's vacancy_ids so a candidate re-found under a different vacancy's search
// later keeps showing up under both tabs instead of one clobbering the other.
function mergeSearchCandidatesIntoAll(username, candidates, foundAtById, vacancyId) {
  const store = loadAllCandidates(username);
  const now = new Date().toISOString();
  for (const c of candidates || []) {
    if (!c || !c.id) continue;
    const id = String(c.id);
    const existing = store[id];
    const foundAt = (foundAtById && foundAtById[id]) || existing?.found_at || now;
    const vacancyData = { ...(existing?.vacancy_data || {}) };
    if (existing?.vacancy_ids?.length === 1 && !vacancyData[existing.vacancy_ids[0]]) {
      const { vacancy_data, ...legacy } = existing;
      vacancyData[existing.vacancy_ids[0]] = legacy;
    }
    if (vacancyId) {
      const prior = vacancyData[String(vacancyId)] || {};
      vacancyData[String(vacancyId)] = { ...prior, ...c,
        status: prior.status || 'active', status_changed_at: prior.status_changed_at,
        found_at: prior.found_at || foundAt };
    }
    store[id] = {
      ...existing,
      ...c,
      vacancy_data: vacancyData,
      source: existing?.source === 'manual' ? 'manual' : 'search',
      found_at: foundAt,
      vacancy_ids: mergeVacancyId(existing?.vacancy_ids, vacancyId),
    };
  }
  saveAllCandidates(username, store);
  return store;
}

// Add a single manually-added candidate (from a pasted HH resume URL/id) to the
// unified store. `resumeData` is the raw HH /resumes/{id} response, shaped through
// the same field mapping runProactiveSearch uses for search results so the card
// renderer doesn't need to special-case manual entries. `vacancyId` tags the record
// with whichever vacancy was active when it was added; if no active vacancy can be
// resolved, vacancy_ids stays [] (wildcard — shows under every tab).
function addManualCandidate(username, resumeData, vacancyId) {
  if (!resumeData || !resumeData.id) throw new Error('resumeData.id required');
  const id = String(resumeData.id);
  const expMonths = resumeData.total_experience?.months ?? 0;
  const companies = (resumeData.experience || []).slice(0, 3).map(e => e.company || '').filter(Boolean);
  const now = new Date().toISOString();
  const store = loadAllCandidates(username);
  const existing = store[id];
  const record = {
    id,
    hh_url: resumeData.alternate_url || `https://hh.ru/resume/${id}`,
    title: resumeData.title || '',
    first_name: resumeData.first_name || '',
    last_name: resumeData.last_name || '',
    age: resumeData.age || null,
    area: resumeData.area?.name || '',
    total_exp_months: expMonths,
    total_exp_years: Math.round(expMonths / 12 * 10) / 10,
    score: existing?.score ?? 0,
    tag: existing?.tag ?? 'REVIEW',
    score_signals: existing?.score_signals || [],
    salary: resumeData.salary || null,
    recent_companies: companies,
    experience: (resumeData.experience || []).slice(0, 5).map(e => ({
      position: e.position || '',
      company: e.company || '',
      start: e.start || '',
      end: e.end || null,
    })),
    ...existing,
    source: 'manual',
    added_at: existing?.added_at || now,
    found_at: existing?.found_at || now,
    vacancy_ids: mergeVacancyId(existing?.vacancy_ids, vacancyId),
  };
  store[id] = record;
  saveAllCandidates(username, store);
  return record;
}

// Parse an HH resume id out of a full resume URL (e.g. https://hh.ru/resume/abc123def)
// or accept a bare id as-is. Strips query strings/fragments and non-alphanumeric noise.
function parseResumeId(input) {
  const str = String(input || '').trim();
  const m = str.match(/\/resume\/([a-zA-Z0-9]+)/);
  if (m) return m[1];
  return str.replace(/[^a-zA-Z0-9]/g, '');
}

// Per-vacancy search-query store. Queries live in the same proactive directory, keyed by
// vacancy ID. This avoids the old anti-pattern of embedding them inside ats_config.json —
// that file is overwritten on every ATS edit and is shared across all vacancies for a user,
// causing stale / wrong queries to survive a vacancy switch.
// Schema: { vacancy_id, queries: string[], config_hash: string, generated_at: ISO }
function queriesStorePath(username, vacancyId) {
  const dataDir = dataRoot();
  return path.join(dataDir, 'hh', String(username), 'proactive', `queries-${vacancyId}.json`);
}

// Stable hash of the ATS fields that influence query generation.
// Always call with already-normalized config (normalizeAtsConfig output) so the hash
// reflects what generateSearchQueries actually receives — not the raw field names.
// `exclusions` is the current recruiter-comment exclusion list; including it means a
// new comment forces query regeneration (closes the feedback loop).
function atsConfigHash(cfg, exclusions = []) {
  const normalized = normalizeAtsConfig(cfg);
  const key = JSON.stringify({
    title: normalized.vacancy_title,
    context: normalized.vacancy_context,
    // Kept (always empty) so hashes of existing query caches stay valid; the free-text
    // search prompt was folded back into the ATS funnel.
    recruiter_prompt: '',
    required: (normalized.required || []).map(c => c.name).sort(),
    preferred: (normalized.preferred || []).map(c => c.name).sort(),
    knockout: (normalized.knockout || []).slice().sort(),
    exclusions: exclusions.slice().sort(),
  });
  return require('crypto').createHash('md5').update(key).digest('hex').slice(0, 12);
}

// Raw stored record, or null. `manual: true` marks queries the recruiter typed in
// themselves — those are kept as-is until the recruiter clears them.
function readStoredQueriesRecord(username, vacancyId) {
  try {
    const data = JSON.parse(fs.readFileSync(queriesStorePath(username, vacancyId), 'utf8'));
    return data && Array.isArray(data.queries) ? data : null;
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[proactive-search] queries store read failed:', e.message);
    return null;
  }
}

function loadStoredQueries(username, vacancyId, configHash) {
  try {
    const data = JSON.parse(fs.readFileSync(queriesStorePath(username, vacancyId), 'utf8'));
    if (data.manual && Array.isArray(data.queries) && data.queries.length > 0) return data.queries;
    if (data.config_hash === configHash && Array.isArray(data.queries) && data.queries.length > 0) {
      return data.queries;
    }
    return null;
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[proactive-search] queries store read failed:', e.message);
    return null;
  }
}

function saveStoredQueries(username, vacancyId, queries, configHash, options = {}) {
  const file = queriesStorePath(username, vacancyId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({
    vacancy_id: vacancyId,
    queries,
    config_hash: configHash,
    ...(options.manual ? { manual: true } : {}),
    generated_at: new Date().toISOString(),
  }, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// Save the search queries the recruiter edited on the page. Queries equal to the
// stored list are left alone; a changed list is pinned as manual; an empty list drops
// the cache → regenerate from the ATS funnel. Who is a good candidate is edited only
// in the ATS editor — one place, not two.
function saveSearchSettings(username, vacancyId, { queries } = {}) {
  let queriesState = 'unchanged';
  if (Array.isArray(queries)) {
    const next = queries.map(q => String(q).trim()).filter(Boolean).slice(0, 15);
    const current = readStoredQueriesRecord(username, vacancyId)?.queries || [];
    if (!next.length) {
      try { fs.unlinkSync(queriesStorePath(username, vacancyId)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      queriesState = 'reset';
    } else if (JSON.stringify(next) !== JSON.stringify(current)) {
      saveStoredQueries(username, vacancyId, next, 'manual', { manual: true });
      queriesState = 'manual';
    }
  }
  return { queries_state: queriesState };
}

// Everything the page's prompt panel shows for one vacancy.
function searchSettingsView(username, vacancyId) {
  const record = readStoredQueriesRecord(username, vacancyId);
  return {
    vacancy_id: String(vacancyId),
    queries: record?.queries || [],
    queries_manual: Boolean(record?.manual),
    queries_generated_at: record?.generated_at || null,
    explanation: buildScoringPromptText(username, vacancyId),
  };
}

// --- Candidate comments (for search refinement) ---

function commentsPath(username, vacancyId) {
  const dataDir = dataRoot();
  return path.join(dataDir, 'hh', String(username), 'proactive', vacancyId ? `candidate-comments-${encodeURIComponent(vacancyId)}.json` : 'candidate-comments.json');
}

function loadCandidateComments(username, vacancyId) {
  try {
    const raw = fs.readFileSync(commentsPath(username, vacancyId), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[proactive-search] comments read failed:', e.message);
    return {};
  }
}

function saveCandidateComment(username, candidateId, commentData, vacancyId) {
  const comments = loadCandidateComments(username, vacancyId);
  comments[String(candidateId)] = { ...commentData, updatedAt: new Date().toISOString() };
  const file = commentsPath(username, vacancyId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(comments, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// Candidate triage lifecycle, driven entirely by `status` on the unified
// all-candidates record: 'active' (default — just showed up in search, still
// in the main feed) -> 'starred' (recruiter picked it out) -> 'archived'
// (recruiter is done with it; kept for error-recovery/debugging, not expected
// to be revisited). A candidate can also go directly active -> archived, or
// back from archived/starred to active. Missing status on legacy records
// means 'active' (see candidateStatusOf below) so old data doesn't need a
// backfill migration.
const CANDIDATE_STATUSES = ['active', 'starred', 'archived'];

function candidateStatusOf(candidate) {
  return CANDIDATE_STATUSES.includes(candidate?.status) ? candidate.status : 'active';
}

// Persist a status transition on the unified store. `status_changed_at` drives
// the starred/archived tab sort ("newest on top") — the main active tab sorts
// by score instead (see handlers/hh.js).
function setCandidateStatus(username, candidateId, status, vacancyId) {
  if (!CANDIDATE_STATUSES.includes(status)) {
    throw new Error(`invalid status "${status}" — must be one of ${CANDIDATE_STATUSES.join(', ')}`);
  }
  const store = loadAllCandidates(username);
  const id = String(candidateId);
  if (!store[id]) throw new Error('candidate not found');
  if (vacancyId) {
    if (!candidateMatchesVacancy(store[id], vacancyId)) throw new Error('candidate not found in vacancy');
    const view = candidateForVacancy(store[id], vacancyId);
    const { vacancy_data, ...fields } = view;
    store[id].vacancy_data = { ...store[id].vacancy_data, [String(vacancyId)]: {
      ...fields, status, status_changed_at: new Date().toISOString(),
    } };
  } else {
    store[id].status = status;
    store[id].status_changed_at = new Date().toISOString();
  }
  saveAllCandidates(username, store);
  return vacancyId ? candidateForVacancy(store[id], vacancyId) : store[id];
}

// Extract search exclusion hints from candidate comments.
// These are comments that describe what we DON'T want (typically negative feedback).
// Returns an array of strings like ["не из Новосибирска", "без опыта в рознице"].
function getSearchExclusions(username, vacancyId) {
  const comments = loadCandidateComments(username, vacancyId);
  return Object.values(comments)
    .map(c => (c.text || '').trim())
    .filter(Boolean);
}

// Generate HH resume-search queries for this specific vacancy (title + context + criteria)
// instead of a fixed list — makes cold-search work for any vacancy, not just one domain.
// Layered: ask the LLM first, sanity-check the result, use a deterministic
// fallback derived from the vacancy's own fields when the LLM goes off-topic.
async function generateSearchQueries(atsConfig, _orKey, exclusions = []) {
  const cfg = normalizeAtsConfig(atsConfig);
  const criteriaStr = [...(cfg.required || []), ...(cfg.preferred || [])]
    .map(c => c.name).filter(Boolean).join(', ') || '—';

  let aiQueries = [];
  if (ladderToken()) {
    const exclusionsBlock = exclusions.length
      ? `\nКомментарии рекрутера по уже просмотренным кандидатам (что НЕ подходит):\n${exclusions.map(e => `- ${e}`).join('\n')}\nУчти эти исключения в запросах — например, не ищи по городам которые отмечены как нежелательные.\n`
      : '';
    const prompt = `Вакансия: "${cfg.vacancy_title || 'без названия'}"
Контекст: ${cfg.vacancy_context || '—'}
Ключевые критерии: ${criteriaStr}${cfg.knockout?.length ? `\nСтоп-факторы (таких не искать): ${cfg.knockout.join('; ')}` : ''}
${exclusionsBlock}
Составь 5-7 СПЕЦИАЛИЗИРОВАННЫХ поисковых запросов для HH.ru под эту конкретную вакансию.

ПРАВИЛА:
- Каждый запрос 2-4 слова: название должности или специализированный навык этой сферы
- НЕ используй общие формулировки («Менеджер по продажам», «Sales Manager», «Специалист по продажам») если у вакансии есть специфическая область — ищи именно эту специфику
- Используй профессиональную терминологию сферы (например для private banking: «Private Banker», «Wealth Manager», «Управляющий активами»; для IT-рекрутинга: «Tech Recruiter», «IT Headhunter»; и т.д.)
- Запросы на русском; 1-2 запроса на английском только если это реальные названия должностей в резюме этой сферы

Верни ТОЛЬКО JSON-массив строк, без markdown:
["запрос 1", "запрос 2", ...]`;

    // Query generation is not a candidate message and not an evaluation — DEFAULT
    // ladder (src/hh-llm.js purpose 'default' → 'service').
    const text = await hhLlm({
      messages: [{ role: 'user', content: prompt }],
      purpose: 'default',
      temperature: 0.3,
      maxTokens: 300,
      timeoutMs: 20_000,
      source: 'hh-proactive',
    });

    const match = (text || '').match(/\[[\s\S]*\]/);
    if (match) {
      try {
        aiQueries = JSON.parse(match[0]).filter(q => typeof q === 'string' && q.trim()).slice(0, 8);
      } catch { /* fall through to fallback */ }
    }
  }

  if (!aiQueries.length) {
    // LLM returned empty / parse failed — use deterministic fallback instead of throwing,
    // so a single bad LLM response doesn't kill the entire proactive run.
    const fallback = deriveFallbackQueries(cfg);
    if (fallback.length) return fallback;
    throw new Error('empty query list from AI and no fallback derivable from vacancy title/criteria');
  }
  if (queriesLookSane(aiQueries, cfg)) return aiQueries;

  // AI went off-topic — use ONLY the deterministic fallback. Including the off-topic
  // AI queries (even merged with fallback) brings in unrelated candidates: e.g. for
  // "Финансовый советник" the LLM once returned "Менеджер по продажам" which then
  // pulled 26 logistics/export salespeople. The fallback is derived purely from the
  // vacancy's own fields so it can't go off-topic.
  console.warn(`[proactive-search] AI queries look off-topic for "${cfg.vacancy_title || 'вакансии'}": ${JSON.stringify(aiQueries)}. Using fallback derived from vacancy title + criteria only.`);
  const fallback = deriveFallbackQueries(cfg);
  return fallback.length ? fallback : aiQueries;
}

function searchAreaNames(ids, vacancy) {
  const area = vacancy?.area && typeof vacancy.area === 'object' ? vacancy.area : null;
  const names = {};
  for (const id of ids || []) if (area && String(area.id) === String(id) && area.name) names[id] = area.name;
  return names;
}

// The region is the first filter of the HH query; without it in the explanation the
// recruiter cannot tell a Zlatoust search from a Moscow one.
function describeSearchAreas(latest, workDir) {
  if (!Object.prototype.hasOwnProperty.call(latest, 'search_area_ids')) return null;
  const ids = latest.search_area_ids || [];
  if (!ids.length) return 'вся Россия (без ограничения по региону)';
  const names = { ...(latest.search_area_names || {}) };
  if (ids.some(id => !names[id])) {
    const { readSearchContext } = require('./hh-cold-search-context');
    const vacancies = [readSearchContext(workDir, 'active_vacancy'), ...(readSearchContext(workDir, 'active_vacancies') || [])];
    for (const v of vacancies) {
      if (v?.area && typeof v.area === 'object' && ids.includes(String(v.area.id)) && !names[v.area.id]) names[v.area.id] = v.area.name;
    }
  }
  return ids.map(id => names[id] || `регион HH №${id}`).join(', ');
}

// Scoring explanation shown to the recruiter on request — built from the latest actual
// run's ats_config + generated queries, not a static domain-specific description.
function buildScoringPromptText(username, vacancyId) {
  const workDir = path.join(usersRoot(), String(username));
  const { readSearchContext } = require('./hh-cold-search-context');
  const id = vacancyId || readSearchContext(workDir, 'active_vacancy')?.id;
  if (!id) return 'Сначала выбери вакансию.';
  const file = require('./hh-cold-search-snapshots').latestProactiveFile(username, id);
  if (!file) return 'Проактивный поиск ещё не запускался для текущей вакансии — критерии и запросы появятся после первого запуска (команда «проактивный поиск»).';
  const latest = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Explain the criteria actually used in this run, not a newer config or another vacancy.
  const rawConfig = latest.ats_config || {};
  const cfg = normalizeAtsConfig(rawConfig);
  const queriesStr = (latest.search_queries || []).map(q => `• "${q}"`).join('\n') || '—';
  const knockoutStr = (cfg.knockout || []).map(k => `• ${k}`).join('\n') || '(не задано)';
  const minExp = cfg.filters?.min_experience_years ?? 2;
  const reqStr = (cfg.required || []).map(c => `• +${c.weight} — ${c.name}`).join('\n') || '(не задано)';
  const prefStr = (cfg.preferred || []).map(c => `• +${c.weight} — ${c.name}`).join('\n') || '(не задано)';
  const areaStr = describeSearchAreas(latest, workDir);


  return `Как мы подбираем кандидатов для «${cfg.vacancy_title || 'вакансии'}» (проактивный поиск):
${areaStr ? `\n📍 Регион поиска в базе резюме HH: ${areaStr}\n` : ''}
🔍 Поисковые запросы в базе резюме HH (сгенерированы под эту вакансию):
${queriesStr}

⛔ Отсекаем на этапе поиска: опыт работы менее ${minExp} лет

📊 Оценка по АТС-воронке (Gemini 2.5 Flash), шкала 0–10 — по ней отсортирован список:
⛔ Стоп-факторы — нарушен хотя бы один → оценка не выше 2:
${knockoutStr}
Обязательные:
${reqStr}
Желательные:
${prefStr}
PASS — от ${Number(rawConfig.pass_threshold) || 7}, REVIEW — от ${Number(rawConfig.review_threshold) || 5}.

Сначала оцениваются 60 самых похожих по ключевым словам кандидатов и все новые, остальные дооцениваются в фоне; неоценённые стоят в конце списка. Изменить критерии — в редакторе АТС-воронки: после сохранения кандидаты переоцениваются.`;
}

// HH resume search with optional one-shot refresh on token-expired (401/403).
// `refreshAccessToken` is an optional async fn (username) => newAccessToken|null.
// server.js wires it to refreshHhToken() so the proactive-search path auto-survives
// the same 14-day access_token expiry that /hh/review already handles (916a938).
async function runProactiveSearch(username, workDir, options = {}) {
  const release = require('./hh-cold-search-lock').acquireSearchLock(username);
  try { return await runProactiveSearchUnlocked(username, workDir, options); }
  finally { release(); }
}

async function trackVacancy(workDir, vacancyId, known, fallbackTitle, token) {
  const { readActiveVacancies, writeHhContext, hhFetch } = require('./hh-utils');
  const list = readActiveVacancies(workDir);
  if (list.some(v => String(v.id) === String(vacancyId))) return;
  let v = known && known.name ? known : null;
  if (!v) { try { v = await hhFetch(`/vacancies/${encodeURIComponent(vacancyId)}`, token); } catch { /* title from ATS config */ } }
  const area = v?.area && typeof v.area === 'object' ? v.area : undefined;
  list.push({ id: String(vacancyId), title: v?.name || fallbackTitle || String(vacancyId), ...(area ? { area } : {}), set_at: new Date().toISOString() });
  await writeHhContext(workDir, 'hh', 'active_vacancies', list);
}

async function runProactiveSearchUnlocked(username, workDir, options = {}) {
  const refreshAccessToken = typeof options.refreshAccessToken === 'function' ? options.refreshAccessToken : null;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : async () => {};
  const report = progress => Promise.resolve(onProgress({ ...progress, state: 'running' })).catch(e => {
    console.warn('[proactive-search] progress update failed:', e.message);
  });
  await report({ phase: 'preparing', message: 'Подготавливаю поисковые запросы…', progress: 2, completed: 0, total: null });
  let token = readHhToken(username);
  if (!token) throw new Error(`HH токен не найден для пользователя "${username}"`);

  const { resolveSearchContext } = require('./hh-cold-search-context');
  const resolved = resolveSearchContext(workDir, options.vacancyId);
  const vacancyKey = resolved.vacancyId;
  const atsConfig = normalizeAtsConfig(resolved.config);
  delete atsConfig.recruiter_prompt;
  let activeVacancy = resolved.vacancy;
  // Older selection tools stored only title/id. Fetch the actual region instead
  // of guessing from a city name or broadening the search silently.
  const hasArea = obj => Object.prototype.hasOwnProperty.call(obj || {}, 'area');
  if (!hasArea(options) && !hasArea(atsConfig.filters) && !hasArea(atsConfig)
      && (!activeVacancy?.area || typeof activeVacancy.area === 'string' && !/^\d+$/.test(activeVacancy.area))) {
    activeVacancy = await require('./hh-utils').hhFetch(`/vacancies/${encodeURIComponent(vacancyKey)}`, token);
  }
  const searchAreas = resolveSearchAreas(atsConfig, activeVacancy, options);

  // Query generation and AI enrichment both go through the ladder (src/hh-llm.js) —
  // no key is read here any more.


  // Search queries are generated per-vacancy and cached in a per-vacancy file keyed by
  // vacancyKey. They are reused as long as the ATS config fields that influence query
  // generation haven't changed (detected via configHash). Two vacancies never share the
  // same query file, so switching between them doesn't corrupt each other's cache.
  const forceRegen = Boolean(options.forceRegenQueries);
  const exclusions = getSearchExclusions(username, vacancyKey);
  // configHash covers ATS fields + current exclusion comments so that:
  // 1. editing the vacancy criteria invalidates the cache (same as before)
  // 2. adding a recruiter comment ("не из Новосибирска") also invalidates it,
  //    closing the feedback loop between comments and search queries.
  const configHash = atsConfigHash(atsConfig, exclusions);
  let queries = !forceRegen ? loadStoredQueries(username, vacancyKey, configHash) : null;
  // Even when loading from cache, re-validate relevance. Without this check, stale
  // off-topic queries (e.g. "Data Scientist" for "Финансовый советник") survive across
  // deploys because the cache key matches but the content was generated by an older,
  // buggy code path that lacked the sanity check.
  const manualQueries = Boolean(queries && readStoredQueriesRecord(username, vacancyKey)?.manual);
  if (queries && !manualQueries && !queriesLookSane(queries, atsConfig)) {
    console.warn(`[proactive-search] cached queries failed sanity check for "${atsConfig.vacancy_title}": ${JSON.stringify(queries)}. Forcing regeneration.`);
    queries = null;
  }
  if (!queries) {
    if (!ladderToken()) throw new Error('llm-ladder токен не найден — нужен, чтобы сгенерировать поисковые запросы под эту вакансию.');
    await report({ phase: 'queries', message: 'Формирую запросы для HH…', progress: 5, completed: 0, total: null });
    queries = await generateSearchQueries(atsConfig, null, exclusions);
    saveStoredQueries(username, vacancyKey, queries, configHash);
  }

  const allCandidates = new Map();

  await report({ phase: 'search', message: 'Ищу резюме на HeadHunter…', progress: 8, completed: 0, total: queries.length });
  for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
    const query = queries[queryIndex];
    const data = await searchResumes(query, token, username, { areas: searchAreas, refreshAccessToken });
    for (const r of (data.items || [])) {
      if (r.id && !allCandidates.has(r.id)) allCandidates.set(r.id, r);
    }
    await report({ phase: 'search', message: `Ищу резюме на HeadHunter… (${queryIndex + 1} из ${queries.length} запросов)`, progress: 8 + Math.round(((queryIndex + 1) / queries.length) * 22), completed: queryIndex + 1, total: queries.length });
    await new Promise(r => setTimeout(r, 300));
  }

  const scored = [];
  for (const r of allCandidates.values()) {
    const result = scoreCandidate(r, atsConfig);
    if (!result) continue;
    const { score, signals } = result;
    const expMonths = r.total_experience?.months ?? 0;
    const companies = (r.experience || []).slice(0, 3).map(e => e.company || '').filter(Boolean);
    scored.push({
      id: r.id,
      hh_url: r.alternate_url || '',
      title: r.title || '',
      first_name: r.first_name || '',
      last_name: r.last_name || '',
      age: r.age || null,
      area: r.area?.name || '',
      total_exp_months: expMonths,
      total_exp_years: Math.round(expMonths / 12 * 10) / 10,
      // Keyword pre-score: only picks who gets AI-scored first. score/score_pct/tag
      // come from the ATS assessment (atsScoreFields) and are absent until then, so a
      // re-found candidate keeps the assessment already stored for them.
      pre_score: score,
      score_signals: signals,
      salary: r.salary || null,
      recent_companies: companies,
      experience: (r.experience || []).slice(0, 5).map(e => ({
        position: e.position || '',
        company: e.company || '',
        start: e.start || '',
        end: e.end || null,
      })),
    });
  }

  scored.sort((a, b) => b.pre_score - a.pre_score);

  // Seen/new status must be computed against the FULL scored pool, not just the
  // AI-enriched slice below — otherwise a genuinely new candidate who scores outside
  // the top-30 never gets marked seen or surfaced as "new" and silently vanishes
  // forever (recruiter never sees them, digest never mentions them).
  const collectedIds = scored.map(c => c.id).filter(Boolean);
  const seenBucketBefore = loadSeenIds(username)[vacancyKey] || {};
  const newIds = new Set(collectedIds.filter(id => !seenBucketBefore[id]));
  const seenInfo = { newIds, newCount: newIds.size,
    totalSeenAfter: Object.keys(seenBucketBefore).length + newIds.size,
    firstRun: Object.keys(seenBucketBefore).length === 0 };

  const top30 = scored.slice(0, TOP_ENRICH);
  const top30Ids = new Set(top30.map(c => c.id));
  // AI enrichment covers the top-N by pre-score (for the review page) plus every
  // candidate that's new this run, so new candidates always get tags/summary and
  // show up in the Telegram digest even when their pre-score doesn't crack the
  // top-30. Skipped on first run — then every candidate is "new" and this would
  // enrich the entire backlog; first run keeps the old top-30-only behavior.
  // Capped as a cost safety net for an unusually large incremental batch.
  const NEW_ENRICH_CAP = 50;
  let newButNotTop30 = seenInfo.firstRun
    ? []
    : scored.filter(c => seenInfo.newIds.has(c.id) && !top30Ids.has(c.id));
  if (newButNotTop30.length > NEW_ENRICH_CAP) {
    console.warn(`[proactive-search] ${newButNotTop30.length} new candidates outside top-30, capping AI enrichment at ${NEW_ENRICH_CAP}`);
    newButNotTop30 = newButNotTop30.slice(0, NEW_ENRICH_CAP);
  }
  const toEnrich = [...top30, ...newButNotTop30];

  // One load of the unified store, two views of it:
  //  - previous: vacancy-scoped (same shape loadAllCandidates(username, vacancyKey)
  //    returned) — keeps the assessment_hash cache path byte-compatible;
  //  - storeRaw + storeAssessment: unscoped per-field merge — the carry path must
  //    see the real stored score, not candidateForVacancy's score:0 default-fill.
  const storeRaw = loadAllCandidates(username);
  const previous = {};
  for (const [id, c] of Object.entries(storeRaw)) {
    if (candidateMatchesVacancy(c, vacancyKey)) previous[id] = candidateForVacancy(c, vacancyKey);
  }
  const assessmentHash = c => require('crypto').createHash('sha256').update(JSON.stringify({ candidate: c, config: atsConfig, v: ATS_SCORING_VERSION })).digest('hex');
  const pending = [];
  const cached = [];
  for (const c of toEnrich) {
    const hash = assessmentHash(c);
    if (previous[c.id]?.assessment_hash === hash && previous[c.id]?.ats_scored) cached.push({ ...previous[c.id], ...c });
    else pending.push({ ...c, assessment_hash: hash });
  }
  let enriched = [...cached, ...pending];
  if (pending.length > 0 && !ladderToken()) {
    console.warn('[proactive-search] llm-ladder credentials missing — skipping AI enrichment');
  } else if (pending.length > 0) {
    console.error(`[proactive-search] enriching ${toEnrich.length} candidates with AI (top-30 + ${newButNotTop30.length} new)…`);
    try {
      await report({ phase: 'ai_scoring', message: `Оцениваю кандидатов по ATS… (0 из ${toEnrich.length})`, progress: 35, completed: cached.length, total: toEnrich.length, failures: 0 });
      let failures = 0;
      enriched = [...cached, ...await enrichCandidates(pending, atsConfig, async batch => {
        failures += batch.failed;
        const completed = cached.length + batch.attempted;
        const percent = 35 + Math.round((completed / Math.max(1, toEnrich.length)) * 60);
        await report({ phase: 'ai_scoring', message: `Оцениваю кандидатов по ATS… (${completed} из ${toEnrich.length})`, progress: percent, completed, total: toEnrich.length, failures });
      })];
    } catch (e) {
      console.error('[proactive-search] enrichment failed:', e.message);
      await report({ phase: 'ai_scoring', message: 'Не удалось завершить AI-оценку; сохраняю результаты поиска…', progress: 95, completed: cached.length, total: toEnrich.length, failures: pending.length });
    }
  } else {
    await report({ phase: 'ai_scoring', message: 'Актуальные AI-оценки уже есть; завершаю поиск…', progress: 95, completed: toEnrich.length, total: toEnrich.length, failures: 0 });
  }

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const dataDir = dataRoot();
  const outDir = path.join(dataDir, 'hh', username, 'proactive');
  fs.mkdirSync(outDir, { recursive: true });

  // Mark is_new on candidates that appear for the first time
  const enrichedById = new Map(enriched.map(c => [c.id, c]));
  // Persist the full collected pool, including candidates outside the enrichment
  // budget. A candidate must exist durably before it can become "seen".
  //
  // Carry the existing ATS assessment over for everyone outside toEnrich: scored[]
  // holds fresh HH objects with no ats_* fields, so writing them as-is made the
  // snapshot claim ~250 candidates per search are unscored while all-candidates
  // had them scored — the background pass then re-bought every one of them from
  // the LLM on each 30-min search cycle (the 2026-09-30 spend leak).
  const atsHash = atsScoringHash(atsConfig);
  const markedCandidates = scored.map(c => ({
    ...(enrichedById.get(c.id) || carryAssessment(c, storeAssessment(storeRaw[c.id], vacancyKey), atsHash)),
    is_new: seenInfo.newIds.has(c.id),
    ai_pending: enrichedById.has(c.id),
  })).sort(compareByAtsScore);
  const foundAtById = {};
  for (const c of markedCandidates) {
    foundAtById[c.id] = new Date(seenBucketBefore[c.id] || now).toISOString();
  }
  mergeSearchCandidatesIntoAll(username, markedCandidates, foundAtById, vacancyKey);
  mergeSeenIds(username, vacancyKey, collectedIds);

  const outFile = path.join(outDir, `search-results-${dateStr}-${vacancyKey}.json`);
  const output = {
    vacancy_id: vacancyKey,
    vacancy_title: atsConfig.vacancy_title || 'Вакансия',
    search_queries: queries,
    search_area_ids: searchAreas,
    search_area_names: searchAreaNames(searchAreas, activeVacancy),
    searched_at: now.toISOString(),
    total_collected: allCandidates.size,
    total_after_knockout: scored.length,
    ai_enriched: enriched.length > 0 && enriched.every(c => Array.isArray(c.plus_tags)),
    ai_pending_count: enriched.filter(c => !Array.isArray(c.plus_tags)).length,
    ats_config: atsConfig,
    candidates: markedCandidates,
  };
  fs.writeFileSync(outFile + '.tmp-' + process.pid, JSON.stringify(output, null, 2), 'utf8');
  fs.renameSync(outFile + '.tmp-' + process.pid, outFile);

  // A vacancy searched by id but not tracked yet (the agent skipped hh_set_active_vacancy)
  // must still show up in the /hh/* vacancy pickers — otherwise its results page exists
  // but the recruiter can't reach it from the list.
  await trackVacancy(workDir, vacancyKey, activeVacancy, output.vacancy_title, token);
  await report({ phase: 'saving', message: 'Сохраняю кандидатов и оценки…', progress: 98, completed: enriched.filter(c => c.ats_scored).length, total: toEnrich.length, failures: Math.max(0, enriched.filter(c => !c.ats_scored).length) });

  const pass_count = enriched.filter(c => c.tag === 'PASS').length;
  const review_count = enriched.filter(c => c.tag === 'REVIEW').length;


  return {
    file: outFile,
    count: enriched.length,
    total_found: scored.length,
    pass_count,
    review_count,
    searched_at: now.toISOString(),
    vacancy_id: vacancyKey,
    vacancy_title: output.vacancy_title,
    ai_enriched: output.ai_enriched,
    ai_pending_count: output.ai_pending_count,
    new_count: seenInfo.newCount,
    new_ids: Array.from(seenInfo.newIds),
    total_seen: seenInfo.totalSeenAfter,
    first_run: seenInfo.firstRun,
  };
}

// Score any un-enriched candidates in the latest proactive results file.
// Called by the 5-min background cron so enrichment happens automatically
// without waiting for the user to open the web page.
async function scoreUnscoredProactiveCandidates(username, options = {}) {
  let release;
  try { release = require('./hh-cold-search-lock').acquireSearchLock(username); }
  catch (error) {
    if (error.code === 'SEARCH_BUSY') {
      if (options.vacancyId) {
        const progress = getAtsRefreshProgress(username, options.vacancyId);
        const saved = readAtsRefreshProgress(username, options.vacancyId);
        const savedAge = saved?.updated_at ? Date.now() - Date.parse(saved.updated_at) : Infinity;
        const anotherRefreshIsLive = saved?.status === 'running' && savedAge < 120_000;
        if (progress.pending && !anotherRefreshIsLive) writeAtsRefreshProgress(username, options.vacancyId, { config_hash: atsScoringHash(require('./hh-cold-search-context').resolveSearchContext(path.join(usersRoot(), String(username)), options.vacancyId).config), status: 'queued', completed: progress.completed, total: progress.total, failures: 0 });
      }
      return 0;
    }
    throw error;
  }
  try {
    const dataDir = dataRoot();
    const dir = path.join(dataDir, 'hh', String(username), 'proactive');
    // The only LLM call left in this loop is enrichment → free ladder.
    if (!ladderToken()) return 0;
    const latest = new Map();
    for (const name of fs.readdirSync(dir).filter(f => /^search-results-.*\.json$/.test(f))) {
      const file = path.join(dir, name);
      let results;
      try { results = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      if (!results.vacancy_id || (options.vacancyId && String(results.vacancy_id) !== String(options.vacancyId))) continue;
      const prior = latest.get(String(results.vacancy_id));
      if (!prior || Date.parse(results.searched_at) > Date.parse(prior.results.searched_at)) latest.set(String(results.vacancy_id), { file, results });
    }
    // Budget per background tick (5 min), per profile, shared across vacancies. Sized
    // so a funnel edit (or a scoring-version bump) re-scores a ~10-vacancy profile
    // within about an hour, not an afternoon.
    let remaining = 150, completed = 0, vacanciesLeft = latest.size;
    const workDir = path.join(usersRoot(), String(username));
    // Unified store loaded once per tick: the snapshot is NOT authoritative for
    // "who is scored" (a fresh search rebuilds candidates without ats_* fields),
    // the store is. Second-layer guard — even if the snapshot writer regresses,
    // an already-assessed candidate never costs an LLM call again.
    const store = loadAllCandidates(username);
    for (const { file, results } of latest.values()) {
      if (remaining <= 0) break;
      // Score against the funnel as it is now (the recruiter may have edited it in
      // the ATS editor since the search ran), not the snapshot taken at search time.
      let atsConfig = results.ats_config || {};
      try {
        atsConfig = normalizeAtsConfig(require('./hh-cold-search-context').resolveSearchContext(workDir, results.vacancy_id).config);
      } catch { /* config gone — keep scoring with the snapshot */ }
      results.ats_config = atsConfig;
      const hash = atsScoringHash(atsConfig);
      const candidates = results.candidates || [];
      const currentCompleted = () => candidates.filter(candidate => !needsAtsScore(candidate, hash)).length;
      const currentPending = () => Math.max(0, candidates.length - currentCompleted());
      writeAtsRefreshProgress(username, results.vacancy_id, {
        config_hash: hash, status: currentPending() ? 'running' : 'complete',
        completed: currentCompleted(), total: candidates.length, failures: 0,
      });
      const allowance = Math.ceil(remaining / vacanciesLeft--);
      const unscored = candidates.filter(c => needsAtsScore(c, hash)).slice(0, allowance);
      if (!unscored.length) continue;
      // Carry what the store already knows before spending budget: only the
      // genuinely-new candidates (or an edited funnel) reach the LLM below.
      // Carrying is free (no LLM), so it does NOT consume the remaining budget.
      const carried = [];
      const needScore = [];
      for (const c of unscored) {
        const merged = carryAssessment(c, storeAssessment(store[c.id], results.vacancy_id), hash);
        if (merged !== c) { Object.assign(c, merged); carried.push(c); }
        else needScore.push(c);
      }
      if (!needScore.length) {
        if (carried.length) {
          candidates.sort(compareByAtsScore);
          const temp0 = file + '.tmp-' + process.pid;
          fs.writeFileSync(temp0, JSON.stringify(results, null, 2), 'utf8');
          fs.renameSync(temp0, file);
          completed += carried.length;
        }
        writeAtsRefreshProgress(username, results.vacancy_id, { config_hash: hash, status: currentPending() ? 'queued' : 'complete', completed: currentCompleted(), total: candidates.length, failures: 0 });
        continue;
      }
      remaining -= needScore.length;
      let failures = 0;
      const heartbeat = setInterval(() => writeAtsRefreshProgress(username, results.vacancy_id, {
        config_hash: hash, status: 'running', completed: currentCompleted(), total: candidates.length, failures,
      }), 30_000);
      heartbeat.unref?.();
      let enriched;
      try {
        enriched = await enrichCandidates(needScore, atsConfig, async batch => {
          failures += batch.failed;
          writeAtsRefreshProgress(username, results.vacancy_id, {
            config_hash: hash, status: 'running', completed: currentCompleted(), total: candidates.length, failures,
          });
        });
      } finally { clearInterval(heartbeat); }
      for (const candidate of enriched) {
        const idx = candidates.findIndex(c => c.id === candidate.id);
        if (idx >= 0) Object.assign(candidates[idx], candidate);
      }
      mergeSearchCandidatesIntoAll(username, enriched, {}, results.vacancy_id);
      // Sort before writing: the snapshot order is what the tool view and the page's
      // first-run fallback show.
      candidates.sort(compareByAtsScore);
      const temp = file + '.tmp-' + process.pid;
      fs.writeFileSync(temp, JSON.stringify(results, null, 2), 'utf8');
      fs.renameSync(temp, file);
      completed += carried.length + enriched.filter(c => c.ats_scored).length;
      writeAtsRefreshProgress(username, results.vacancy_id, {
        config_hash: hash, status: currentPending() ? 'queued' : 'complete',
        completed: currentCompleted(), total: candidates.length, failures,
      });
    }
    return completed;
  } finally { release(); }
}

// Per-user proactive search schedule config.
// Schema: { enabled: bool, interval_hours: number, last_run: ISO|null }
function schedulePath(username) {
  const dataDir = dataRoot();
  return path.join(dataDir, 'hh', String(username), 'proactive', 'schedule.json');
}

function loadSchedule(username) {
  try {
    const raw = JSON.parse(fs.readFileSync(schedulePath(username), 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[proactive-schedule] read failed:', e.message);
    return null;
  }
}

function saveSchedule(username, data) {
  const file = schedulePath(username);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

module.exports = {
  runProactiveSearch,
  trackVacancy,
  buildScoringPromptText,
  scoreUnscoredProactiveCandidates,
  getAtsRefreshProgress,
  queriesLookSane,
  deriveFallbackQueries,
  normalizeAtsConfig,
  scoreCandidate,
  loadSeenIds,
  saveSeenIds,
  mergeSeenIds,
  seenIdsPath,
  loadCandidateComments,
  saveCandidateComment,
  CANDIDATE_STATUSES,
  candidateStatusOf,
  setCandidateStatus,
  getSearchExclusions,
  // Unified all-candidates store (search + manual)
  allCandidatesPath,
  loadAllCandidates,
  saveAllCandidates,
  mergeSearchCandidatesIntoAll,
  addManualCandidate,
  candidateMatchesVacancy,
  candidateForVacancy,
  parseResumeId,
// Per-vacancy query store
  atsConfigHash,
  queriesStorePath,
  loadStoredQueries,
  saveStoredQueries,
  readStoredQueriesRecord,
  // Recruiter search prompt (web editor)
  atsScoreFields,
  atsScoringHash,
  needsAtsScore,
  carryAssessment,
  storeAssessment,
  compareByAtsScore,
  saveSearchSettings,
  searchSettingsView,
  // Schedule config
  schedulePath,
  loadSchedule,
  saveSchedule,
};
