'use strict';

// Applies the criteria guard's output to a config that a human has NOT reviewed yet
// (the hh_extract_ats_config draft).
//
// First version dropped every flagged criterion and threw the LLM's replacement
// away. Live check 01.10.2026 on vacancy 138004863 with the production key: the
// guard flagged «настройка и оптимизация внутренней рекламы» and proposed
// «Настройка внутренней рекламы WB: ставки, ДРР, поисковая выдача» — dropping it
// would have deleted a real requirement from the rubric the recruiter was about to
// review, silently. Replacing keeps the intent and makes it measurable.
//
// Rule: a flagged criterion with a usable replacement becomes its replacement; one
// without (regex hits, or an LLM refusal to suggest) is dropped — a vague criterion
// scores every candidate the same and only adds noise.

function criteriaList(config, field) {
  const list = Array.isArray(config?.[field]) ? config[field] : [];
  return list
    .map(item => {
      if (typeof item === 'string') return { name: item, weight: 1.0 };
      if (item && typeof item === 'object' && item.name) return { ...item };
      return null;
    })
    .filter(Boolean);
}

function applyCriteriaGuard(config, violations = []) {
  if (!violations?.length) return { config, replaced: [], dropped: [] };

  const byName = new Map();
  for (const v of violations) {
    byName.set(`${v.field}:${String(v.name).trim().toLowerCase()}`, v);
  }

  const replaced = [];
  const dropped = [];
  const next = { ...config };

  for (const field of ['required', 'preferred']) {
    const out = [];
    for (const c of criteriaList(config, field)) {
      const hit = byName.get(`${field}:${c.name.trim().toLowerCase()}`);
      if (!hit) { out.push(c); continue; }
      const suggestion = typeof hit.suggestion === 'string' ? hit.suggestion.trim() : '';
      if (suggestion) {
        out.push({ ...c, name: suggestion });
        replaced.push({ field, from: c.name, to: suggestion });
      } else {
        dropped.push({ field, name: c.name });
      }
    }
    next[field] = out;
  }

  return { config: next, replaced, dropped };
}

module.exports = { applyCriteriaGuard };
