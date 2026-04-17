---
description: Run the subkit quality gate — biome lint, tsc typecheck, bun unit tests.
---

Run the project's quality gate, in order:

1. `bun run lint`
2. `bun run typecheck`
3. `bun run test:unit`

Stop at the first failure, show the output, and suggest the root cause.

If the change touched `db/`, `queue/`, `http/`, or `webhooks/`, also run
`bun run test:integration`. If it touched CLI binaries (`apps/cli/`, `apps/sk/`) or
cross-binary behavior, also run `bun run test:e2e`.

Never skip hooks (`--no-verify`) or bypass sign-off — the `.claude/hooks/pre-bash-dispatch.sh`
guard will refuse.
