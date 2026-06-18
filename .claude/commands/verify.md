description: Run the subkit local release gate — lint, typecheck, determinism, unit, eval, integration, build, e2e.
---

Run the project's quality gate, in order. Stop at the first failure and surface the
root cause:

1. `bun run lint`
2. `bun run typecheck`
3. `bun run test:determinism`
4. `bun run test:unit`
5. `bun run verify:ai`
6. `bun run test:integration` (auto-boots local Postgres if needed — see below)
7. `bun run build:sk`
8. `bun run test:e2e`

Wall-clock budget: ~3–5 minutes on a warm checkout. Up-front caches (Docker layer,
Bun install, `dist/sk` artifact) keep repeat runs fast.

If Postgres is not already listening on `localhost:5432`, start it before step 4:
`docker compose up -d postgres` (the repo's `docker-compose.yml` is dev-only).

To downgrade the determinism lint to warnings (e.g. while an exception is under
review), set `SUBKIT_DETERMINISM_WARN=1`.

Never skip hooks (`--no-verify`) or bypass sign-off — the
`.claude/hooks/pre-bash-dispatch.sh` guard will refuse.
