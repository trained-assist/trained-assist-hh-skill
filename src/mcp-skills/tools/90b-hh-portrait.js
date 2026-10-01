'use strict';
// hh_portrait_* — сборка и чтение портрета кандидата (эпик #83).
// Один и тот же набор вызывается и веб-страницами (/hh/vacancy/new, #85),
// и агентом/ботом (#86): веб дёргает те же tools/call, что и диалог.

const path = require('path');
const { ladderToken } = require('../../hh-llm');
const { checkCriteria } = require('../../hh-criteria-guard');
const { applyCriteriaGuard } = require('../../hh-criteria-apply');
const {
  normalizePortrait,
  computeCompleteness,
  extractPortrait,
  buildAtsFromPortrait,
  readPortrait,
  writePortrait,
} = require('../../hh-portrait');

const USER_ID = process.env.USER_ID || '';

// ── Context helpers (локальная копия паттерна 90-hh.js — модуль не тянет 90-hh) ──

function contextPath(key) {
  return path.join(process.cwd(), 'contexts', 'hh', `${key}.json`);
}

function readContextValue(key) {
  try {
    const data = JSON.parse(require('fs').readFileSync(contextPath(key), 'utf8'));
    return data?.value ?? null;
  } catch {
    return null;
  }
}

function resolveVacancyId(vacancyId) {
  if (vacancyId && String(vacancyId).trim()) return String(vacancyId).trim();
  const active = readContextValue('active_vacancy');
  return active?.id || 'draft';
}

function normalizeSources(sources, vacancyText) {
  const list = [];
  if (Array.isArray(sources)) {
    for (const s of sources) {
      if (!s) continue;
      if (typeof s === 'string') { if (s.trim()) list.push({ type: 'text', text: s.trim() }); continue; }
      const text = typeof s.text === 'string' ? s.text.trim() : '';
      if (text) list.push({ type: typeof s.type === 'string' && s.type ? s.type : 'text', text });
    }
  }
  if (typeof vacancyText === 'string' && vacancyText.trim()) {
    list.push({ type: 'vacancy', text: vacancyText.trim() });
  }
  return list;
}

function completenessOf(portrait, vacancyId) {
  return { vacancy_id: vacancyId, ...computeCompleteness(portrait) };
}

function mergePatch(portrait, patch) {
  const out = JSON.parse(JSON.stringify(portrait));
  for (const block of ['company', 'vacancy', 'requirements']) {
    const part = patch?.[block];
    if (!part || typeof part !== 'object') continue;
    for (const [key, value] of Object.entries(part)) {
      if (!(key in (out[block] || {}))) continue; // только поля схемы
      out[block][key] = value;
    }
  }
  return out;
}

function editorUrlFor(vacancyId) {
  const agentBase = (process.env.AGENT_PUBLIC_URL || 'http://localhost:3001').replace(/\/$/, '');
  const agentSecret = process.env.AGENT_SECRET || '';
  const token = agentSecret
    ? require('crypto').createHmac('sha256', agentSecret).update(USER_ID).digest('hex').slice(0, 16)
    : '';
  const q = new URLSearchParams({ username: USER_ID, token });
  if (vacancyId && vacancyId !== 'draft') q.set('vacancy_id', vacancyId);
  return `${agentBase}/hh/ats-editor?${q.toString()}`;
}

// ── Tools ─────────────────────────────────────────────────────────────────────

module.exports = {
  tools: {
    hh_portrait_extract: {
      description: 'Build the candidate portrait (structured vacancy requirements) from raw input — vacancy text, client correspondence, brief excerpts. Returns the portrait plus a completeness gauge (per-section percent and what is missing). Use for any message that describes a vacancy or client requirements.',
      inputSchema: {
        type: 'object',
        properties: {
          vacancy_id: { type: 'string', description: 'Vacancy the portrait belongs to. Defaults to the active vacancy.' },
          sources: {
            type: 'array',
            description: 'Input materials in order. Each item: {type: vacancy|correspondence|file|message, text}.',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['vacancy', 'correspondence', 'file', 'message', 'text'] },
                text: { type: 'string' },
              },
              required: ['text'],
            },
          },
          vacancy_text: { type: 'string', description: 'Shortcut: a single source passed as plain text.' },
          force: { type: 'boolean', description: 'Rebuild even if a portrait already exists (default: return the existing one).' },
        },
      },
      handler: async ({ vacancy_id, sources, vacancy_text, force } = {}) => {
        const vid = resolveVacancyId(vacancy_id);
        const existing = readPortrait(process.cwd(), vid);
        const srcs = normalizeSources(sources, vacancy_text);

        if (existing && !force) {
          return {
            ok: true, cached: true, vacancy_id: vid, portrait: existing,
            completeness: completenessOf(existing, vid),
            note: 'Портрет уже есть. Передай force=true, чтобы пересобрать из новых материалов.',
          };
        }
        if (!srcs.length) {
          return { error: 'Нет входных материалов: передай sources[] (или vacancy_text) — текст вакансии, переписку с клиентом, фрагмент брифа.' };
        }

        if (!ladderToken()) return { error: 'llm-ladder token не найден.' };

        try {
          const raw = await extractPortrait(srcs);
          const portrait = writePortrait(process.cwd(), vid, normalizePortrait(raw, {
            sources: srcs.map(s => s.type),
            vacancy_id: vid,
            created_at: existing?.meta?.created_at || null,
          }));
          const completeness = computeCompleteness(portrait);
          return {
            ok: true, vacancy_id: vid, portrait, completeness,
            missing: completeness.missing_flat,
            note: completeness.missing_flat.length
              ? `Портрет собран на ${completeness.percent}%. Чего не хватает:\n${completeness.missing_flat.map(x => '— ' + x).join('\n')}`
              : 'Портрет собран на 100%.',
          };
        } catch (e) {
          return { error: `Не удалось собрать портрет: ${e.message}` };
        }
      },
    },

    hh_portrait_get: {
      description: 'Read the stored candidate portrait for a vacancy with its completeness gauge. Use when recruiter asks what is already collected about the vacancy requirements.',
      inputSchema: {
        type: 'object',
        properties: {
          vacancy_id: { type: 'string', description: 'Defaults to the active vacancy.' },
        },
      },
      handler: async ({ vacancy_id } = {}) => {
        const vid = resolveVacancyId(vacancy_id);
        const portrait = readPortrait(process.cwd(), vid);
        if (!portrait) return { error: `Портрет для вакансии «${vid}» не найден. Собери его через hh_portrait_extract.` };
        return { ok: true, vacancy_id: vid, portrait, completeness: completenessOf(portrait, vid) };
      },
    },

    hh_portrait_update: {
      description: 'Patch specific fields of the stored candidate portrait (company/vacancy/requirements blocks). Only fields present in the patch are changed; unknown fields are ignored. Recomputes completeness.',
      inputSchema: {
        type: 'object',
        properties: {
          vacancy_id: { type: 'string', description: 'Defaults to the active vacancy.' },
          patch: {
            type: 'object',
            description: 'Partial portrait: {company?: {...}, vacancy?: {...}, requirements?: {...}}. Arrays replace the stored list; null clears a scalar.',
            properties: {
              company: { type: 'object' },
              vacancy: { type: 'object' },
              requirements: { type: 'object' },
            },
          },
        },
        required: ['patch'],
      },
      handler: async ({ vacancy_id, patch } = {}) => {
        const vid = resolveVacancyId(vacancy_id);
        const existing = readPortrait(process.cwd(), vid);
        if (!existing) return { error: `Портрет для вакансии «${vid}» не найден. Сначала hh_portrait_extract.` };
        if (!patch || typeof patch !== 'object') return { error: 'patch обязателен: {company?, vacancy?, requirements?}.' };
        const portrait = writePortrait(process.cwd(), vid, mergePatch(existing, patch));
        return { ok: true, vacancy_id: vid, portrait, completeness: completenessOf(portrait, vid) };
      },
    },

    hh_portrait_completeness: {
      description: 'Completeness gauge of the candidate portrait only: per-section percent (donut) plus flat list of what is missing. Cheap — no LLM.',
      inputSchema: {
        type: 'object',
        properties: {
          vacancy_id: { type: 'string', description: 'Defaults to the active vacancy.' },
        },
      },
      handler: async ({ vacancy_id } = {}) => {
        const vid = resolveVacancyId(vacancy_id);
        const portrait = readPortrait(process.cwd(), vid);
        if (!portrait) return { error: `Портрет для вакансии «${vid}» не найден. Собери его через hh_portrait_extract.` };
        return { ok: true, ...completenessOf(portrait, vid) };
      },
    },

    hh_portrait_to_ats: {
      description: 'Derive the ATS evaluation config from the candidate portrait: required (must-have, weight 2) from hard skills, preferred (nice-to-have, weight 1) from soft skills, experience/location/salary filters, thresholds. save=true stores it for review in /hh/ats-editor (draft by default — live scoring starts only after a human saves it there, per issue #74).',
      inputSchema: {
        type: 'object',
        properties: {
          vacancy_id: { type: 'string', description: 'Defaults to the active vacancy.' },
          save: {
            type: 'boolean',
            description: 'Persist the config for the ATS editor (default true).',
          },
          mode: {
            type: 'string',
            enum: ['draft', 'live'],
            description: 'draft (default) → ats_config_draft:{id}, reviewed in /hh/ats-editor; live → ats_config:{id}, background scoring picks it up immediately.',
          },
        },
      },
      handler: async ({ vacancy_id, save = true, mode = 'draft' } = {}) => {
        const vid = resolveVacancyId(vacancy_id);
        const portrait = readPortrait(process.cwd(), vid);
        if (!portrait) return { error: `Портрет для вакансии «${vid}» не найден. Сначала hh_portrait_extract.` };

        let config = buildAtsFromPortrait(portrait, vid);
        if (!config.required.length && !config.preferred.length) {
          return { error: 'В портрете нет ни hard skills, ни soft skills — не из чего строить критерии. Заполни «Ключевые навыки/знания» в портретe (hh_portrait_update).' };
        }

        // Гард измеримости (#74/#75): требования из портрета записаны словами клиента и
        // могут быть общими («аналитический склад ума»). Как и в hh_extract_ats_config,
        // невычислимые критерии заменяются на проверяемую формулировку, а не удаляются.
        let replaced = [];
        let dropped = [];
        let guard_note = null;
        if (save !== false && ladderToken()) {
          try {
            const guard = await checkCriteria(config, { username: USER_ID, apiKey: ladderToken() });
            if (guard.violations.length) {
              const applied = applyCriteriaGuard(config, guard.violations);
              config = applied.config;
              replaced = applied.replaced || [];
              dropped = (applied.dropped || []).map(d => (d && d.name) || d);
              if (!config.required.length && !config.preferred.length) {
                return { error: 'Критерии из портрета оказались общими формулировками и не прошли гард измеримости — уточни «Ключевые навыки/знания» в портрете (hh_portrait_update) и повтори.', rejected: dropped };
              }
            }
          } catch (e) {
            guard_note = `Гард измеримости не отработал (${e.message}) — критерии сохранены как есть.`;
          }
        }

        let stored = false;
        if (save !== false) {
          const key = mode === 'live'
            ? (vid === 'draft' ? 'ats_config' : `ats_config:${vid}`)
            : (vid === 'draft' ? 'ats_config_draft' : `ats_config_draft:${vid}`);
          const fs = require('fs');
          const file = contextPath(key);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify({ value: config, updated_at: new Date().toISOString() }, null, 2));
          stored = true;
        }

        const reviewUrl = editorUrlFor(vid);
        return {
          ok: true, vacancy_id: vid, stored, mode: save === false ? null : mode, config,
          replaced_criteria: replaced, dropped_criteria: dropped, guard_note: guard_note || undefined,
          review_url: reviewUrl,
          note: save === false
            ? 'Конфиг посчитан (не сохранён).'
            : mode === 'live'
              ? `Конфиг сохранён как боевой: фоновый скоринг начнёт использовать его сразу. Редактор: ${reviewUrl}`
              : `Конфиг сохранён черновиком — фоновый скоринг заработает после сохранения в редакторе: ${reviewUrl}`,
        };
      },
    },
  },
};
