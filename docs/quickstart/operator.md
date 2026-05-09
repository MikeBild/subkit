# Quickstart — Operator

You run sk for your team. Goal: engine up on a real host, one admin key minted, one connector registered. 15 minutes.

> **Just kicking the tires?** The local-dev path (docker compose, no host) is in [docs/quickstart/developer.md](./developer.md). This page assumes you're standing up an actual production host.

## 1. Install the `sk` CLI

```bash
curl -fsSL https://raw.githubusercontent.com/mikebild/subkit/main/scripts/install.sh | bash
```

See [docs/03-input-surfaces.md](../03-input-surfaces.md) for Windows and manual platform installs. The install script may place a `subkit` compatibility alias on disk; the canonical command surface is `sk`.

## 2. Provision the host (4.2.0 systemd-native)

The engine is a single `bun build --compile` binary deployed under systemd; postgres + caddy are apt-installed. No docker required on the host. The bootstrap script handles everything — DNS, firewall, postgres-16, caddy, the `subkit` system user, the systemd unit. Full guide: [docs/operations/deploy.md](../operations/deploy.md).

```bash
git clone https://github.com/mikebild/subkit && cd subkit
# .env.deploy contains DEPLOY_HOST, SSH_KEY_PATH, optional BOOTSTRAP_LLM_*
bash scripts/do-bootstrap.sh   # provisions the host
bash scripts/deploy.sh patch   # builds + ships the engine binary
```

The engine binds 127.0.0.1 only; caddy fronts the public TLS endpoint. Verify:

```bash
curl -s https://${DEPLOY_HOST_FQDN}/v1/health | jq
```

## 3. Mint an admin API key

The first deploy applies migrations on boot but doesn't seed an admin key (no dev-seed in production mode). One-shot mint over SSH:

```bash
ssh -i ${SSH_KEY_PATH} root@${DEPLOY_HOST} \
  "sudo -u subkit -H bash -c 'set -a; . /etc/subkit/.env; set +a; cd /etc/subkit && /usr/local/bin/engine --issue-admin-key'"
```

The `-H` + sourced `.env` + `cd /etc/subkit` are required so the CLI finds `DATABASE_URL` / `MASTER_KEY` and persists `subkit.config.json` under `/etc/subkit`, not `/root`. The key is printed exactly once.

```bash
sk login --engine-url https://${DEPLOY_HOST_FQDN} --api-key <wf_live_…>
```

Bootstrap LLM provider in one settings write (skip if you set `BOOTSTRAP_LLM_*` in `.env.deploy` — the deploy already PUT them):

```bash
sk settings set llm.provider '"anthropic"'
sk settings set llm.providers.anthropic.api_key '"sk-ant-…"'
sk settings set llm.providers.anthropic.model '"claude-sonnet-4-6"'
```

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
- `sk settings configure` — interactive form for every runtime config leaf (database, LLM provider, observability, etc.). See [`subkit.config.example.json`](../../subkit.config.example.json) at the repo root for the full schema with defaults.

## How `curl /install | bash` works against your engine

The engine serves install artifacts at `/install/sk-:platform-:arch`, `/install/agent-:platform-:arch`, and `/install/sha256sums`. Anyone who can reach your engine URL can install the CLI:

```bash
curl -fsSL https://my-engine.example.com/install | bash
```

The script probes `${ENGINE_URL}/install/sk-${os}-${arch}` first; on `200` it streams from there with `x-subkit-sha256` verification against `${ENGINE_URL}/install/sha256sums`. On `404` (the default for 4.2.0 systemd-deployed engines that don't bundle CLI binaries on the host), the script falls back to the matching GitHub Release. Either way `~/.subkit/bin/sk` matches the engine's running version exactly — no version drift.

## Next steps

- [docs/05-connectors.md](../05-connectors.md) — connector management, credentials, and OAuth2.
- [docs/07-security-governance.md](../07-security-governance.md) — RBAC, identity setup (OIDC/SSO), API key rotation, and Before-Request Hooks.
- [docs/08-operations.md](../08-operations.md) — observability, resource limits, self-healing, and backup strategy.
