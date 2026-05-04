# Quickstart — Operator

You run sk for your team. Goal: engine up, one admin key minted, one connector registered. 10 minutes.

## 1. Install the `sk` CLI

```bash
curl -fsSL https://raw.githubusercontent.com/mikebild/subkit/main/scripts/install.sh | bash
```

See [docs/03-input-surfaces.md](../03-input-surfaces.md) for Windows and manual platform installs.
The install script may also place a `subkit` compatibility alias on disk, but the canonical
command surface is `sk`.

## 2. Bring the engine up

```bash
git clone https://github.com/mikebild/subkit && cd subkit
bun run compose:up          # Postgres + engine, all via Docker
```

The engine listens on `http://localhost:3000` by default. Verify:

```bash
curl -s http://localhost:3000/v1/health | jq
```

## 3. Bootstrap the first tenant + admin

On a fresh engine, watch stdout for the highlighted banner — it prints the one-time bootstrap token exactly once. Copy the token, then run:

```bash
sk init --engine-url http://localhost:3000 --token <bootstrap-token>
```

`sk init` redeems the token, prompts for admin email, tenant name, LLM provider, and LLM API key, then saves an admin profile + the returned `wf_live_…` key. Already-bootstrapped engine?

```bash
sk login --engine-url http://localhost:3000 --api-key <key>
```

`bun run db:issue-admin-key` is still available as an emergency hatch (skips the audit + RBAC seed flow `sk init` runs) — prefer `sk init` for a normal first-run.

## 4. Register your first connector

```bash
sk connectors create \
  --template stripe \
  --name stripe-prod
```

Pick from 90 connector templates — see [docs/05-connectors.md](../05-connectors.md) for how templates, drivers, and credentials work together.

## 5. You're operational

- `sk workflows list` — see what's defined.
- `sk executions list` — watch executions.
- `sk audit tail` — confirm every state change is recorded.
- `curl -H "Authorization: Bearer <key>" http://localhost:3000/metrics` — Prometheus scrape target.

## Next steps

- [docs/05-connectors.md](../05-connectors.md) — connector management, credentials, OAuth2, and private-network tunnels.
- [docs/07-security-governance.md](../07-security-governance.md) — RBAC, identity setup (OIDC/SSO), API key rotation, and Before-Request Hooks.
- [docs/08-operations.md](../08-operations.md) — observability, resource limits, self-healing, and backup strategy.
