# Checklist — Recruiting hub v1 (trained-assist-agent#1742)

Goal: рекрутер работает в вебе — общий нав-бар по всем `/hh/*`, экран «Вакансии»,
кнопка «▶ Собрать» программно запускает плейбук `recruiting-vacancy-launch`
(durable-план без engine-сессии), статус плана на `/hh/plan`.
UX-спека: `docs/specs/recruiting-web-hub-and-playbook-launch-ux.md` (trained-assist-agent, ветка `feature/recruiting-web-hub-1733`).

- [x] Нав-бар (Вакансии · Кандидаты · Холодный поиск · ATS воронка · Стиль · Синхронизация) — инъекция в ответ после `<body>`, генераторы страниц не тронуты (`src/hh-nav.js`)
- [x] `/hh/proactive` и все существующие URL/query — без изменений (кроме блока нав-бара)
- [x] `GET /hh/vacancies` — `active_vacancies.json` + `vacancy_draft.json`, отклики из кэша, действия
- [x] `POST /hh/playbook-run` — HMAC, `playbook_run` (activate + approve_hooks), Telegram best-effort
- [x] `GET /hh/plan` — `task_get`, шаги, поллинг 4с → 20с после 60с, стоп на done/failed/cancelled
- [x] `playbooks/recruiting-vacancy-launch.json` — schema OK + `compilePlaybook` OK + `playbook_run`→`task_get` (plan active) на core origin/main
- [x] Unit-тесты `tests/unit/hh-hub.test.js`; `mcp.manifest.json` перегенерирован
- [ ] CI green
- [ ] Merged
- [ ] Core: nginx whitelist `vacancies|plan|playbook-run|ats-editor|style|sync-log` (спека §7) — отдельный PR в trained-assist-agent
- [ ] Deployed — `curl https://recruiter-assistant.ru/hh/{vacancies,plan,ats-editor}` ≠ 401
