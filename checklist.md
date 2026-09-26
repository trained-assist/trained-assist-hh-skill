# Checklist — Adopt domain-skill test & CI rules (issue #21)

Goal: применить полностью правила тестов и CI для доменных skill-репо
(`trained-assist-agent/docs/domain-skill-repo-test-rules.md`) — три слоя CI
(contract / behavior / guards), вендоренный детерминированный replay-гейт,
сценарии + планы моков, мок ровно LLM и внешней сети.

- [x] CI green on https://github.com/trained-assist/trained-assist-hh-skill/pull/22
- [ ] Merged to main
- [ ] Deployed / mounted to staging — verified live

DoD (доменный репо):

- [x] L1/L2/L3 зелёные, mandatory `scripts/staging/suites.json` непустой
- [x] нет network-outside-loopback и прод-кред во время CI (guard доказывает, `staging-results/manifest.json`)
- [x] сценарий + план моков на каждый поддерживаемый happy-path (`docs/user-scenarios/recruiting/`)
- [x] manifest-паритет имён тулов с core соблюдён (`mcp.manifest.json`)
- [x] quick-action-тулы не спавнят Claude (L3 guard)
- [ ] staging-канарейка проверена (источник реально монтируется, не мок) — планируется, вне этого PR
