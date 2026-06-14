# Contributing to subkit

This file is the short form. The canonical contract is [`AGENTS.md`](AGENTS.md) — read that before changing behavior. Directory-local rules live in `apps/engine/AGENTS.md`, `apps/sk/AGENTS.md`, and `packages/shared/AGENTS.md`.

## Setup

```bash
# Bun is the only supported runtime. npm/yarn/pnpm are not.
curl -fsSL https://bun.sh/install | bash
bun install --frozen-lockfile

# Local Postgres + pg-boss + minio + redis stack for integration tests.
bun run compose:up
bun run db:migrate
bun run db:seed
bun run dev
```

## The quality gate

One command, one contract:

```bash
bun run verify
```

That runs, in order: `lint → typecheck → check:terminology → test:determinism → test:unit → verify:ai → test:integration → build:sk → test:e2e`. Anything you ship has to pass it locally before opening a PR. Don't push past a failing step.

The `/verify` slash-command in Claude Code runs the same gate.

## Conventional commits

`.commitlintrc.json` enforces the format. Allowed types: `feat`, `fix`, `docs`, `chore`, `refactor`, `perf`, `test`, `build`, `ci`, `style`, `revert`. Header ≤ 100 chars. Release-please reads these to cut the next version, so be precise:

```text
feat(connectors): per-tenant egress_guard_mode override
fix(conversations): single-token-entry connector save
chore(ci,scripts): wire openapi-drift + secret scan
docs(agents): correct subsystem table to match filesystem
```

A `BREAKING CHANGE:` token in the body bumps the major.

## Code style

- **Biome** is the only formatter and linter (`biome.json`). 100-char width, 2-space indent, double quotes, semicolons, trailing commas. `bun run lint:fix` fixes most issues.
- **TypeScript strict mode.** No `any` in new code. No non-null assertions without a documented invariant.
- **Zod at every boundary.** Every HTTP route, MCP tool, webhook, and CLI input gets a Zod schema first. OpenAPI is generated from those schemas — do not hand-edit `packages/cli-core/src/engine-api/`.
- **Structured logger only** (`apps/engine/src/logging/`) in app code. No `console.log/warn/error` in `apps/engine/src/`, `apps/sk/src/`, `packages/`. Build scripts under `scripts/` may use console output.
- **Comments explain why, not what.** One line max, no docblocks, no decorative banners.

## Naming and terminology

- The end-user CLI surface is **`sk`**. Use `sk` in user-facing prose, error messages, screenshots, and docs. The string `subkit` only appears when it adds information (the GitHub org, the `subkit` compatibility alias).
- Banned terms are listed in [`scripts/terminology.banned.txt`](scripts/terminology.banned.txt) and enforced on every PR by [`scripts/check-terminology.sh`](scripts/check-terminology.sh).

## Tests

Three layers, picked by what the change touches:

| Layer | Command | When to use it |
|---|---|---|
| unit | `bun run test:unit` | Pure logic, no DB / no queue / no HTTP. |
| integration | `bun run test:integration` | DB, pg-boss, HTTP, webhooks, OAuth2 — needs `compose:up`. |
| e2e | `bun run test:e2e` | Compiled CLI binaries against a live engine. |

Eval coverage (`bun run verify:ai`) is mandatory if you touch prompting, context assembly, routing, or authoring contracts.

## Pull-request flow

1. Branch is fine; small PRs land faster than big ones.
2. Run `bun run verify` locally.
3. Push and open a PR against `main`.
4. CI must be green: lint + typecheck + terminology + openapi-drift + determinism + db-migrate + tests + eval + build + e2e + smoke + secret-scan + dependency-review.
5. The `/review` slash-command (Claude Code) runs a structured review via the `domain-architect` agent.
6. Squash-merge with the conventional-commit message. Release-please will pick up the right semver bump.

## Project agent files

- `.claude/CLAUDE.md` — Claude Code bootstrap shim.
- `.claude/agents/` — `domain-architect`, `connector-builder`, `test-generator`.
- `.claude/skills/` — project-local skills.
- `.claude/commands/` — `/verify`, `/review`.
- `.claude/hooks/pre-bash-dispatch.sh` — bash safety net (no secrets, no `rm -rf`, no force-push to main, no prod compose).

## Safety

- `.env*`, `*.pem`, `*.key` are gitignored and off-limits to agents.
- Audit-log everything that mutates tenant-visible state. No exceptions.
- Skill Candidates and Patch Candidates surface as proposals — they become Skills / applied patches only via explicit operator action.
- Untrusted JS runs in `quickjs-emscripten` sandboxes. Set interrupt budgets.

If anything here conflicts with `AGENTS.md`, follow `AGENTS.md` and open a PR fixing this file.
