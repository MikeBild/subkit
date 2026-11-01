# Contributing to sk

Thanks for helping. This page is the short version; `AGENTS.md` is the canonical contract
for the engine, the CLI and the shared package, and the nearest `AGENTS.md` wins for the
code you touch.

## Set up

Requires Bun and Docker with Compose.

```bash
bun install                 # also points git at .githooks
bun run start:local         # starts the stack and completes first-run setup with the mock LLM
```

## Before you push

Pushes to `codekit/**` branches run CI typecheck and unit tests; see [Task branches](#task-branches).
The pre-push hook is the local gate: lint, typecheck, determinism, invariants,
generated-artifact drift, commit messages, secrets, build. Run the narrowest check while you
iterate and the full gate before you push.

Before running unit tests, run `bun run compose:up`, or configure `DATABASE_URL` for an
existing PostgreSQL server with permission to create test databases. The unit command sets
`SKIP_DOCKER=1`, which does not remove this PostgreSQL dependency.

```bash
bun run lint
bun run typecheck
bun run test:unit           # needs PostgreSQL
bun run test:integration    # needs Docker
bun run verify              # the full release gate, run before a release tag
```

## Task branches

Pushes to branches named `codekit/**` run the `task-verify.yml` workflow.
The workflow runs typecheck and unit tests.
An agent runs only the tests for the files it changed, because the full suite runs in that workflow.
Merge a task branch only after that run is green.

## How we work

- Work directly on `main` in focused changes. Never discard unrelated dirty-worktree state.
- Keep the boundaries between transport, domain, persistence and execution.
- Preserve approval gates and interaction-mode behaviour: a person approves what a workflow
  may reach, and every run is recorded.
- No comments in code except tool directives. Names and tests carry the meaning.
- No versions, dates, ticket or commit references in code, tests or file names, and no
  version-suffixed names. Replace the old path and migrate every caller in the same change.
- Generated artifacts come from their generators, never from hand edits:
  `bun run gen:llms-txt`, `bun run check:openapi-drift` and the other `check:*-drift` scripts
  tell you when something is stale.
- Never commit credentials, local configuration or generated secrets. Examples use placeholders.

## Commit messages

One conventional-commit line, nothing else:

```
feat(engine): approvals follow a new version whose boundary does not grow
```

Allowed types: `feat`, `fix`, `docs`, `chore`, `refactor`, `perf`, `test`, `build`, `ci`,
`style`, `revert`.

## Bugs, ideas, security

- Bugs and feature requests: open an issue on GitHub.
- Security problems: use GitHub's private vulnerability reporting for this repository instead
  of a public issue.

By contributing you agree that your contribution is licensed under the MIT License of this
repository.
