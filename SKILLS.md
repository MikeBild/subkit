# Skills Index

Project-local skills for Claude Code, stored under `.claude/skills/<slug>/SKILL.md`.
Each skill is a self-contained guide that can be invoked via `/<slug>` or referenced
by an agent. See `AGENTS.md` for the canonical repo-wide contract and
`.claude/CLAUDE.md` for the Claude Code bootstrap.

## Strategy & positioning (read for *why*, before changing framing)

When the task touches product framing, vocabulary, category claims, or "why this
matters" — not only how to change code — read the three strategy documents in order:

- [`docs/thesis.md`](docs/thesis.md) — *Why this category exists.*
- [`docs/system-requirements.md`](docs/system-requirements.md) — *What such a system must do.*
- [`docs/positioning.md`](docs/positioning.md) — *How sk realises it.*

## Guardrail / routing

- [`subkit-operating-model`](.claude/skills/subkit-operating-model/SKILL.md) —
  Map a task intent to the right engine subsystem + canonical doc. Start here when
  the task description is generic.
- [`subkit-testing-and-validation`](.claude/skills/subkit-testing-and-validation/SKILL.md) —
  Pick the right test layer (unit / integration / e2e) and run the quality gate.
- [`subkit-api-and-openapi`](.claude/skills/subkit-api-and-openapi/SKILL.md) —
  Zod-first discipline for HTTP routes and MCP tools. OpenAPI is generated; don't
  hand-edit.
- [`subkit-rbac-and-policy`](.claude/skills/subkit-rbac-and-policy/SKILL.md) —
  Permissions, roles, resource grants, API keys, portal tokens, before-request hooks.
  Every surface enforces the same policy engine.
- [`subkit-observability`](.claude/skills/subkit-observability/SKILL.md) —
  Metrics, structured logs, traces, drift signals, token-budget accounting.
  Structured logger only; low-cardinality metric labels.

## Domain / procedural

- [`subkit-connector-patterns`](.claude/skills/subkit-connector-patterns/SKILL.md) —
  Add a connector template, driver tweak, or OAuth2 flow. References the 90 existing
  templates and 9 drivers.
- [`subkit-ai-context-pipeline`](.claude/skills/subkit-ai-context-pipeline/SKILL.md) —
  Work on Skills, Knowledge Sources, Skill Candidates, Conversations, Self-Healing,
  and Discovery. Human-in-the-loop rules are strict.
- [`subkit-self-healing`](.claude/skills/subkit-self-healing/SKILL.md) —
  Drift detection, bounded repair loop, Execution Fixture dry-runs, Patch Candidates.
  Never auto-apply.

## sk REPL surface (consolidated in #159)

- `/settings` opens a 10-tab palette in-process: `Settings · Status · Config · Usage ·
  Stats · Skills · Permissions · Knowledge · Profile · Admin`. The Admin tab is
  hidden unless the principal holds an admin-scoped permission.
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

Specialists under `.claude/agents/`:

- `domain-architect` (opus) — plan cross-subsystem features.
- `connector-builder` (sonnet) — implement bounded connector work.
- `test-generator` (sonnet) — generate tests at the right layer.

## Commands

Under `.claude/commands/`:

- `/verify` — run the full local release gate (`bun run verify`).
- `/review` — audit the current diff against subkit's non-negotiables.
