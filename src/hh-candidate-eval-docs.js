'use strict';
// Два документа кандидата (#91, канон: ~/Documents/primery-dokumentov-kandidatov/
// kanon-dokumentov-ocenka-i-profil-kandidata.md):
//   «Чистая оценка» — таблицы фактов (веса из ATS, evidence, покрытие, параллельная
//   ось коммуникации, ранг, ограничения) — без прода.
//   «Полный профиль» — история для заказчика: саммари от первого лица, грид ✓/△/⚠,
//   опыт с «Из интервью», честные нюансы, вывод рекрутера, резюме приложением.
// Рендер детерминированный, без LLM (по образцу 97-candidate-client-report).

const fs = require('fs');
const path = require('path');
const { dataRoot } = require('./data-paths.js');
const { readManifest } = require('./hh-candidate-docs');
const { readPortrait, computeCompleteness } = require('./hh-portrait');

const TODAY = () => new Date().toISOString().slice(0, 10);

// ── Сборка данных из хрелищ (всё опционально: нет источника — честный пробел) ──
// Контракт входов (адаптеры к дочерним сессиям #89/#90 уточняются при их мерже):
//   interview-eval — interviews/<slug>.interview-eval.json (или явный eval_slug)
//   ats_result     — candidates/<neg_id>.json → ats_result (HH-кандидаты)
//   job-результат  — candidate-eval/<candidateId>.job.json, state=done
function readJsonMaybe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function findInterviewEval(username, candidateId, name) {
  const dir = path.join(dataRoot(), 'hh', username, 'interviews');
  const candidates = [
    path.join(dir, `${candidateId}.interview-eval.json`),
    path.join(dir, `${candidateId}`, 'interview-eval.json'),
  ];
  for (const f of candidates) {
    const j = readJsonMaybe(f);
    if (j) return j;
  }
  // мягкий поиск по имени кандидата (один файл на пользователя — частый кейс)
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.interview-eval.json')) continue;
      const j = readJsonMaybe(path.join(dir, f));
      if (j && name && String(j.candidate || '').toLowerCase().includes(String(name).split(' ')[0].toLowerCase())) return j;
    }
  } catch { /* нет директории */ }
  return null;
}

function findEvalJob(username, candidateId) {
  const f = path.join(dataRoot(), 'hh', username, 'candidate-eval', `${candidateId}.job.json`);
  const j = readJsonMaybe(f);
  return j && j.state === 'done' ? j : null;
}

function readAtsResult(username, negId) {
  // HH-кандидаты (negotiation) хранят ats_result в candidates/<neg_id>.json.
  // Рукописные кандидаты (#87) связи с negotiation не имеют — negId не передан → null.
  if (!negId) return null;
  const j = readJsonMaybe(path.join(dataRoot(), 'hh', username, 'candidates', `${negId}.json`));
  return j?.ats_result || null;
}

function buildReportData({ username, candidateId, vacancyId = null, evalSlug = null, negId = null, spentMinutes = null }) {
  const manifest = readManifest(username, candidateId);
  if (!manifest) return { error: 'Кандидат не найден.' };

  // portrait живёт в профильном workDir (contexts/hh), как и во всех hh-роутах
  const profileWorkDir = path.join(require('./data-paths.js').usersRoot(), username);
  let portrait = null;
  try { portrait = readPortrait(profileWorkDir, vacancyId || activeVacancyId(profileWorkDir) || 'draft'); } catch { portrait = null; }

  const interviewEval = evalSlug
    ? readJsonMaybe(path.join(dataRoot(), 'hh', username, 'interviews', `${evalSlug}.interview-eval.json`))
    : findInterviewEval(username, candidateId, manifest.name);
  const job = findEvalJob(username, candidateId);
  const ats = readAtsResult(username, negId);

  const types = new Set(manifest.docs.map(d => d.type));
  const sources = {
    resume: types.has('resume'),
    cover_letter: types.has('cover_letter') || types.has('correspondence'),
    correspondence: types.has('correspondence'),
    interview: types.has('interview'),
  };
  const interviewDoc = manifest.docs.find(d => d.type === 'interview');

  return {
    error: null,
    generated_at: TODAY(),
    candidate: { id: candidateId, name: manifest.name || candidateId },
    vacancy: { title: portrait?.vacancy?.title || job?.vacancy_title || null },
    sources,
    interview_minutes: interviewDoc?.minutes || null,
    portrait_completeness: portrait ? computeCompleteness(portrait) : null,
    profile: manifest.profile || null,
    resume_raw: combinedResumeText(username, candidateId, manifest),
    scoring: buildScoring(interviewEval, job, ats, spentMinutes),
    interview_coverage: interviewEval?.coverage || null,
    communication: interviewEval?.communication || null,
    comparison: job?.comparison || null,
    ats_gaps: ats ? { matched: ats.matched || [], gaps: ats.gaps || [], reasoning: ats.reasoning || '' } : null,
    limitations: buildLimitations({ sources, interviewEval, job, ats }),
  };
}

function activeVacancyId(workDir) {
  try {
    const j = JSON.parse(require('fs').readFileSync(path.join(workDir, 'contexts', 'hh', 'active_vacancy.json'), 'utf8'));
    return j?.value?.id || null;
  } catch { return null; }
}

function combinedResumeText(username, candidateId, manifest) {
  const root = path.join(dataRoot(), 'hh', username, 'candidate-docs', candidateId);
  const parts = [];
  for (const doc of manifest.docs) {
    if (!['resume', 'cover_letter', 'correspondence'].includes(doc.type)) continue;
    const f = path.join(root, `${doc.id}.txt`);
    if (fs.existsSync(f)) parts.push(fs.readFileSync(f, 'utf8'));
  }
  return parts.join('\n\n').slice(0, 60000);
}

function buildScoring(interviewEval, job, ats, spentMinutes) {
  const rows = (interviewEval?.scoring || []).map((r, i) => ({
    n: i + 1,
    requirement: r.criterion || r.requirement || r.name,
    klass: r.klass || r.class || (r.weight >= 2 ? 'must' : 'nice'),
    weight: r.weight ?? 1,
    score: r.score === null || r.score === undefined ? 'n/a' : r.score,
    evidence: r.evidence || '',
    source: r.source || '',
  }));
  const notEvaluated = rows.filter(r => r.score === 'n/a').map(r => r.requirement);
  const scoredRows = rows.filter(r => r.score !== 'n/a');
  const percent = job?.percent ?? interviewEval?.percent ?? null;
  const score10 = job?.score10 ?? interviewEval?.score10 ?? null;
  const verdict = job?.verdict ?? interviewEval?.verdict ?? ats?.verdict ?? null;
  return {
    percent, score10, verdict,
    spent_minutes: spentMinutes ?? job?.spent_minutes ?? null,
    rows, not_evaluated: notEvaluated,
    veto: interviewEval?.veto || job?.veto || [],
    total_note: !rows.length && ats
      ? `ATS-оценка HH: ${ats.score}/10 — ${ats.verdict} (${(ats.reasoning || '').slice(0, 300)})`
      : null,
    ats_score: ats?.score ?? null,
  };
}

function buildLimitations({ sources, interviewEval, job, ats }) {
  const out = [];
  if (!sources.interview) out.push('Интервью не загружено — темы/коммуникация не оценивались.');
  if (!sources.resume) out.push('Резюме не загружено — опыт и навыки подтверждаются только письмом/перепиской.');
  if (!sources.correspondence) out.push('Переписка с рекрутером не загружена.');
  if (!interviewEval && sources.interview) out.push('Интервью загружено, но оценка по требованиям не запускалась.');
  if (!job) out.push('Сравнение с кандидатами вакансии не запускалось (нет результата «Запустить оценку»).');
  if (!ats && !interviewEval) out.push('Нет ни ATS-оценки, ни разбора интервью — документ будет неполным.');
  return out;
}

// ── MD: «Чистая оценка» ────────────────────────────────────────────────────────

const VERDICT_LABEL = { 'ПРОПУСТИТЬ': 'ПРОПУСТИТЬ', 'УТОЧНИТЬ': 'УТОЧНИТЬ', 'ОТКЛОНИТЬ': 'ОТКЛОНИТЬ' };

function escMd(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

function renderCleanEvalMd(d) {
  const L = [];
  L.push(`# Оценка кандидата — ${d.candidate.name}`);
  L.push('');
  L.push([d.vacancy.title ? `Вакансия: ${d.vacancy.title}` : null, d.generated_at, d.scoring.spent_minutes != null ? `оценка: ${d.scoring.spent_minutes} мин` : null].filter(Boolean).join(' · '));
  L.push('');
  L.push('## Итог');
  L.push('');
  L.push('| Показатель | Значение |');
  L.push('|---|---|');
  if (d.scoring.percent != null) L.push(`| Итоговый скор | **${d.scoring.percent}%${d.scoring.score10 != null ? ` · ${Number(d.scoring.score10).toFixed(1)} / 10` : ''}** |`);
  if (d.scoring.verdict) L.push(`| Вердикт | **${VERDICT_LABEL[d.scoring.verdict] || d.scoring.verdict}** |`);
  if (d.comparison) L.push(`| Ранг на вакансии | ${d.comparison.place} из ${d.comparison.total} (средний ${d.comparison.avg}%) |`);
  L.push(`| Veto (must-have ≤1) | ${d.scoring.veto.length ? d.scoring.veto.join(', ') : 'нет'} |`);
  const src = [
    d.sources.resume ? '✓ резюме' : '✗ резюме',
    d.sources.cover_letter ? (d.sources.correspondence ? '✓ переписка' : '✓ письмо') : '✗ письмо',
    d.sources.interview ? `✓ интервью${d.interview_minutes ? ` ${d.interview_minutes} мин` : ''}` : '✗ интервью',
  ];
  L.push(`| Источники | ${src.join(' · ')} |`);
  if (d.scoring.spent_minutes != null) L.push(`| Затрачено на оценку | ${d.scoring.spent_minutes} мин |`);
  L.push('');
  if (d.scoring.total_note) L.push(`> ${d.scoring.total_note}`, '');

  if (d.scoring.rows.length) {
    L.push('## Требования');
    L.push('');
    L.push('| # | Требование | Класс | Вес | 0–5 | Evidence (источник) |');
    L.push('|---|---|---|---|---|---|');
    for (const r of d.scoring.rows) {
      L.push(`| ${r.n} | ${escMd(r.requirement)} | ${r.klass === 'must' ? 'must-have' : 'nice-to-have'} | ${r.weight} | **${r.score}** | ${escMd(r.evidence)}${r.source ? ` *(${escMd(r.source)})*` : ''} |`);
    }
    L.push('');
    if (d.scoring.not_evaluated.length) L.push(`**Не оценивалось (n/a):** ${d.scoring.not_evaluated.map(escMd).join(' · ')}`, '');
  }

  L.push('## Полнота данных кандидата');
  L.push('');
  L.push('| Источник | Есть |');
  L.push('|---|---|');
  L.push(`| Резюме | ${d.sources.resume ? '✓' : '✗'} |`);
  L.push(`| Письмо / переписка | ${d.sources.cover_letter ? '✓' : '✗'} |`);
  L.push(`| Интервью | ${d.sources.interview ? '✓' : '✗'} |`);
  L.push('');

  if (d.interview_coverage) {
    L.push('## Покрытие интервью');
    L.push('');
    if (d.interview_coverage.covered?.length) {
      L.push('| Тема | Ключевая цитата |');
      L.push('|---|---|');
      for (const c of d.interview_coverage.covered) L.push(`| ${escMd(c.topic)} | ${escMd(c.quote)} |`);
      L.push('');
    }
    if (d.interview_coverage.missing?.length) {
      L.push(`**Не прозвучало:** ${d.interview_coverage.missing.map(escMd).join(' · ')}`, '');
    }
  }

  if (d.communication?.rows?.length || d.communication?.metrics) {
    L.push('## Коммуникация (параллельная ось, на итог не влияет)');
    L.push('');
    L.push('| Метрика | 0–5 | Цитата |');
    L.push('|---|---|---|');
    const rows = d.communication.rows || Object.entries(d.communication.metrics || {}).map(([metric, v]) => ({ metric, ...v }));
    for (const m of rows) L.push(`| ${escMd(m.metric || m.name)} | ${m.score ?? '—'} | ${escMd(m.quote || m.evidence || '')} |`);
    L.push('');
  }

  if (d.comparison) {
    L.push('## Сравнение с вакансией');
    L.push('');
    L.push(`Средний score по вакансии: **${d.comparison.avg}%** (мин ${d.comparison.min}%, макс ${d.comparison.max}%) — наш кандидат: ${d.comparison.percent ?? d.scoring.percent ?? '—'}% → **${d.comparison.place}-е место из ${d.comparison.total}**.`);
    L.push('');
  }

  L.push('## Ограничения');
  L.push('');
  for (const x of d.limitations) L.push(`- ${x}`);
  if (!d.limitations.length) L.push('- Ограничений нет.');
  L.push('');
  return L.join('\n');
}

// ── MD: «Полный профиль» ───────────────────────────────────────────────────────

const FIT_ICON = { yes: '✓', partial: '△', note: '⚠' };

function renderProfileMd(d) {
  const L = [];
  L.push(`# ${d.candidate.name}`);
  L.push('');
  L.push([
    d.profile?.position || d.vacancy.title || 'Кандидат',
    d.vacancy.title ? `— ${d.vacancy.title}` : null,
    `профиль кандидата · ${d.generated_at}`,
  ].filter(Boolean).join(' '));
  L.push('');

  if (d.profile?.summary) L.push('## Саммари', '', d.profile.summary, '');

  L.push('## Соответствие вакансии', '');
  L.push('| | Требование | Комментарий |');
  L.push('|---|---|---|');
  const fit = d.profile?.fit?.length ? d.profile.fit : defaultFit(d);
  for (const f of fit) L.push(`| ${FIT_ICON[f.status] || '·'} | ${escMd(f.requirement)} | ${escMd(f.comment)} |`);
  L.push('');

  const exp = d.profile?.experience || [];
  if (exp.length) {
    L.push('## Опыт работы', '');
    for (const e of exp) {
      L.push(`- **${escMd(e.period || '')} · ${escMd(e.company || '')}** — ${escMd(e.role || '')}`);
      for (const det of e.details || []) L.push(`  - ${escMd(det)}`);
      if (e.from_interview) L.push(`  - *Из интервью: ${escMd(e.from_interview)}*`);
    }
    L.push('');
  }

  const params = profileParams(d);
  if (params.length) {
    L.push('## Ключевые параметры', '');
    L.push('| | |');
    L.push('|---|---|');
    for (const [k, v] of params) L.push(`| ${escMd(k)} | ${escMd(v)} |`);
    L.push('');
  }

  const nuances = d.profile?.nuances || defaultNuances(d);
  if (nuances.length) {
    L.push('## Нюансы и риски', '');
    for (const n of nuances) L.push(`- ${n}`);
    L.push('');
  }

  L.push('## Вывод рекрутера', '');
  L.push(d.profile?.conclusion || '_(текст вывода добавляет рекрутер — формулировки его, от первого лица)_', '');

  if (d.resume_raw) {
    L.push('## Приложение: резюме кандидата (полностью)', '');
    L.push('```');
    L.push(d.resume_raw);
    L.push('```');
    L.push('');
  }
  return L.join('\n');
}

function defaultFit(d) {
  // Минимальная сетка из источников, когда LLM-профиль не извлечён
  const fit = [];
  if (d.sources.resume) fit.push({ status: 'yes', requirement: 'Резюме загружено', comment: 'опыт и навыки подтверждаются документом' });
  if (d.ats_gaps?.matched?.length) fit.push({ status: 'yes', requirement: 'Подтверждено ATS', comment: d.ats_gaps.matched.slice(0, 3).join('; ') });
  if (d.ats_gaps?.gaps?.length) fit.push({ status: 'partial', requirement: 'Пробелы по ATS', comment: d.ats_gaps.gaps.slice(0, 3).join('; ') });
  if (!fit.length) fit.push({ status: 'note', requirement: 'Данных мало', comment: 'загрузи материалы и запусти оценку' });
  return fit;
}

function profileParams(d) {
  const p = d.profile || {};
  const out = [];
  if (p.education?.length) out.push(['Образование', p.education.join('; ')]);
  if (p.languages?.length) out.push(['Языки', p.languages.join('; ')]);
  if (p.location) out.push(['Локация / формат', p.location]);
  if (p.salary_expectations) out.push(['Ожидания по деньгам', p.salary_expectations]);
  return out;
}

function defaultNuances(d) {
  const out = [];
  if (d.ats_gaps?.gaps?.length) out.push(...d.ats_gaps.gaps.map(g => `Пробел по ATS: ${g}`));
  if (!d.sources.interview) out.push('Интервью не проводилось (или не загружено) — манера общения и глубина ответов не проверялись.');
  return out;
}

// ── MD → HTML (для PDF/просмотра): заголовки, списки, таблицы, жирный, код ─────

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inlineMd(s) {
  return escHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function mdToHtml(md) {
  const lines = String(md).split('\n');
  const out = [];
  let i = 0;
  let list = null; // 'ul' | 'ol'
  let table = null; // {rows:[]}
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeTable = () => {
    if (!table) return;
    out.push('<table>' + table.rows.map((r, ri) => `<tr>${r.map(c => (ri === 0 ? `<th>${inlineMd(c)}</th>` : `<td>${inlineMd(c)}</td>`)).join('')}</tr>`).join('') + '</table>');
    table = null;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) { // code block до следующей ```
      closeList(); closeTable();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push(`<pre>${escHtml(buf.join('\n'))}</pre>`);
      continue;
    }
    const t = line.match(/^\|\s*(.+)\s*\|$/);
    if (t) {
      closeList();
      const cells = t[1].split(/(?<!\\)\|/).map(c => c.replace(/\\\|/g, '|').trim());
      if (/^[-:\s|]+$/.test(t[1])) { i++; continue; } // разделитель шапки
      table = table || { rows: [] };
      table.rows.push(cells);
      i++; continue;
    }
    closeTable();
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^>\s?/.test(line)) { closeList(); out.push(`<blockquote>${inlineMd(line.replace(/^>\s?/, ''))}</blockquote>`); i++; continue; }
    if (/^---+$/.test(line.trim())) { closeList(); out.push('<hr>'); i++; continue; }
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    const oli = line.match(/^\s*\d+\.\s+(.*)$/);
    if (li || oli) {
      const want = li ? 'ul' : 'ol';
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${inlineMd((li || oli)[1])}</li>`);
      i++; continue;
    }
    closeList();
    if (line.trim()) out.push(`<p>${inlineMd(line)}</p>`);
    i++;
  }
  closeList(); closeTable();
  return out.join('\n');
}

const PRINT_CSS = `@page{size:A4;margin:14mm 12mm}
*{box-sizing:border-box}
body{font-family:Georgia,'Times New Roman',serif;color:#1a1a1a;font-size:11pt;line-height:1.45;max-width:820px;margin:0 auto;padding:8px 12px}
h1{font-size:20pt;margin:0 0 4px}h2{font-size:13pt;margin:18px 0 6px;border-bottom:1px solid #bbb;padding-bottom:3px}
h3{font-size:11.5pt;margin:14px 0 4px}
table{width:100%;border-collapse:collapse;margin:6px 0;font-size:9.5pt}
th,td{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top}
th{background:#f0f0f0}
pre{background:#f6f6f6;border:1px solid #ddd;padding:8px;font-size:9pt;white-space:pre-wrap}
blockquote{margin:6px 0;padding:4px 10px;border-left:3px solid #999;color:#333}
img.photo{max-width:120px;float:right;border-radius:6px}
@media print{body{padding:0}.no-print{display:none}}`;

function wrapHtml(title, inner, { photoDataUri = null } = {}) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${escHtml(title)}</title><style>${PRINT_CSS}</style></head><body>
${photoDataUri ? `<img class="photo" src="${photoDataUri}" alt="">` : ''}
${inner}
</body></html>`;
}

function photoDataUri(username, candidateId) {
  try {
    const manifest = readManifest(username, candidateId);
    if (!manifest?.photo?.file) return null;
    const f = path.join(dataRoot(), 'hh', username, 'candidate-docs', candidateId, manifest.photo.file);
    const buf = fs.readFileSync(f);
    return `data:${manifest.photo.mime || 'image/jpeg'};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

module.exports = {
  buildReportData, renderCleanEvalMd, renderProfileMd, mdToHtml, wrapHtml, PRINT_CSS, photoDataUri,
};
