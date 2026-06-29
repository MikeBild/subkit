# Skills Index

Project-local skills for Claude Code, stored under a local-only `.claude/skills/<slug>/SKILL.md`
(the `.claude/` directory is gitignored and not part of the repository). Each skill is a
self-contained guide that can be invoked via `/<slug>` or referenced by an agent. See
`AGENTS.md` for the canonical repo-wide contract and `.claude/CLAUDE.md` for the Claude Code
bootstrap.

## Guardrail / routing

- `subkit-operating-model` —
  Map a task intent to the right engine subsystem + canonical doc. Start here when
  the task description is generic.
- `subkit-testing-and-validation` —
  Pick the right test layer (unit / integration / e2e) and run the quality gate.
- `subkit-api-and-openapi` —
  Zod-first discipline for HTTP routes and MCP tools. OpenAPI is generated; don't
  hand-edit.
- `subkit-rbac-and-policy` —
  Permissions, roles, resource grants, API keys, portal tokens, before-request hooks.
  Every surface enforces the same policy engine.
- `subkit-observability` —
  Metrics, structured logs, traces, drift signals, token-budget accounting.
  Structured logger only; low-cardinality metric labels.

## Domain / procedural

- `subkit-connector-patterns` —
  Add a connector template, driver tweak, or OAuth2 flow. References the 93 existing
  templates and 4 drivers.
- `subkit-ai-context-pipeline` —
  Work on Skills, Knowledge Sources, Skill Candidates, Conversations, Self-Healing,
  and Discovery. Human-in-the-loop rules are strict.
- `subkit-self-healing` —
  Drift detection, bounded repair loop, Execution Fixture dry-runs, Patch Candidates.
  Never auto-apply.

## sk REPL surface

- `/settings` opens a 5-tab palette in-process: `Status · Config · Usage · Skills ·
  Knowledge`. Operator surfaces are separate slash commands (`/permissions`,
  `/profile`, `/admin`), not tabs; `/admin` is gated to admin-scoped principals.
- Slash registry lives in `apps/sk/src/slash.ts`; deleted-slash redirects in
  `apps/sk/src/repl/slash/dispatcher.ts:REMOVED_SLASH_GUIDANCE`. Permanent
  guidance for slashes subkit intentionally never ships (`/agents`, `/fast`,
  `/plan`, `/diff`, `/output-style`, `/rewind`).
- Engine settings groups added: `repl.permissionMode`, `ui.{theme,personality,
  title.format,statusline.format}`, `notifications.push.{enabled,thresholdSec,
  quietHoursStart,quietHoursEnd}`. Resolved per principal in
  `skBootstrap.prefs`.
- Engine fork-from-message route: `POST /v1/conversations/{id}/fork-from-message/{message_id}`
  copies messages 0..N into a new conversation; reachable from the `/resume`
  rewind sub-mode (toggle with `t`).

## Sub-agents (not skills, but related)

Specialists under the local-only `.claude/agents/`:

- `domain-architect` (opus) — plan cross-subsystem features.
- `connector-builder` (sonnet) — implement bounded connector work.
- `test-generator` (sonnet) — generate tests at the right layer.

## Commands

Under the local-only `.claude/commands/`:

- `/verify` — run the full local release gate (`bun run verify`).
- `/review` — audit the current diff against subkit's non-negotiables.
