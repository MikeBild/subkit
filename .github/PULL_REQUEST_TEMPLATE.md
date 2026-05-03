<!--
Short PR? Just a summary + test plan is fine. The checklists below are a
backstop for the things that have actually broken in this repo before.
Read AGENTS.md if any of the rules are unclear.
-->

## Summary

<!-- 1–3 bullets: what changed and why. Cite docs/code paths over prose. -->

-

## Test plan

<!-- How a reviewer can verify this. Commands or manual steps. -->

-

## Audit phase / section

<!--
  Active architecture audit: docs/audits/2026-05-architecture-audit.md
  The audit-invariants CI check requires all three lines below to be present.
  If this PR is unrelated to the audit, fill in `unrelated` / `n/a` / `none`.
-->

**Audit phase:** <!-- 1 | 2 | 3 | 4 | 5 | 6 | unrelated -->
**Section reference:** <!-- e.g. docs/audits/2026-05-architecture-audit.md#42 — or `n/a` -->
**Verification touched:** <!-- which §6.4 invariants this PR moves — or `none` -->

## Quality gate

- [ ] `bun run verify` is green locally (lint + typecheck + terminology + audit:invariants + openapi-drift + determinism + test:unit + verify:ai + test:integration + build:sk + test:e2e).

## Boundary checklist (skip the rows that don't apply)

- [ ] **Schema change?** Drizzle schema + new SQL migration, both committed.
- [ ] **Route or MCP tool change?** Zod schemas updated, OpenAPI client regenerated (`bun run gen:openapi-client` — `check:openapi-drift` covers this in CI).
- [ ] **Mutates tenant-visible state?** `audit_log` entry covers it with structured before/after diff.
- [ ] **New env var?** `apps/engine/src/env.ts` updated, `.env.example` updated, `bun run check:terminology` green.
- [ ] **New connector / template?** Driver + template + auth-options are in `apps/engine/src/connectors/` and the template binding lints.
- [ ] **AI prompt or context change?** `bun run verify:ai` green; updated eval fixtures committed.
- [ ] **User-facing surface (CLI, sk, README)?** Leads with `sk`, not `subkit`.

## Notes

<!-- Anything reviewers should know that isn't obvious from the diff:
follow-up work, intentional out-of-scope items, related issues. -->
