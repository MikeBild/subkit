# Claude Code — subkit

**Start with `../AGENTS.md`.** It is the canonical repo-wide contract: product boundaries,
architecture split, code-quality rules, testing layers, quality gate, and the map of the
35 engine subsystems.

This file is a compatibility shim. It indexes what lives under `.claude/` so you can jump
to the right helper quickly. It does not override `AGENTS.md`.

## Read order for a new session

1. `../AGENTS.md` — the contract.
2. `../SKILLS.md` — one-line index of project-local skills.
3. The nearest directory-local `AGENTS.md` for the code you are about to touch:
   `apps/engine/AGENTS.md`, `apps/cli/AGENTS.md`, `apps/sk/AGENTS.md`,
   `apps/agent/AGENTS.md`, `packages/shared/AGENTS.md`.
4. `../docs/00-agent-navigation.md` — maps common tasks → docs + subsystem.
5. The numbered doc(s) that own the concern (see the subsystem table in `AGENTS.md`).

## Agents

Specialist sub-agents live under `.claude/agents/`. Invoke via the Agent tool with
`subagent_type` matching the filename.

| Agent | Model | When to use |
|---|---|---|
| `domain-architect` | opus | Multi-subsystem features, cross-cutting changes, scoping big work. |
| `connector-builder` | sonnet | New connector templates, driver tweaks, OAuth2 flows, schema versioning. |
| `test-generator` | sonnet | Writing unit / integration / e2e tests following the repo patterns. |

## Commands

Thin slash-commands under `.claude/commands/`.

| Command | What it does |
|---|---|
| `/verify` | Runs the quality gate: lint + typecheck + test:unit. |
| `/review` | Structured code review of the current diff via `domain-architect`. |

## Skills

Project-local skills under `.claude/skills/<slug>/SKILL.md`:

- `subkit-operating-model` — intent → subsystem routing.
- `subkit-testing-and-validation` — pick the right test layer.
- `subkit-connector-patterns` — add a connector template or driver.
- `subkit-api-and-openapi` — Zod-first route discipline.
- `subkit-ai-context-pipeline` — Skills, Knowledge Sources, Candidates, Conversations.
- `subkit-rbac-and-policy` — permissions, roles, API keys, portal tokens, hooks.
- `subkit-observability` — metrics, logs, traces, drift, token budgets.
- `subkit-self-healing` — drift detection, bounded repair, Patch Candidates.

## Safety net

`.claude/settings.json` registers a `PreToolUse` Bash hook at
`.claude/hooks/pre-bash-dispatch.sh`. It refuses to read secrets (`.env*`, `*.pem`, `*.key`),
refuses `rm -rf` on tracked roots, refuses force-push to `main`, and refuses production
`docker compose` usage. Exit 0 = allow, 2 = block with reason on stderr. If a legitimate
command is blocked, fix the hook — do not disable it.
