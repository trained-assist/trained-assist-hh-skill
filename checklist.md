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

# Checklist — правило «что уточняем» в воронке (funnel-v2)

Goal: уточнять в переписке только мастхевы (required), которых нет в данных кандидата;
вердикт «ПРОПУСТИТЬ» ⇒ вопросов нет вообще → propose_test → send_test → invite_call.
Дыра на проде: vacancy 138004863, negotiation 5620089198 — 9.5/ПРОПУСТИТЬ,
gaps не из обязательных, черновик спросил три вопроса + имя + время («спрашиваем
просто так, у кандидата всё есть, а мы его гоняем» — владелец, 02.10.2026).

- [x] src/hh-funnel.js: правила планировщика + deterministicStep (first contact по вердикту) + гард ask_skills при ПРОПУСТИТЬ + списки must-have/preferred в сообщении планировщика + верный порог прохода
- [x] src/hh-draft-message.js: действие воронки приоритетно над наборами правил стиля
- [x] FUNNEL_LOGIC_VERSION → funnel-v2 (кэш черновиков инвалидируется)
- [x] Тесты: unit 712/712, contract 17/17, guards, behavior; mcp.manifest перегенерирован
- [ ] CI green
- [ ] Merged
- [ ] Deployed (sibling checkout на VM + рестарт assist-agent)
