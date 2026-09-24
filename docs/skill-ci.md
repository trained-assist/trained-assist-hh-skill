# Исполняемый контракт CI для скилов

PR запускает три независимых уровня, без секретов, платных API и реальных кандидатов.

| Уровень | Что проверяет | Команда |
|---|---|---|
| Unit | существующие доменные сценарии, транспортные ошибки/ретраи, изоляция вакансий/пользователей, сохранность данных | `npm run test:unit` |
| Contract | настоящий MCP subprocess: initialize, discovery с/без подключения, вызов списка вакансий, ошибки; схемы каталога; реальный закреплённый core registry, неверные аргументы/политики/дубли | `npm run test:contract` |
| Staging | MCP → HH mock + LLM mock → сохранённые результаты → настоящий HTML в Chromium → фильтры, reload, recall после рестарта MCP, 403 и восстановление, дедупликация | `npm run test:staging` |

Полный прогон: `npm ci --include=dev`, `npx playwright install chromium`, `npm test`.
Node 20.12+ / 22. CI закреплён на Node 22. Не запускать файлы тестов вручную с
боевым HOME: `scripts/test-isolated.cjs` очищает окружение, создаёт временные
HOME/USERS_DIR/токены/данные и удаляет их после прогона. Таймаут каждого набора 5 мин.
Nock 14 запрещает внешний HTTP и native fetch; loopback разрешён для фикстур.
Отдельные canary-проверки доказывают запрет для обоих клиентов. Chromium разрешает
только адрес локальной страницы; любые внешние запросы или pageerror ломают тест.

## Перенос на другой скил

Общие файлы: `scripts/test-isolated.cjs`, `tests/support/network-guard.cjs`,
`tests/support/mcp-client.cjs`, `playwright.config.cjs` и reusable workflow.
Новый провайдер задаёт собственный entrypoint, фикстуры подключения, API-ответы,
manifest и хотя бы один бизнес-сценарий. Клиент MCP не импортирует registry и не
подменяет handlers: сломанный executable или мусор в stdout — красный тест.
Не копируйте HH-данные; меняется адаптер `hh-fixture.cjs` и ожидания сценария.
Workflow другого репозитория вызывает
`trained-assist/trained-assist-hh-skill/.github/workflows/skill-ci-reusable.yml@<reviewed-commit-sha>`
с `suite: unit|contract|staging`; runner и scripts должны присутствовать у вызывающего.
Права contents:read; secrets:inherit не нужен.

## Release gates

Стабильные имена обязательных checks: `ci` и `staging-gate`.
Они требуют именно success зависимостей; failure, cancelled и skipped не проходят.
Checkout — точный head SHA PR, новые коммиты отменяют старый прогон. Нет path filters,
continue-on-error, retries браузерного сценария или optional staging.
Ветка должна требовать оба check через ruleset/branch protection. Сам YAML не может
запретить ручной bypass администратора; наличие защиты проверяется отдельно при выпуске.
Для автоматического deployment требуется needs обоих gate и success на выпускаемом SHA.
Этот repo не имел deploy workflow: здесь не добавлен фиктивный «деплой» или рестарт core.
При падении браузера GitHub сохраняет trace, screenshot и report на 7 дней.

## Живой HH

Отдельный ручной workflow `HH read-only live smoke`, только main, environment
`hh-live-smoke`, секрет `HH_SMOKE_TOKEN`. При отсутствии токена — явный failure,
а не зелёный skip. Два GET: `/me`, затем активные вакансии работодателя, одна запись.
Никаких сообщений, отклонений, открытия контактов, обновления токена или публикации
персональных данных; вывод содержит только успех и число вакансий. Редиректы запрещены.
Токен не вечный: истечение требует безопасного обновления секрета владельцем подключения.
Живой smoke не запущен и не включён по расписанию без настроенного CI-секрета.
PR-проверки полностью работают без него. Автоматическую ротацию OAuth здесь не строим.

## Границы проверки

HH/LLM — детерминированные HTTP-фикстуры: проверяем запросы и обработку результатов,
но не качество реальной модели, доступность HH или естественно-языковой роутинг агента.
Staging HTTP adapter представляет boundary основного сервиса; это НЕ запуск полного
боевого server.js. Проверяется настоящий renderer, signed URL и callback payload,
но не production reverse proxy/auth middleware. Контракт core закреплён по SHA;
это не обещание совместимости с любым будущим core (см. contracts/core/README.md).
Цена поддержки: обновлять контрактный snapshot при изменении core, API-фикстуры при
изменении HH, сценарий при изменении пользовательского поведения. Денежных затрат
на HH/LLM в обязательном CI нет; расходуются минуты GitHub Actions и Chromium.

Источники исследования: [MCP tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools),
[Nock network isolation](https://github.com/nock/nock#enabledisable-real-http-requests),
[reusable workflows](https://docs.github.com/en/actions/sharing-automations/reusing-workflows),
[HH OpenAPI](https://api.hh.ru/openapi/specification/public).
