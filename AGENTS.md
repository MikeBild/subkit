# SubKit Agent Guide

Canonical repo-wide instructions for the SubKit engine and CLI. Closer AGENTS.md files override this guide.

## Product boundaries

- Preserve the engine, CLI, shared-package, approval, and deployment boundaries.
- Keep the repository independent of the private deployment implementation.
- Keep all persisted data in the product-owned PostgreSQL schema. Other products
  are reachable only through their documented public APIs, never through their
  database objects, files, queues, or runtime internals.
- Keep migrations, `llms*.txt`, OpenAPI, and comparable self-description assets
  embedded in every shipped binary/image and covered by drift tests. `llms*.txt`
  is generated from code and README.md (`bun run gen:llms-txt`); there is no
  hand-written documentation tree.
- Do not record concrete production hosts, credentials, deployment identifiers,
  or private infrastructure anywhere in the repository. Examples use placeholders.
- Preserve human approval semantics and deterministic execution. A person
  approves an effect boundary (connectors, addresses, read vs. write) for an
  environment. The approval follows a newly activated version whose boundary
  does not grow and is asked for again when it grows. It may stand until
  revoked or be limited by runs and time; revoking it is always possible.

## Sources and workflow

Read touched code and the nearest AGENTS.md:
- apps/engine/AGENTS.md for engine work
- apps/sk/AGENTS.md for CLI work
- packages/shared/AGENTS.md for shared contracts

The engine currently contains 48 directories under `apps/engine/src/`; the
subsystem-count contract keeps this navigation summary aligned with the tree.

Work directly on `main`. Prefer focused changes, existing abstractions, and generated-source workflows. Never discard unrelated dirty-worktree state.

## Non-negotiable rules

- Maintain strict boundaries between transport, domain, persistence, and execution.
- Preserve approval gates and interaction-mode behavior.
- Never commit credentials, local configuration, or generated secrets.
- Do not hand-edit generated artifacts when a generator exists.
- Keep shared guidance in AGENTS.md or closer directory guides, not Claude-only memory.
- No comments in code except tool directives (`biome-ignore`, `@ts-expect-error`,
  `tenant-filter:exempt`, …). Names and tests carry the meaning; a comment is a
  claim, only a test is evidence.
- No versions, dates, ticket, PR or commit references in code, tests or file names.
- No version-suffixed names (`*V2`, `_v2`, `legacy*`); replace the old path and migrate every caller in the same change.
- Commit messages are one conventional-commit line.

## Validation

There is no CI. The pre-push hook (lint, typecheck, invariants, drift, commit
messages, gitleaks, build) and `bun run verify` before every release tag are the
gate. `bun run release:tag` also runs `bun run verify:llm-live`, a fail-closed live
call of the release models that has no bypass: pass the deployed route as
`bun run release:tag -- --models anthropic:<primary>,openai:<fallback>`; keys come from
`./key.txt` (Anthropic) and `./openai-key.txt` (OpenAI), both gitignored. Run the narrowest relevant checks while iterating.
Report any skipped validation.
