# Skill CI — 2026-09-24

Основание: осмотр HH CI (b9467be), MCP registry/index, core ActionProviderRegistry
(74896cc4aced8e29446134ccb8b0010e58cca49b), Hermes research по MCP/Nock/GitHub/HH.

- [x] Изолировать HOME/токены/данные всего обязательного CI; запретить внешний HTTP, проверить запрет для fetch и http.
- [x] Переносимый MCP stdio harness: initialize, discovery с/без подключения, tool call, ошибки, manifest/schema parity.
- [x] Проверить manifest реальным core registry по закреплённому контракту + отрицательные контракты.
- [x] Staging: MCP → mock HH/LLM → durable snapshot → сгенерированная HTML → Chromium, фильтры, ошибки и повторное открытие.
- [x] Общий reusable workflow, обязательные ci/staging-gate на актуальном SHA, диагностика браузерных падений.
- [x] Отдельный read-only live smoke, явная ошибка при отсутствии секрета; без личных токенов в PR CI.
- [ ] Полный локальный прогон, PR, зелёные удалённые CI/staging; отчёт и ограничения.

Источники: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
https://github.com/nock/nock#enabledisable-real-http-requests
https://docs.github.com/en/actions/sharing-automations/reusing-workflows
https://api.hh.ru/openapi/specification/public
