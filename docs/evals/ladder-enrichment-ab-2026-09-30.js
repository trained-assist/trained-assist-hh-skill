#!/usr/bin/env node
// Сравнение free-ladder vs deepseek (стандартная) на 30 реальных кандидатах HH.
// Запускается НА VM (там токен лестницы). Результаты → /tmp/ladder-eval-results.json
'use strict';
const fs = require('fs');

const TOKEN = fs.readFileSync('/home/vova/agent-tokens/llm-ladder/token', 'utf8').trim();
const LADDER_URL = (process.env.LLM_LADDER_URL || 'https://llm-ladder.trainedassist.store').replace(/\/+$/, '');
const SRC = '/home/vova/agent-data/hh/tes-recruiter/proactive/search-results-2026-09-30-137012564.json';
const OUT = '/tmp/ladder-eval-results.json';
const N_PER_TAG = 10;          // 10 PASS + 10 REVIEW + 10 WEAK
const REPS = 2;                // повторы для дисперсии
const TEMPERATURE = 0.7;       // просим дисперсию
const ARMS = [
  { name: 'free',    model: 'free-ladder' },
  { name: 'standard', model: 'deepseek' },   // alias service → deepseek (то, что шлёт service-llm)
];

// ── Промпт 1-в-1 из enrichCandidate (prod hh-proactive-search.js) ─────────────
function buildPrompt(cand, atsConfig) {
  const cfg = atsConfig || {};
  const knockoutStr = (cfg.knockout || []).map(k => `- ${k}`).join('\n') || '—';
  const requiredStr = (cfg.required || []).map(r => `- ${r.name} (вес ${r.weight})`).join('\n') || '—';
  const preferredStr = (cfg.preferred || []).map(r => `- ${r.name} (вес ${r.weight})`).join('\n') || '—';
  const expStr = (cand.experience || [])
    .map(e => `${e.position} — ${e.company} (${e.start || '?'} – ${e.end || 'н.в.'})`)
    .join('\n') || '—';
  const minExp = cfg.filters?.min_experience_years;
  return `Ты — опытный рекрутер. Оцени кандидата из базы резюме HH для вакансии "${cfg.vacancy_title || 'Вакансия'}".
${cfg.vacancy_context ? `\nКонтекст вакансии: ${cfg.vacancy_context}` : ''}${minExp ? `\nМинимальный опыт: ${minExp} лет.` : ''}

СТОП-ФАКТОРЫ (knockout, критичны):
${knockoutStr}

Обязательные критерии (с весами):
${requiredStr}

Желательные:
${preferredStr}

Кандидат:
Должность: ${cand.title}
Опыт: ${cand.total_exp_years} лет
Компании: ${(cand.recent_companies || []).join(', ')}
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
  "summary_pitch": "1-2 предложения: что конкретно сказать клиенту о продаже кандидата"
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
}

// ── atsScoreFields (prod) ─────────────────────────────────────────────────────
function atsScoreFields(ai) {
  const raw = Number(ai?.score);
  if (!Number.isFinite(raw)) return { degraded: true };
  const kf = (Array.isArray(ai.knockout_failed) ? ai.knockout_failed : []).map(s => String(s || '').trim()).filter(Boolean);
  let score = Math.max(0, Math.min(10, raw));
  if (kf.length) score = Math.min(score, 2);
  score = Math.round(score * 2) / 2;
  return { score, tag: score >= 7 ? 'PASS' : score >= 5 ? 'REVIEW' : 'WEAK', knockout: kf.length > 0 };
}

// ── выборка: стратифицированная по прод-тегу ──────────────────────────────────
function sample() {
  const r = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const all = (r.candidates || []).filter(c => c.score != null && (c.experience || []).length > 0);
  const buckets = { PASS: [], REVIEW: [], WEAK: [] };
  for (const c of all) if (buckets[c.tag]) buckets[c.tag].push(c);
  // детерминированный shuffle
  let s = 42;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const pick = [];
  for (const t of ['PASS', 'REVIEW', 'WEAK']) {
    const b = buckets[t];
    for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; }
    pick.push(...b.slice(0, N_PER_TAG));
  }
  return { vacancy: r.ats_config, candidates: pick, pool: { PASS: buckets.PASS.length, REVIEW: buckets.REVIEW.length, WEAK: buckets.WEAK.length } };
}

// ── вызов лестницы ────────────────────────────────────────────────────────────
async function callLadder(model, prompt) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${LADDER_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, temperature: TEMPERATURE, max_tokens: 600,
        ladder_timeout_ms: 45000, ladder_total_timeout_ms: 60000,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(70000),
    });
    const ms = Date.now() - t0;
    const j = await res.json();
    if (!res.ok || j.error) return { ok: false, error: (j.error && j.error.message) || `HTTP ${res.status}`, ms };
    const content = j.choices?.[0]?.message?.content || '';
    let parsed;
    try { parsed = JSON.parse(String(content).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()); }
    catch {
      const m = String(content).match(/\{[\s\S]*\}/);
      if (!m) return { ok: false, error: 'no JSON in response', ms, model: j.model, raw: String(content).slice(0, 200) };
      try { parsed = JSON.parse(m[0]); } catch (e) { return { ok: false, error: 'bad JSON', ms, model: j.model, raw: String(content).slice(0, 200) }; }
    }
    return { ok: true, ms, model: j.model, fields: atsScoreFields(parsed),
             summary_why: String(parsed.summary_why || '').slice(0, 120),
             n_plus: (parsed.plus_tags || []).length, n_yellow: (parsed.yellow_tags || []).length, n_red: (parsed.red_tags || []).length };
  } catch (e) { return { ok: false, error: e.message, ms: Date.now() - t0 }; }
}

async function main() {
  const { vacancy, candidates, pool } = sample();
  console.log(`пул: PASS=${pool.PASS} REVIEW=${pool.REVIEW} WEAK=${pool.WEAK} → выборка ${candidates.length} (${N_PER_TAG}×3), reps=${REPS}, temp=${TEMPERATURE}`);
  const jobs = [];
  for (const cand of candidates)
    for (const arm of ARMS)
      for (let rep = 1; rep <= REPS; rep++)
        jobs.push({ cand, arm, rep });
  console.log(`всего вызовов: ${jobs.length}`);
  const CONC = 6;
  const results = [];
  let done = 0;
  for (let i = 0; i < jobs.length; i += CONC) {
    const chunk = jobs.slice(i, i + CONC);
    const out = await Promise.all(chunk.map(async j => {
      const r = await callLadder(j.arm.model, buildPrompt(j.cand, vacancy));
      done++;
      if (done % 15 === 0) console.log(`  ${done}/${jobs.length}`);
      return { id: j.cand.id, prod_score: j.cand.score, prod_tag: j.cand.tag,
               arm: j.arm.name, rep: j.rep, ...r };
    }));
    results.push(...out);
  }
  fs.writeFileSync(OUT, JSON.stringify({ meta: { temperature: TEMPERATURE, reps: REPS, n: candidates.length, at: new Date().toISOString() }, results }, null, 1));
  console.log('OK →', OUT);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
