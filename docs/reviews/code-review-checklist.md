# Code-Review Checklist

A reusable, repeatable checklist for reviewing a subkit change before it merges. It encodes
the non-negotiables from `AGENTS.md` and mirrors the tiers used by the `/review` command
(`.claude/commands/review.md`). Use it for self-review, peer review, and as the rubric the
`domain-architect` agent applies.

Findings are reported in four tiers: **CRITICAL** (contract violation — block), **WARNING**
(risk — fix before merge), **SUGGESTION** (improvement — author's discretion), **PASS**
(what the change gets right).

## Contract (CRITICAL when violated)
- **Tenant isolation** — every query and response carries `tenant_id`; new `where` clauses use
  `tenantConds` / `tenantWhereClauses` names so the AST scan recognises them. A missing scope is
  a security bug, not a style nit.
- **Audit** — every state change writes an `audit_log` entry with the correct action type and
  request source (`api | cli | scheduler | mcp | webhook | tool-chain | ui`) and actor.
- **Zod at every boundary** — routes, MCP tools, webhooks, CLI inputs validate via Zod; the
  OpenAPI surface is generated, never hand-edited.
- **RBAC** — every new route / MCP tool declares an explicit permission. No permission = missing check.
- **Structured logger only** — no `console.*` in engine / CLI / sk / agent code (build scripts may).
- **Sandboxing** — untrusted JS (before-request hooks, transforms, repair patches) runs only via
  `apps/engine/src/sandboxes/` with interrupt budgets.
- **Credentials** — secrets flow through `credentials/` + `crypto/` (AES-256-GCM); never logged raw.
- **Approval gates** — Skill Candidates and Patch Candidates surface as proposals; no auto-promotion
  or auto-apply, no `--skip-checks` escape hatches.

## Determinism (tests)
- Time via `getTestNow()` / `FROZEN_NOW` / `createDeterministicClock()` — never raw `Date.now()`
  (annotate genuine exceptions `// allow-wall-clock`).
- Randomness via `createSeededRandom` / `createDeterministicUuidFactory` — never `Math.random()` /
  `crypto.randomUUID()` (annotate `// allow-random`).
- Waiting via `waitFor` / `waitForJson` — never raw `setTimeout`.
- No `.only` / `.skip`; use `test.skipIf(condition)` with a named env flag.

## Style & comments
- Biome clean: 100-col, 2-space, double quotes, semicolons, trailing commas.
- TS strict; no `any` in new code; no non-null assertion without a documented invariant.
- **Comments explain WHY, not WHAT.** One line; no multi-line docblocks restating code. Keep only
  non-obvious constraints, bug-rooted workarounds, and subtle invariants.
- **No ticket coupling** — comments / TODOs / docs do not reference PR numbers, issue IDs, `bug-N`,
  review-wave letters, or round numbers.
- Domain vocabulary: `connector` and `workflow`; banned terms stay banned
  (`scripts/terminology.banned.txt`).

## Architecture
- No cross-subsystem reach-arounds — call public entry points, not another subsystem's internal helpers.
- New types live at the right layer; shared domain shapes (Zod) live in `packages/shared` and import
  nothing from `apps/*`.
- Type the edges: prefer Drizzle `$inferSelect` / a single boundary `Schema.parse` over `row as T`
  cast chains.
- Discriminated unions are dispatched exhaustively (`assertNever`) so the compiler enforces completeness.
- Files trend toward a sane size budget; extract cohesive pure stages rather than growing god-files.
- No backwards-compat shims — if a caller moves, migrate it in the same change.

## Tests
- Right layer: pure logic = unit; db / queue / http / webhooks = integration; CLI binaries = e2e.
- Negative cases for RBAC and tenant isolation accompany new authorised paths.
- The local gate is green: `bun run verify` (lint, typecheck, terminology, determinism, drift checks,
  unit, eval, integration, build:sk, e2e).
