# trained-assist-hh-skill

Recruiting/HeadHunter domain implementation: candidate/vacancy data, ATS, cold search, conversation preparation and approved sending. Host/UI/MCP adapters use the same domain capability; agent execution is not required for a deterministic UI action.

Документы содержат действующие требования, контракты и инструкции. Планы выполнения, статусы, ревью прошлых версий и evidence ведутся в GitHub issues/PR/Project. Целевая модель не является утверждением о текущем deployment; его готовность проверяется по конкретным SHA и приёмке.

## Sources

- `src/` — domain implementation; `mcp.manifest.json`, `provider-manifest.json`, `action-provider-manifest.json` — declared interfaces.
- [User scenarios](docs/user-scenarios/README.md) — domain requirements.
- [CI contract](docs/skill-ci.md), `tests/`, `scenarios/`, `fixtures/` — executable verification.
- `playbooks/recruiting-vacancy-launch.json` — domain playbook artifact.

Host owns profile/credential binding and permissions. Draft generation and provider send are separate effects; repeated delivery needs durable operation identity. Candidate/document ownership is verified; callback/input IDs alone do not authenticate a user.

Use package.json check/test/manifest commands. Offline fixtures, staging smoke and real provider acceptance are distinct evidence. Implementation order, bugs and audits are in [issues](https://github.com/trained-assist/trained-assist-hh-skill/issues); dated audit/eval files are evidence, not a deployment plan.

Shared model: [architecture](https://github.com/trained-assist/trained-agent-architecture/blob/main/ARCHITECTURE.md).

Retiring GCP VM is not a development or fallback target. Keep its existing runtime and public routes until HH #187 acceptance. Do not add new work there; the cold-search replacement requires an independently verified non-GCP host. Cloud Run is not the selected HH host. Other Google services remain allowed. Exit coordination: https://github.com/trained-assist/trained-agent-architecture/issues/145.
