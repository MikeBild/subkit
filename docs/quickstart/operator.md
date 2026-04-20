# Quickstart — Operator

You run sk for your team. Goal: engine up, one admin key minted, one connector registered. 10 minutes.

## 1. Install the `subkit` CLI

```bash
curl -fsSL https://raw.githubusercontent.com/mikebild/subkit/main/scripts/install.sh | bash
```

See [docs/03-input-surfaces.md](../03-input-surfaces.md) for Windows and manual platform installs.

## 2. Bring the engine up

```bash
git clone https://github.com/mikebild/subkit && cd subkit
bun run compose:up          # Postgres + engine, all via Docker
```

The engine listens on `http://localhost:3000` by default. Verify:

```bash
curl -s http://localhost:3000/v1/health | jq
```

## 3. Mint an admin API key

```bash
bun run db:issue-admin-key
```

Copy the `wf_live_…` key that prints. Point the CLI at the engine:

```bash
subkit login --engine-url http://localhost:3000 --api-key <key>
```

## 4. Register your first connector

```bash
subkit connectors create \
  --template stripe \
  --name stripe-prod \
  --environment prod
```

Pick from 89 connector templates — see [docs/05-connectors.md](../05-connectors.md) for how templates, drivers, and credentials work together.

## 5. You're operational

- `subkit workflows list` — see what's defined.
- `subkit runs list` — watch executions.
- `subkit audit-log tail` — confirm every state change is recorded.
- `curl -H "Authorization: Bearer <key>" http://localhost:3000/metrics` — Prometheus scrape target.

## Next steps

- [docs/05-connectors.md](../05-connectors.md) — connector management, credentials, OAuth2, and private-network tunnels.
- [docs/07-security-governance.md](../07-security-governance.md) — RBAC, identity setup (OIDC/SSO), API key rotation, and Before-Request Hooks.
- [docs/08-operations.md](../08-operations.md) — observability, resource limits, self-healing, and backup strategy.
