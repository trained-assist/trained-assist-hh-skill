# Core consumer snapshot

Source: trained-assist/trained-assist-agent, commit
`74896cc4aced8e29446134ccb8b0010e58cca49b` (main inspected 2026-09-24).

- `contract.schema.json`: byte-for-byte copy of `contracts/action-v1/contract.schema.json`.
- `action-provider-registry.cjs`: `src/action-provider-registry.js`, only schema require path adjusted.

No hand-written lookalike validator: tests execute the actual consumer, including
atomic registration, schema compilation, argument validation and trigger policy.
A pinned fixture proves compatibility with this revision, NOT future core main.
When core contract changes, update these two files together with this provenance
and run `npm run test:contract`; providers/core must coordinate this update.

`provider-manifest.json` remains the rich approved MCP catalog (descriptions included).
`action-provider-manifest.json` is the generated strict v1 core registration artifact
(descriptions omitted because core forbids additional descriptor properties).
Tests require exact action/policy/schema parity. No core runtime deployment is part
of this change; wiring the strict artifact into a future core loader is separate.
