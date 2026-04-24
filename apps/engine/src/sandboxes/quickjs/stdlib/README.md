# sk-Stdlib — Contributor Guide

This directory owns the curated helper surface that is injected into every
QuickJS sandbox context before user code runs. Any function available as
`sk.*` inside a before-request hook or `language: "javascript"` transform
comes from `stdlib.js` in this directory.

## Why it exists

The sandbox guarantees zero host globals (no `fetch`, no `process`, no
`require`, no `Date.now` leak). That isolation is strong but forces user
code to re-implement routine helpers (null-safe access, HTTP-method
classification, decision shapes). The stdlib gives operators a vetted
surface so their code stays short, reviewable, and uniform across tenants.

The LLM-authoring layer proposes `sk.*` calls by default (see
`conversations/seed/skills/workflow-authoring.md`) — if you change this
surface, also update that skill so proposals stay consistent.

## Layout

| File                 | Role                                                                 |
|----------------------|----------------------------------------------------------------------|
| `stdlib.js`          | Plain ES2020 source — evaluated inside QuickJS on every sandbox call |
| `stdlib.d.ts`        | TypeScript types — consumed by authoring tooling, not at runtime     |
| `index.ts`           | Reads `stdlib.js` at load time; exports `STDLIB_SOURCE`, `STDLIB_VERSION` |
| `drift.ts`           | Pure helper that detects major-version drift vs. recorded workflows  |
| `tests/*.test.ts`    | Unit tests — run inside QuickJS via `runJs`, not in Node             |

## Versioning

The stdlib is semver-versioned. The version lives in **two places** that
must stay in sync:

1. `stdlib.js` — the `version: "X.Y.Z"` literal on the frozen `sk` object.
2. Automatically parsed by `index.ts` into `STDLIB_VERSION`.

Nothing else records a version — do not add a second source of truth.

### When to bump

| Change                                                               | Bump  |
|----------------------------------------------------------------------|-------|
| Add a new function or a new read-only field                          | Minor |
| Fix a bug that keeps the existing contract                           | Patch |
| Change a signature, remove a function, change observable behaviour   | Major |
| Internal refactor with no surface change                             | Patch |

A **major bump** must be paired with a documented migration path so the
self-healing loop can propose a Patch Candidate when it encounters a
workflow persisted against the previous major. See `drift.ts` for the
detection side.

## Adding a function

1. Implement it in `stdlib.js` (plain ES2020, no `Date.now`, no
   `Math.random`, no host globals).
2. Add the typed signature to `stdlib.d.ts`.
3. Add unit tests under `tests/` — tests run inside the QuickJS sandbox
   via `runJs`, so they exercise the same evaluator path user code sees.
4. Bump `version` in `stdlib.js` (minor for additive, major otherwise).
5. Update `conversations/seed/skills/workflow-authoring.md` and
   `mcp-tool-contract.md` so the LLM-authoring layer proposes the new
   call.
6. Run `/verify`.

## Determinism

The stdlib must remain deterministic. No `Date.now`, no `Math.random`, no
host I/O, no async. Self-healing dry-runs depend on sandbox execution
being reproducible; any non-determinism here leaks into the whole
governance pipeline.

## Size budget

The stdlib source is evaluated afresh on every `runJs` call (QuickJS does
not share bytecode across contexts). Current size is ~5 KB; treat 20 KB
as a soft ceiling. If the stdlib grows beyond that, split into optional
sub-modules injected on demand rather than inflating the default preamble.
