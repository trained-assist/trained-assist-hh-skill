'use strict';
// «Запустить оценку» (#90, эпик #83, фаза 4): async-прогон с прогрессом на диске,
// взвешенный скоринг must-have/nice-have из ATS-конфига, veto, ранг среди кандидатов
// вакансии. Формула Σ(s×w)/Σ(5×w) — та же, что в каноне оценки (#91).
// Интервью-вклад (#89) подключается null-safe: есть файл — включаем, нет — пропускаем.
const fs = require('fs');
const path = require('path');
const { dataRoot, usersRoot } = require('./data-paths.js');
const { hhLlmJson, ladderToken } = require('./hh-llm');
const { readPortrait, buildAtsFromPortrait } = require('./hh-portrait');
const { readAtsConfig } = require('./hh-scoring');
const { readManifest, combinedText } = require('./hh-candidate-docs');

// ── Чистая математика (unit-тесты) ────────────────────────────────────────────

function weightedTotals(rows, { passThreshold = 65, reviewThreshold = 40 } = {}) {
  const usable = (rows || []).filter(r => r && r.score !== null && r.score !== undefined && r.score !== 'n/a');
  if (!usable.length) return { percent: null, score10: null, veto: [], verdict: null };
  let sum = 0;
  let max = 0;
  const veto = [];
  for (const r of usable) {
    const w = Number(r.weight) || 1;
    const s = Math.max(0, Math.min(5, Number(r.score)));
    sum += s * w;
    max += 5 * w;
    if ((r.klass === 'must' || r.must === true) && s <= 1) veto.push(r.name);
  }
  const percent = max ? Math.round((sum / max) * 100) : null;
  const score10 = percent === null ? null : Math.round(percent) / 10;
  let verdict = 'ОТКЛОНИТЬ';
  if (veto.length) verdict = 'ОТКЛОНИТЬ';
  else if (percent !== null && percent >= passThreshold) verdict = 'ПРОПУСТИТЬ';
  else if (percent !== null && percent >= reviewThreshold) verdict = 'УТОЧНИТЬ';
  return { percent, score10, veto, verdict };
}

function comparisonFor(percent, others) {
  if (percent === null || percent === undefined) return null;
  const pool = [...(others || []).filter(x => Number.isFinite(x)), percent].sort((a, b) => b - a);
  const place = pool.findIndex(x => x === percent) + 1;
  const avg = Math.round(pool.reduce((s, x) => s + x, 0) / pool.length);
  return { min: pool[pool.length - 1], max: pool[0], avg, place: place || pool.length, total: pool.length, percent };
}

// ── Пул кандидатов вакансии для ранга ─────────────────────────────────────────
// HH-кандидаты: ats_result.score (0–10 → %). Холодный поиск: score (0–12 → %),
// только кандидаты этой вакансии (или wildcard). Готовые job-результаты — свои же.

function comparisonPool(username, vacancyId, excludeCandidateId) {
  const root = path.join(dataRoot(), 'hh', username);
  const out = [];

  try {
    for (const f of fs.readdirSync(path.join(root, 'candidates'))) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(root, 'candidates', f), 'utf8'));
        const s = j?.ats_result?.score;
        if (Number.isFinite(s)) out.push(Math.round(Math.max(0, Math.min(10, s)) * 10));
      } catch { /* skip */ }
    }
  } catch { /* нет директории */ }

  try {
    const all = JSON.parse(fs.readFileSync(path.join(root, 'proactive', 'all-candidates.json'), 'utf8'));
    for (const c of Object.values(all || {})) {
      const vacs = Array.isArray(c.vacancy_ids) ? c.vacancy_ids : [];
      const mine = !vacs.length || !vacancyId || vacs.includes(vacancyId);
      const s = Number(c.score);
      if (mine && Number.isFinite(s)) out.push(Math.round((Math.max(0, Math.min(12, s)) / 12) * 100));
    }
  } catch { /* нет файла */ }

  try {
    const dir = path.join(root, 'candidate-eval');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.job.json')) continue;
      const id = f.replace(/\.job\.json$/, '');
      if (id === excludeCandidateId) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (j.state === 'done' && (!vacancyId || !j.vacancy_id || j.vacancy_id === vacancyId) && Number.isFinite(j.percent)) out.push(j.percent);
      } catch { /* skip */ }
    }
  } catch { /* нет директории */ }

  return out;
}

// ── LLM-скоринг по критериям ──────────────────────────────────────────────────

const SCORE_SYSTEM = `Ты — опытный рекрутер. Оцени кандидата по каждому критерию вакансии.
Шкала 0–5 (целыми):
  0 — явное несоответствие (или данных нет и это подтверждено)
  1 — почти нет нужного
  2 — частично, с оговорками
  3 — соответствует (уровень median-специалиста)
  4 — выше требуемого, есть подтверждённые примеры
  5 — значительно превосходит
Правила:
- evidence ОБЯЗАТЕЛЕН: цитата или конкретный факт из данных кандидата; без него — не оценка.
- Если в данных нет информации по критерию — score: null (это «не оценивалось», не 0).
- Не выдумывай факты. Человекочитаемые названия критериев сохраняй точно как даны.
- Отвечай ТОЛЬКО JSON: {"rows":[{"name":"<как в списке>","score":3,"evidence":"..."}],"reasoning":"2-3 предложения"}`;

function buildScoreUser(config, candidateText) {
  const req = (config.required || []).map(r => `- ${r.name || r} (вес ${r.weight || 1})`).join('\n');
  const pref = (config.preferred || []).map(r => `- ${r.name || r} (вес ${r.weight || 1})`).join('\n');
  return `Вакансия: ${config.vacancy_title || ''}\nКонтекст: ${(config.vacancy_context || '').slice(0, 800)}\n\nОБЯЗАТЕЛЬНЫЕ критерии (must-have):\n${req || '—'}\n\nЖЕЛАТЕЛЬНЫЕ (nice-to-have):\n${pref || '—'}\n\nДанные кандидата:\n${candidateText.slice(0, 50000)}`;
}

async function llmScoreRows(config, candidateText) {
  const out = await hhLlmJson({
    messages: [
      { role: 'system', content: SCORE_SYSTEM },
      { role: 'user', content: buildScoreUser(config, candidateText) },
    ],
    purpose: 'score',
    temperature: 0.1,
    maxTokens: 2500,
    timeoutMs: 60_000,
    source: 'hh-eval-job',
  });
  const byName = new Map((out.rows || []).map(r => [String(r.name || '').toLowerCase(), r]));
  const rows = [];
  for (const [klass, list] of [['must', config.required || []], ['nice', config.preferred || []]]) {
    for (const item of list) {
      const name = item.name || item;
      const weight = item.weight || 1;
      const hit = byName.get(String(name).toLowerCase());
      const score = hit && hit.score !== null && hit.score !== undefined ? Math.max(0, Math.min(5, Number(hit.score))) : null;
      rows.push({ name, klass, weight, score, evidence: hit?.evidence || '', source: 'резюме/документы' });
    }
  }
  return { rows, reasoning: String(out.reasoning || '').slice(0, 800) };
}

// ── Job: файл + шаги ──────────────────────────────────────────────────────────

function jobsDir(username) {
  return path.join(dataRoot(), 'hh', username, 'candidate-eval');
}

function jobPath(username, candidateId) {
  return path.join(jobsDir(username), `${candidateId}.job.json`);
}

function readJob(username, candidateId) {
  try { return JSON.parse(fs.readFileSync(jobPath(username, candidateId), 'utf8')); } catch { return null; }
}

function saveJob(job) {
  const file = jobPath(job.username, job.candidate_id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(job, null, 2));
  return job;
}

function assemble(username, candidateId, vacancyId) {
  const manifest = readManifest(username, candidateId);
  if (!manifest) return { error: 'Кандидат не найден — загрузи документы в /hh/candidate-new.' };

  const workDir = path.join(usersRoot(), username);
  let activeId = vacancyId || null;
  if (!activeId) {
    try {
      activeId = JSON.parse(fs.readFileSync(path.join(workDir, 'contexts', 'hh', 'active_vacancy.json'), 'utf8'))?.value?.id || null;
    } catch { /* нет активной */ }
  }
  const vid = activeId || 'draft';

  const portrait = (() => { try { return readPortrait(workDir, vid); } catch { return null; } })();
  let config = readAtsConfig(workDir, activeId || null);
  let configSource = 'ats_config';
  if (!config && portrait) {
    config = buildAtsFromPortrait(portrait, vid);
    configSource = 'portrait';
  }
  if (!config || !(config.required?.length) && !(config.preferred?.length)) {
    return { error: 'Нет ATS-конфига и портрета с навыками — собери портрет или сохрани конфиг в /hh/ats-editor.' };
  }

  const candidateText = [combinedText(username, candidateId), manifest.profile ? JSON.stringify(manifest.profile, null, 1) : '']
    .filter(Boolean).join('\n\n');
  if (!candidateText.trim()) return { error: 'Нет текста документов кандидата — загрузи резюме/письмо.' };

  const interviewEval = (() => {
    try {
      const f = path.join(dataRoot(), 'hh', username, 'interviews', `${candidateId}.interview-eval.json`);
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch { return null; }
  })();

  return {
    error: null, manifest, config, configSource, candidateText, vid,
    vacancy_title: config.vacancy_title || portrait?.vacancy?.title || manifest.name,
    interviewEval,
    thresholds: { passThreshold: Math.round((config.pass_threshold || 6.5) * 10), reviewThreshold: Math.round((config.review_threshold || 4) * 10) },
  };
}

// deps подменяются в тестах: { scoreFn, now }
async function runEvalJob(job, deps = {}) {
  const started = Date.now();
  const scoreFn = deps.scoreFn || llmScoreRows;
  try {
    job.state = 'running'; job.step = 'assemble'; job.progress = 10; saveJob(job);
    const a = assemble(job.username, job.candidate_id, job.vacancy_id);
    if (a.error) throw new Error(a.error);

    job.progress = 40; job.step = 'llm_scoring'; saveJob(job);
    const { rows, reasoning } = await scoreFn(a.config, a.candidateText);

    job.progress = 70; job.step = 'comparison'; saveJob(job);
    const totals = weightedTotals(rows, a.thresholds);
    const pool = comparisonPool(job.username, a.vid, job.candidate_id);
    const comparison = comparisonFor(totals.percent, pool);

    const interview = a.interviewEval
      ? { percent: a.interviewEval.percent ?? null, score10: a.interviewEval.score10 ?? null, verdict: a.interviewEval.verdict ?? null }
      : null;

    const finished = Date.now();
    Object.assign(job, {
      state: 'done', step: 'done', progress: 100,
      finished_at: new Date(finished).toISOString(),
      spent_minutes: Math.max(1, Math.round((finished - started) / 600) / 10),
      vacancy_id: a.vid, vacancy_title: a.vacancy_title,
      percent: totals.percent, score10: totals.score10, verdict: totals.verdict,
      veto: totals.veto, rows, reasoning, comparison, interview,
      config_source: a.configSource,
    });
    return saveJob(job);
  } catch (e) {
    job.state = 'failed';
    job.step = 'failed';
    job.error = String(e.message || e).slice(0, 500);
    job.finished_at = new Date().toISOString();
    job.spent_minutes = Math.max(0.1, Math.round((Date.now() - started) / 600) / 10);
    return saveJob(job);
  }
}

function startEvalJob({ username, candidateId, vacancyId = null, runDeps = {} }) {
  if (!ladderToken()) return { error: 'llm-ladder token не найден.' };
  const pre = assemble(username, candidateId, vacancyId);
  if (pre.error) return { error: pre.error };

  const existing = readJob(username, candidateId);
  if (existing && existing.state === 'running') return { error: 'Оценка уже выполняется.' };

  const job = {
    id: candidateId, candidate_id: candidateId, username,
    vacancy_id: pre.vid, vacancy_title: pre.vacancy_title,
    state: 'queued', step: 'queued', progress: 0,
    started_at: new Date().toISOString(), finished_at: null, error: null,
  };
  saveJob(job);
  // Прогон асинхронный: HTTP-ответ не ждёт LLM (#90 — «вжих-вжих» с прогрессом).
  runEvalJob(job, runDeps).catch(e => {
    job.state = 'failed';
    job.error = String(e?.message || e).slice(0, 500);
    try { saveJob(job); } catch { /* диск недоступен — уже не спасём */ }
  });
  return { ok: true, job };
}

module.exports = {
  weightedTotals, comparisonFor, comparisonPool,
  buildScoreUser, llmScoreRows, assemble,
  jobsDir, jobPath, readJob, saveJob, runEvalJob, startEvalJob,
};
