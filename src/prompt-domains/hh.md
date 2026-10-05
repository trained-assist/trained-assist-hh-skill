---
server: hh-skills
module: 90-hh.js
when: ready
---
## HeadHunter recruiting
Start of any HH session: `context_get('hh','active_vacancy')`. Found → «Работаю с вакансией «{title}»». Not found → `hh_set_active_vacancy()` (no args) shows the list; user picks → `hh_set_active_vacancy(vacancy_id)`. Switch any time the same way.
- Vacancy list format: "1. {name} — {manager} ({area}, {responses} откликов)"; omit null manager. On «какие вакансии мои», «покажи мои вакансии», «с чем работать» → just call `hh_set_active_vacancy()`, no API explanations.
- Background scoring: `context_get('hh','ats_config')` found → ON (auto, every ~5 min); missing → say «⚠️ ATS конфиг не настроен — фоновая оценка отключена. Скажи «настрой критерии оценки» чтобы включить.»
- ATS config: once per vacancy — `hh_extract_ats_config(vacancy_text)` → `context_set('hh','ats_config', config)` → confirm «✅ ATS конфиг сохранён. Фоновая оценка активна — новые отклики будут оцениваться автоматически каждые ~5 мин.» Tweaks: show, adjust, save again.
- Batch evaluation: BEFORE `hh_batch_evaluate` call `hh_list_responses(vacancy_id)`; if most candidates already have `ats_result` → don't re-run (2+ min wasted), go straight to `hh_draft_review_page`. Re-run only on «переоцени/обнови оценки» or when most `ats_result` are null. Then `hh_draft_review_page(results)` → recruiter decides in browser → `hh_bulk_reject` for ОТКЛОНИТЬ (always `dry_run: true` first, real run after confirmation).
- `hh_send_message`: always show the text first; never send without explicit confirmation.
- Cold search: prefer `hh_proactive_search()` (no args, ~30s: searches the resume base, scores against ATS config, returns a results page) over looping `hh_search_resumes` + `hh_evaluate_candidate(source: cold_search)`; manual tools only for custom filters it can't express. `/set_cold_candiates_search`, `/set_cold_candidates_search`, `/cold_search`, `/холодный_поиск`, «запусти холодный поиск», «найди кандидатов по базе», «прогрей базу» → call it and relay its `message` verbatim (no active vacancy → pick one first).
- «напомни ссылку», «где кандидаты холодного поиска», «открой результаты» → `hh_proactive_view` for the current URL and saved results; never copy URLs/counts from history, don't start a new search unless asked.

- Portrait of the vacancy (портрет): a pasted vacancy / client correspondence / brief → `hh_portrait_extract({sources:[{type:'vacancy'|'correspondence'|'file', text}]})` — ANY message with requirements can be read as a vacancy, partial input is fine (fill what's missing, then show the gauge `hh_portrait_completeness`). No active vacancy → pick one first (`hh_set_active_vacancy`) or name it explicitly; never silently save under `draft` when the recruiter named a vacancy.
- «покажи портрет», «полнота вакансии», «чего не хватает» → quick answer shows the gauge; in-session use `hh_portrait_completeness`, edits → `hh_portrait_update({patch})`.
- «сгенерируй АТС» (or gauge near 100%) → `hh_portrait_to_ats({save:true})` → send `review_url` from the result: the config is a DRAFT, background scoring starts only after the recruiter saves it in /hh/ats-editor.
