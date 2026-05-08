# Deploy a sk engine on a Linux host

This guide walks the 4.2.0 systemd-native path: a single `bun build --compile` binary, postgres-16 + caddy via apt, no docker on the host. The example targets a DigitalOcean droplet (Ubuntu 24.04), but every step except the `doctl ...` lines works on any Ubuntu 24.04 host with SSH access.

> **Local dev?** This page is for production hosts. For your laptop, use `bun run compose:up` per [docs/quickstart/developer.md](../quickstart/developer.md).

## What ends up on the host

| Path | Purpose |
|---|---|
| `/usr/local/bin/engine` | The compiled engine binary (~120 MB; replaces docker image). |
| `/etc/subkit/.env` | Operator-edited bootstrap env: `DATABASE_URL`, `MASTER_KEY`, `PUBLIC_BASE_URL`. Mode 600, owned by `subkit`. |
| `/etc/subkit/.pgpass` | Generated postgres password (also referenced by `DATABASE_URL`). |
| `/etc/subkit/subkit.config.json` | Auto-created on first boot; every non-bootstrap setting (LLM provider, observability, etc.) lives here. Hot-reload via `sk settings set`. |
| `/var/lib/subkit/blobs/` | File storage. |
| `/etc/systemd/system/subkit-engine.service` | The systemd unit (lives at [`deploy/systemd/subkit-engine.service`](../../deploy/systemd/subkit-engine.service) in the repo). |
| `/etc/caddy/Caddyfile` | Public TLS termination (lives at [`deploy/caddy/Caddyfile`](../../deploy/caddy/Caddyfile) in the repo). |
| `/etc/ssh/sshd_config.d/subkit.conf` | `AcceptEnv` directives for the bootstrap env vars in [`deploy/bootstrap-env.list`](../../deploy/bootstrap-env.list). |

## One-time bootstrap

`scripts/do-bootstrap.sh` is idempotent — re-running it is a safe no-op once the host is provisioned.

Prerequisites:
- `doctl` installed and authenticated (only for the DO host-create branch; skip if the droplet already exists or you're on AWS/GCP/etc.).
- A registered SSH key on the DO account (or your hosting provider's equivalent).
- A DNS zone you control on DO nameservers (the script creates `subkit-api.<zone>` + `subkit-tunnel.<zone>` A records).

```bash
SSH_KEY_NAME=mikebild-local \
SSH_KEY_PATH=$HOME/.ssh/id_rsa \
DROPLET_NAME=subkit-engine \
DOMAIN_ROOT=mikebild.dev \
bash scripts/do-bootstrap.sh
```

What it does, step by step:

1. Ensures the SSH key is uploaded to the provider.
2. Creates the host (or detects an existing one with the same name).
3. Provisions DNS A records.
4. Creates a cloud firewall (22, 80/443 in; all out).
5. Waits for SSH.
6. apt-installs `postgresql-16` + `caddy` + `jq` + `curl`. Imports caddy's GPG key to `/usr/share/keyrings/caddy-stable-archive-keyring.gpg` (the path cloudsmith's `caddy.list` references).
7. Configures `/etc/ssh/sshd_config.d/subkit.conf` with one `AcceptEnv` per variable from `deploy/bootstrap-env.list`.
8. Creates the `subkit` system user + state dirs.
9. Creates the postgres role + database.
10. Seeds `/etc/subkit/.env` with `DATABASE_URL`, `MASTER_KEY` (random 32-byte hex), `PUBLIC_BASE_URL`.
11. Installs the Caddyfile + reloads caddy.
12. Installs the systemd unit (enabled, NOT started — the first deploy ships the binary).

## Releases

```bash
DEPLOY_HOST=46.101.236.142 \
DEPLOY_USER=root \
SSH_KEY_PATH=$HOME/.ssh/id_rsa \
DEPLOY_URL=https://subkit-api.mikebild.dev \
bash scripts/deploy.sh patch
```

`deploy.sh` runs the local quality gate (lint + typecheck + tests + invariants), bumps the version, builds `dist/engine-linux-x64` via `bun build --compile --target=bun-linux-x64`, scps it to `/usr/local/bin/engine.next`, then pipes `scripts/release/deploy-body.sh` over SSH. Inside `deploy-body.sh`:

1. Atomic swap: rename current binary to `engine.prev`, move `engine.next` to `engine`.
2. `systemctl restart subkit-engine.service`.
3. Poll `/v1/health` for up to 150s waiting for the new `version` to appear. On timeout, restore `engine.prev` and exit non-zero.
4. Reload caddy in case the Caddyfile changed.
5. If `BOOTSTRAP_LLM_*` env is set, PUT `/v1/settings/llm.provider`, `…llm.providers.<provider>.api_key`, etc. Idempotent. The PUT carries two audit-trail headers:
   - `X-Subkit-Audit-Source: deploy_bootstrap` so the audit row distinguishes deploy resets from operator-driven `sk settings set`.
   - `X-Subkit-Deploy-Version: <semver>` so compliance review can answer "which release SHA flipped this LLM key?" without joining outside the audit log.

The bootstrap env list ([`deploy/bootstrap-env.list`](../../deploy/bootstrap-env.list)) is the single source of truth — `do-bootstrap.sh`, `scripts/deploy.sh`, and `.github/workflows/release.yml` all read it. New variables land in one file.

### `BOOTSTRAP_ONLY=1` re-PUTs without binary swap

Set `BOOTSTRAP_ONLY=1` to re-run the `/v1/settings/*` phase without shipping a new binary — useful when an operator added a `BOOTSTRAP_LLM_*` value after the prior release and wants the engine to pick it up without a full deploy cycle. Behavior:

- The binary swap + `systemctl restart` + health-poll + caddy reload steps are skipped.
- `metadata.deploy_version` on the resulting audit row reports the **currently-running** engine's version (read from `/v1/health`), not whatever `ENGINE_VERSION` was set in `.env.deploy`. The intent: a re-PUT against an already-deployed release is attributed to that release in the compliance ledger, not to the next release whose binary hasn't shipped yet.

## First-deploy: mint an admin key

Until you've minted at least one admin key, every `/v1/settings/*` PUT is anonymous → 401. The CLI:

```bash
ssh -i ${SSH_KEY_PATH} root@${DEPLOY_HOST} \
  "sudo -u subkit -H bash -c 'set -a; . /etc/subkit/.env; set +a; cd /etc/subkit && /usr/local/bin/engine --issue-admin-key'"
```

The `-H` is required so `$HOME` becomes `/var/lib/subkit` (sudo otherwise preserves `/root`, which the `subkit` user can't write to). Sourcing `/etc/subkit/.env` provides `DATABASE_URL` + `MASTER_KEY` (the systemd unit reads them via `EnvironmentFile=`, which sudo doesn't pick up). The key is printed exactly once.

```bash
sk login --engine-url https://${DEPLOY_HOST_FQDN} --api-key wf_live_…
```

## Boot-time dependency probes

The engine validates dependencies on boot before serving requests. Each probe emits one structured log line at `module: "observability", action: "boot.dependency.<name>.{ok,fail}"`:

- `runtime` — bun version + platform/arch (informational).
- `crypto_self_test` — encrypts/decrypts a known string with the loaded `MASTER_KEY`. **Blocker.**
- `db_connect` — `SELECT 1`. **Blocker.**
- `db_extensions` — `pgcrypto` presence. Non-blocker (migrations install it on first run).
- `fs_write:<dir>` — for each `STATE_DIRECTORY` + `CONFIGURATION_DIRECTORY` populated by systemd, write+read+unlink a probe file. Non-blocker (local dev runs as the operator's UID and these paths may not exist). Production-only.

Blockers exit 1 with a `boot.dependency.<name>.fail` log; non-blockers continue and are visible via `journalctl -u subkit-engine`.

## Troubleshooting

**`apt update` fails with `NO_PUBKEY ABA1F9B8875A6661`** — caddy's GPG key was dearmored to the wrong path in older bootstrap runs. Fix: `cp /etc/apt/keyrings/caddy.gpg /usr/share/keyrings/caddy-stable-archive-keyring.gpg && apt-get update` (the current `do-bootstrap.sh` writes to the right path; older invocations need this one-shot fixup).

**Caddy fails to reload with `wrong argument count after 'email'`** — `CADDY_ACME_EMAIL` env was unset and the older Caddyfile referenced it without a default. The current Caddyfile uses `email {$CADDY_ACME_EMAIL:mike@mikebild.com}`; sync with `scp deploy/caddy/Caddyfile root@$HOST:/etc/caddy/Caddyfile && ssh root@$HOST systemctl reload caddy`.

**`/v1/diagnostics/llm` reports `inferred_provider: mock`** — the engine boots fine but no LLM key is wired. Set:

```bash
sk settings set llm.provider '"anthropic"'
sk settings set llm.providers.anthropic.api_key '"sk-ant-…"'
sk settings set llm.providers.anthropic.model '"claude-sonnet-4-6"'
```

**Health-check timeout during deploy → rollback** — the previous binary is restored automatically. Inspect `journalctl -u subkit-engine -n 200` to see why the new binary didn't surface a matching `/v1/health version`. Common causes: a migration that crashed (unlikely; migrations have boot tests), a `MASTER_KEY` change that rendered existing rows unreadable, or a port binding collision.

## Re-deploy from scratch

If the host gets into a state you can't reason about, `doctl compute droplet-action rebuild ${DROPLET_ID} --image ubuntu-24-04-x64 --wait` reimages the disk while keeping the droplet ID and IP. DNS stays intact. Postgres state in docker volumes (4.0.x layout) or apt postgres (4.2.0 layout) is wiped — dump first if you need it. After rebuild: `ssh-keygen -R <ip>`, then re-run `do-bootstrap.sh` + `deploy.sh`.
