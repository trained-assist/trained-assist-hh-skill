# Skill CI — 2026-09-24

Основание: осмотр HH CI (b9467be), MCP registry/index, core ActionProviderRegistry
(74896cc4aced8e29446134ccb8b0010e58cca49b), Hermes research по MCP/Nock/GitHub/HH.

- [x] Изолировать HOME/токены/данные всего обязательного CI; запретить внешний HTTP, проверить запрет для fetch и http.
- [x] Переносимый MCP stdio harness: initialize, discovery с/без подключения, tool call, ошибки, manifest/schema parity.
- [x] Проверить manifest реальным core registry по закреплённому контракту + отрицательные контракты.
- [x] Staging: MCP → mock HH/LLM → durable snapshot → сгенерированная HTML → Chromium, фильтры, ошибки и повторное открытие.
- [x] Общий reusable workflow, обязательные ci/staging-gate на актуальном SHA, диагностика браузерных падений.
- [x] Отдельный read-only live smoke, явная ошибка при отсутствии секрета; без личных токенов в PR CI.
- [x] Полный локальный прогон и PR #15; ci/staging-gate зелёные на 7f83414, ограничения описаны в docs/skill-ci.md. Финальный SHA повторно проверяется перед мержем.

Источники: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
https://github.com/nock/nock#enabledisable-real-http-requests
https://docs.github.com/en/actions/sharing-automations/reusing-workflows
https://api.hh.ru/openapi/specification/public

Результат: 302 Vitest + 2 legacy Node + 5 contract + 1 Chromium journey.
main protected: strict required checks ci/staging-gate, enforce_admins=true (GitHub API подтверждено 2026-09-24).
Личный HH token не использован. Живой smoke подготовлен, но не запускался.
Найден и исправлен stdout лог AI enrichment, нарушавший MCP JSON-RPC.
