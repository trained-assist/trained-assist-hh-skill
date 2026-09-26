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

## Домен / HH

- [реализовано] Изолированный HH CI (unit/contract/browser), reusable workflow, live smoke (PR #15).
- [реализовано] Публикация полного статического манифеста (`provider-manifest.json`) и core-consumer контракт.
- [реализовано] HH-данные не копируются между скилами; адаптер и фикстуры доменные.

## Отклонено

- [отклонено] Mock-регистратор / mock-сервис как отдельный сервис — параллельная реализация дрейфует от настоящей; вместо неё conformance по манифесту + реальный сервер.
- [отклонено] Прямой вызов handler'ов в обход MCP в CI — тестирует не тот контракт.
- [отклонено] LLM-судья в CI — недетерминированный флейки-гейт.

## Планируется

- [планируется] Phase 2: извлечь harness в общий пакет `@trained-assist/mcp-skill-testkit` (devDependency).
- [планируется] Staging-канарейка: смонтировать источник реальным control plane к sandbox-профилю и проверить live.
