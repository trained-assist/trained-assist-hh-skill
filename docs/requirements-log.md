# Requirements Log — trained-assist-hh-skill

Живой список требований/фич и их статус. Обновляется при формулировке требования
или изменении статуса. Единый источник правды между сессиями.

Статусы: `реализовано`, `отклонено (почему)`, `планируется`, `в работе`.

## Тест и CI (доменный skill-репо)

- [реализовано] **L1 contract** — `mcp.manifest.json` против `contracts/mcp-skill-sources.schema.json`, `revision` 40-hex, `artifactDigest` sha256 с пересчётом, паритет имён с `tools/list` реального сервера, отсутствие коллизий с core. `tests/contract/mcp-manifest.test.cjs`, `scripts/mcp-artifact.js`, `scripts/build-mcp-manifest.cjs`.
- [реализовано] **L2 behavior** — каждый тул манифеста имеет фикстуру (`fixtures/tools.json`), реальный MCP subprocess по stdio, HH — loopback-мок, LLM — записанная фикстура, ошибка не роняет процесс. `tests/behavior/tools.test.cjs`, `tests/behavior/fake-provider.test.cjs`.
- [реализовано] **L3 guards** — quick-action-тулы не спавнят Claude/`runner.js`, таймауты у исходящего HTTP, кред-файлы `mode 0o600`, секреты не логируются, пути профиля через резолвер. `tests/guards/guards.test.cjs`.
- [реализовано] **Мокать ровно 2 рубежа** — LLM (`tests/support/llm-provider-fixture.cjs`, `llm-fixture.cjs`) и внешняя сеть (`tests/helpers/mock-hh-server.js`, `hh-fixture.cjs`); registry/service — никогда. Guard «harness не мокает registry» в L3.
- [реализовано] **Replay-гейт Phase 1** — вендорены `scripts/staging/run.mjs` + `isolation-guard.cjs` + `suites.json`; `npm run test:staging` пишет `staging-results/manifest.json`.
- [реализовано] **Сценарии + план моков** — `docs/user-scenarios/recruiting/` (mandatory cold-search + exploratory ATS), replay в `scenarios/cold-search-replay/`.
- [реализовано] **CI = replay, LLM-судья = staging** — jobs `contract`/`behavior`/`guards`/`unit`/`browser`, агрегатор `ci` и `staging-gate` (последний — replay-гейт). LLM-судья в CI не допускается.
- [реализовано] **Резолвер путей профиля** — `src/data-paths.js`; все `os.homedir()` из `src/**` (кроме резолвера) вычищены.

- [реализовано] **Измеримость критериев ATS** — критерий обязан быть проверяемым по резюме/ответам (инструмент, метрика, цифра, объём); качества личности и «неумение X» запрещены. Правило исполняемо: `src/hh-criteria-guard.js` (regex + один дешёвый LLM-вызов), `src/hh-criteria-apply.js` (замена измеримой формулировкой, удаление — только если замены нет). Повод: конфиг вакансии 138004863 с «аналитическим складом ума» и «постановкой ТЗ подрядчикам» (01.10.2026).
- [реализовано] **Нокаут-критерии убраны из продукта** — из редактора и из промпта извлечения; остались `required` + `preferred` + `filters`. В скоринге поддержка легаси сохранена: молча удалять записанные у пользователей `knockout` означало бы изменить их оценки без спроса.
- [реализовано] **Поле «Тестовое задание»** — `test_task` в конфиге вакансии, textarea в редакторе; текст уходит кандидату дословно, собирается кодом.
- [реализовано] **Стейт-машина переписки** — `src/hh-funnel.js`: шаг «что делать» (закрытый набор действий, `wait` включён) отдельно от шага «как написать»; детерминированные правила до LLM; действие видно рекрутеру на странице отбора. Закрывает #71: версия логики входит в подпись черновика, иначе сломанный промпт жил в кэше вечно.
- [реализовано] **per-vacancy конфиг в `/hh/generate-message`** — маршрут читал только устаревший общий файл; на мульти-вакансном профиле кнопка «Сгенерировать» брала чужую доступность на звонок и не видела тестовое задание.
- [реализовано] **Петля отклика: тишина — это решение, а не сбой (#191)** — действие `wait`/`reject` не порождает письма ни на странице отбора, ни в `hh_generate_message_to_applicant` (второе письмо в пустоту, живой дефект #66/#70); решение пишется в `ats_result.draft_skip_sig` с той же подписью треда, что и фоновый цикл, поэтому следующий виток не перепланивает и не платит за planner. Деградировавший планировщик (LLM не ответил) — это «не знаю», а не «молчать»: ручной путь письмо всё равно пишет.
- [реализовано] **Письмо агента не теряется (#191)** — `hh_generate_message_to_applicant` сохраняет черновик (`message_draft` + `ats_result.draft_message` + `draft_history_sig`), поэтому страница отбора показывает написанное агентом, а не пустое поле; отправленное письмо переводит отклик из состояния «response» в «consider» (как уже делал маршрут страницы).

## Домен / HH

- [реализовано] Изолированный HH CI (unit/contract/browser), reusable workflow, live smoke (PR #15).
- [реализовано] Публикация полного статического манифеста (`provider-manifest.json`) и core-consumer контракт.
- [реализовано] HH-данные не копируются между скилами; адаптер и фикстуры доменные.

## Отклонено

- [отклонено] Mock-регистратор / mock-сервис как отдельный сервис — параллельная реализация дрейфует от настоящей; вместо неё conformance по манифесту + реальный сервер.
- [отклонено] Прямой вызов handler'ов в обход MCP в CI — тестирует не тот контракт.
- [отклонено] LLM-судья в CI — недетерминированный флейки-гейт.

## Планируется

- [планируется] **Поставка #191 в прод (ревизия `b1bbe5b`, merge PR #192)** — ревизия собрана на RU VM как неизменяемый релиз `/home/vova/hh-releases/b1bbe5bb549cadda64bddf19a04db1f3c5a532fa` (гейты `check-hh-route-ownership` / `check-mcp-conformance` / `check-skill-schedule` — PASS, запись `hh-deploy-records/*.staged.json`), но живое переключение **не выполнено**: публичные `/hh/*` и `/agent/hh/*` на RU nginx проксируются на старую GCP VM (`136.65.7.197`), которая сейчас недоступна (nginx `upstream timed out` до 20.10, TCP-timeout из двух независимых сетей), а отдельный HH-воркер на RU VM не развёрнут (#187). Проверка живой выдачи невозможна до появления живого хоста — переключение выполняется тем же `scripts/deploy-hh-pinned.sh`, но на хосте, который реально обслуживает HH.
- [планируется] Phase 2: извлечь harness в общий пакет `@trained-assist/mcp-skill-testkit` (devDependency).
- [планируется] Staging-канарейка в core (`trained-assist-agent`): смонтировать источник реальным control plane к sandbox-профилю на закреплённом SHA и проверить live (нужен sandbox-профиль с подключённым HH).
- [реализовано] Локальный mount-canary (2026-09-26, core `prepare` → `activate` → `McpSkillSourceRegistry` → реальный MCP-процесс из смонтированного read-only артефакта, `tools/list`=37, вызов `hh_connect`): подтвердил, что источник реально монтируется. Вскрыл, что core v1 отклоняет `provider-manifest.json` из-за MCP-`description` → `mcp.manifest.json` переведён на строгий `action-provider-manifest.json`; L1-тест теперь прогоняет `approvedManifest` через реальный core-registry.
