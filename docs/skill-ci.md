# Исполняемый контракт CI для HH-скила

Правила: `trained-assist-agent/docs/domain-skill-repo-test-rules.md`. PR запускает
три герметичных слоя (contract / behavior / guards), детерминированный replay-гейт
и отдельный браузерный journey — без секретов, платных API и реальных кандидатов.

| Слой | Что проверяет | Команда |
|---|---|---|
| Contract (L1) | `mcp.manifest.json` против `contracts/mcp-skill-sources.schema.json`: `revision` — 40-hex коммит, `artifactDigest` sha256 и пересчитывается, паритет имён с `tools/list` реального сервера, отсутствие коллизий с core. `manifest`/`approvedManifest` — строгий `action-provider-manifest.json` (core v1 отклоняет MCP-`description` из `provider-manifest.json`; вскрыто live-монтированием), и оба манифеста сверяются; реальный core `ActionProviderRegistry` принимает `approvedManifest` | `npm run test:contract` |
| Behavior (L2) | каждый тул из манифеста имеет фикстуру (`fixtures/tools.json`) и отвечает валидным MCP-конвертом через настоящий subprocess по stdio; внешний HH — loopback-мок, LLM — записанная фикстура; ошибка не роняет процесс | `npm run test:behavior` |
| Guards (L3) | статические гейты: quick-action-тулы не спавнят Claude/`runner.js`, у каждого исходящего HTTP есть таймаут, кред-файлы пишутся `mode 0o600`, секреты не логируются, пути профиля — только через `src/data-paths.js` | `npm run test:guards` |
| Unit | существующие доменные сценарии, транспорт, изоляция вакансий/пользователей | `npm run test:unit` |
| Replay-гейт | mandatory-набор `scripts/staging/suites.json` под `scripts/staging/isolation-guard.cjs`; пишет `staging-results/manifest.json` | `npm run test:staging` |
| Browser | MCP → HH mock + LLM mock → снапшот → настоящий HTML в Chromium | `npm run test:browser` |

Полный локальный прогон: `npm ci --include=dev`, `npx playwright install chromium`,
`npm test && npm run test:staging` (гейт входит в CI, но не в `npm test`).
Node 20.12+ / 22; CI закреплён на Node 22. Каждый слой идёт через
`scripts/test-isolated.cjs`: очищает окружение, создаёт временные
HOME/USERS_DIR/токены/данные и удаляет их после прогона. Nock 14 запрещает внешний
HTTP; loopback разрешён для фикстур.

## Replay-гейт

`scripts/staging/run.mjs` + `scripts/staging/isolation-guard.cjs` +
`scripts/staging/suites.json` — Phase 1 вендоренного из core harness (Phase 2 —
общий пакет `@trained-assist/mcp-skill-testkit`). Гейт:

- изолирует все data-root'ы (`HOME`, `TMPDIR`, `USERS_DIR`, `AGENT_DATA_DIR`,
  `AGENT_TOKENS_ROOT`) в temp через `NODE_OPTIONS=--require`;
- падает при прод-кредах в env и при выходе любого root за `STAGING_ROOT`;
- пропускает outbound только на loopback, остальное — `STAGING_OUTBOUND_BLOCKED`
  (записывается в манифест прогона);
- не аппрувит релиз при `skipped`/`todo`/пустом наборе;
- пишет `staging-results/manifest.json` (`sourceSha256`, `dirty`, isolation,
  `outboundBlocked[]`) для аудита.

`isolation-guard.cjs` вендорен из core с локальным усилением: http.Agent передаёт
хост как `hostname`, а connect нормализуется в `connect([options, cb])` — без
разбора этой формы `http.get(url)` утекал мимо guard'а. Покрыто L2-канарейкой.

## Mock — ровно два рубежа

Мокаются только LLM (`tests/support/llm-provider-fixture.cjs`,
`tests/support/llm-fixture.cjs`) и внешняя сеть HH
(`tests/helpers/mock-hh-server.js` + `tests/support/hh-fixture.cjs`). MCP-сервер,
registry, handlers, transport, генератор HTML и снапшот-стор работают
по-настоящему. Mock-регистратор не строится.

## CI vs Staging

CI (каждый PR) — детерминированный replay, LLM = записанные фикстуры, сеть =
loopback. **LLM-судья — это staging, а не CI.** Целевая модель staging
(post-merge): живой прогон — настоящий control plane (`MCP_SKILL_SOURCES_CONFIG`
+ per-source `profiles`), живой Hermes, cheap-LLM судья. Живой staging-монтаж в
этом репозитории пока **не реализован** (планируется, см.
`docs/requirements-log.md`); сейчас staging здесь — браузерный replay, а не
живой прогон.

## Перенос на другой скил

Общие файлы: `scripts/test-isolated.cjs`, `scripts/staging/*`,
`tests/helpers/mcp.js`, `tests/helpers/json-schema.js`,
`tests/support/network-guard.cjs`, `playwright.config.cjs` и reusable workflow.
Новый провайдер задаёт свой entrypoint, `mcp.manifest.json` (+ `scripts/mcp-artifact.js`),
фикстуры подключения, `fixtures/tools.json`, сценарии с планом моков и хотя бы
один replay-сценарий в `suites.json`. Клиент MCP не импортирует registry и не
подменяет handlers.

Workflow другого репозитория вызывает
`trained-assist/trained-assist-hh-skill/.github/workflows/skill-ci-reusable.yml@<reviewed-commit-sha>`
с `suite: unit|contract|behavior|guards|staging`; runner и scripts должны
присутствовать у вызывающего. Права `contents:read`; `secrets:inherit` не нужен.

## Release gates

Обязательные checks: `ci` и `staging-gate`. Они требуют именно `success`
зависимостей; failure, cancelled и skipped не проходят. Checkout — точный head SHA
PR, новые коммиты отменяют старый прогон. Нет path filters, `continue-on-error`,
retries браузерного сценария или optional staging. Ветка `main` требует оба check
через ruleset (`strict=true`, `enforce_admins=true`, force push и удаление
запрещены — подтверждено через GitHub API 2026-09-24). При падении браузера GitHub
сохраняет trace/screenshot/report; гейт загружает `staging-results/` артефактом.

## Живой HH

Отдельный ручной workflow `HH read-only live smoke`, только `main`, environment
`hh-live-smoke`, секрет `HH_SMOKE_TOKEN`. При отсутствии токена — явный failure, а
не зелёный skip. Два `GET`: `/me`, затем активные вакансии работодателя, одна
запись. Никаких сообщений, отклонений, открытия контактов, обновления токена или
публикации персональных данных. Редиректы запрещены.

## Границы проверки

HH/LLM — детерминированные фикстуры: проверяем запросы и обработку, но не
качество реальной модели, доступность HH или роутинг агента. L2 покрывает контракт
конверта, а не глубину каждого бизнес-сценария. Контракт core закреплён по SHA; это
не обещание совместимости с любым будущим core (см. `contracts/core/README.md`).
Цена поддержки: обновлять `mcp.manifest.json` при изменении тулов, API-фикстуры —
при изменении HH, сценарии — при изменении поведения.

Источники: [MCP tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools),
[Nock network isolation](https://github.com/nock/nock#enabledisable-real-http-requests),
[reusable workflows](https://docs.github.com/en/actions/sharing-automations/reusing-workflows),
[HH OpenAPI](https://api.hh.ru/openapi/specification/public),
`docs/domain-skill-repo-test-rules.md`.
