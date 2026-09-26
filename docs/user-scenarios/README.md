# User Scenarios

Живая документация пользовательских сценариев HH-скила. Каждый файл — это и
спецификация поведения, и основа тестов: каждый шаг имеет наблюдаемый ассерт
(файл создан, API вызван, текст содержит X).

Формат (см. правила `trained-assist-agent/docs/domain-skill-repo-test-rules.md`):
`Контекст → Шаги → Validation → Edge cases`, плюс **план моков**, написанный
вместе со сценарием. Сценарии делятся на два класса:

- **mandatory** — входят в детерминированный replay-гейт
  (`scripts/staging/suites.json`), запускаются в CI;
- **exploratory** — вне гейта, могут использовать LLM-судью на staging, не
  блокируют релиз.

| Сценарий | Класс | Replay-реализация |
|---|---|---|
| `recruiting/01-cold-search-to-review-page.md` | mandatory | `scenarios/cold-search-replay/` + `tests/staging/cold-search.spec.cjs` |
| `recruiting/02-ats-config-to-scored-responses.md` | exploratory | `tests/behavior/tools.test.cjs` (CI-план моков) |
