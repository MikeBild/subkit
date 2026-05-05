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

## 3. Log in with the seeded admin key (or bootstrap)

`bun run compose:up` defaults to `NODE_ENV=development` and seeds a `default` tenant plus an `admin@local` admin key. Grab the key from the seed-container logs and log in:

```bash
docker compose logs seed | grep -A1 'NEW API KEY ISSUED — default-bot'
sk login --engine-url http://localhost:3000 --api-key <wf_live_…>
```

That key is printed exactly once. If you missed it, `bun run db:issue-admin-key` mints a fresh one without re-running the seed.

**Production-mode first-run instead.** Set `NODE_ENV=production` in `.env` before `bun run compose:up` and the dev seed is skipped — the engine prints a one-time bootstrap-token banner on first boot. Copy the token, then:

```bash
sk init --engine-url http://localhost:3000 --token <bootstrap-token>
```

`sk init` redeems the token, prompts for admin email, tenant name, LLM provider, and LLM API key, and saves an admin profile + the returned `wf_live_…` key.

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

## How `curl /install | bash` works against your engine

The default deploy (`deploy/docker-compose.prod.yml`) ships the **`engine-with-cli`** image variant: the engine itself serves matching `sk` and `tunnel-agent` binaries from `/install/sk-:platform-:arch`, `/install/agent-:platform-:arch`, and `/install/sha256sums`. Anyone who can reach the engine can install the CLI, even on air-gapped or proxy-restricted networks — no GitHub egress required.

Two image tags ship per release:

| Tag                                | Size       | Serves `/install/sk-*` and `/install/agent-*` | When to pick                                                |
| ---------------------------------- | ---------- | --------------------------------------------- | ----------------------------------------------------------- |
| `subkit/engine:<version>-with-cli` | +~360 MB   | yes — bundled binaries with SHA verification  | **default**: every operator's `curl … /install` works       |
| `subkit/engine:<version>`          | slim       | no — install script falls back to GitHub      | size-conscious deploys where every operator has GitHub egress |

The install command is identical for both:

```bash
curl -fsSL https://my-engine.example.com/install | bash
```

The script probes `${ENGINE_URL}/install/sk-${os}-${arch}` first; on `200` it streams from there with `x-subkit-sha256` verification against `${ENGINE_URL}/install/sha256sums`. On `404` it falls back to the GitHub Release for the engine's running version. The user-visible behaviour is the same — the variant only changes whether the bytes come from the engine or from GitHub.

To opt into the slim variant, edit your `docker-compose.prod.yml`:

```yaml
engine:
  image: registry.digitalocean.com/subkit/engine:${ENGINE_VERSION:-latest}
```

## Next steps

- [docs/05-connectors.md](../05-connectors.md) — connector management, credentials, OAuth2, and private-network tunnels.
- [docs/07-security-governance.md](../07-security-governance.md) — RBAC, identity setup (OIDC/SSO), API key rotation, and Before-Request Hooks.
- [docs/08-operations.md](../08-operations.md) — observability, resource limits, self-healing, and backup strategy.
