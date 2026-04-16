# subkit — Documentation

subkit is a headless backend workflow engine. It runs as a single Bun-compiled binary next to PostgreSQL, exposes REST, MCP, CLI, Chat Adapters (Slack, Microsoft Teams, Google Chat), inbound and outbound Webhooks, and private-network Tunnels, and is authored conversationally with AI-assisted drafting and human-in-the-loop approval. It has no GUI, no visual builder, and no email channel. Everything a workflow needs — connectors, credentials, schedules, skills, conversations, self-healing patches, events, audit logs — lives in Postgres, and every operator-facing surface is agent-friendly.

---

## The Four Binaries

subkit ships four standalone binaries. Each is compiled with `bun build --compile` into a single-file executable with zero runtime dependencies.

| Binary | Who it's for | What it does |
|--------|-------------|--------------|
| **`engine`** | Server operators, self-hosters | The workflow engine itself. Runs the HTTP API, MCP server, job queue, scheduler, chat adapters, and tunnel endpoint. Deployed as a Docker image (production) or run directly as a binary (local dev, bare-metal). Requires PostgreSQL. |
| **`sk`** | End users, admins, portal customers | Interactive REPL modeled after Claude Code. Conversational interface into the engine with persona-aware permissions, slash commands, headless mode (`sk -p "..."`), MCP proxy, `SUBKIT.md` memory, and session management. |
| **`subkit`** | Operators, CI pipelines, DevOps | Noun-verb command surface for managing the engine: `subkit workflows list`, `subkit connectors test`, `subkit credentials rotate`, `subkit chat`. Used in scripts, automation, and operator dashboards. |
| **`tunnel-agent`** | On-prem / private-network hosts | WebSocket agent that runs inside a customer's private network and tunnels HTTP requests from the engine to internal services. No engine dependencies — ships as a standalone binary. |

All four binaries share the same version, are released together from the same GitHub Release, and are available for all platforms (macOS, Linux, Windows).

---

## Installing the CLIs (`sk` and `subkit`)

### Quick Install (recommended)

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/mikebild/subkit/main/scripts/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/mikebild/subkit/main/scripts/install.ps1 | iex
```

The install script:
1. Detects your OS (macOS, Linux, Windows) and architecture (x64, ARM64)
2. Downloads `sk` and `subkit` from the latest GitHub Release
3. Downloads `SHA256SUMS` and verifies every binary's checksum
4. Signs binaries on macOS (ad-hoc codesign for AMFI compliance)
5. Installs to `~/.subkit/bin/` (Unix) or `%LOCALAPPDATA%\subkit\bin\` (Windows)
6. Prints PATH setup instructions if the install directory is not on your PATH

Override the install directory:

```bash
SUBKIT_INSTALL_DIR=/usr/local/bin curl -fsSL https://raw.githubusercontent.com/mikebild/subkit/main/scripts/install.sh | bash
```

### Manual Install

Download the correct binary for your platform from the [latest release](https://github.com/mikebild/subkit/releases/latest):

**macOS (Apple Silicon):**
```bash
curl -fsSL -o sk https://github.com/mikebild/subkit/releases/latest/download/sk_darwin_arm64
curl -fsSL -o subkit https://github.com/mikebild/subkit/releases/latest/download/subkit_darwin_arm64
chmod +x sk subkit
codesign --sign - --force sk subkit
sudo mv sk subkit /usr/local/bin/
```

**macOS (Intel):**
```bash
curl -fsSL -o sk https://github.com/mikebild/subkit/releases/latest/download/sk_darwin_x64
curl -fsSL -o subkit https://github.com/mikebild/subkit/releases/latest/download/subkit_darwin_x64
chmod +x sk subkit
codesign --sign - --force sk subkit
sudo mv sk subkit /usr/local/bin/
```

**Linux (x86_64):**
```bash
curl -fsSL -o sk https://github.com/mikebild/subkit/releases/latest/download/sk_linux_x64
curl -fsSL -o subkit https://github.com/mikebild/subkit/releases/latest/download/subkit_linux_x64
chmod +x sk subkit
sudo mv sk subkit /usr/local/bin/
```

**Linux (ARM64):**
```bash
curl -fsSL -o sk https://github.com/mikebild/subkit/releases/latest/download/sk_linux_arm64
curl -fsSL -o subkit https://github.com/mikebild/subkit/releases/latest/download/subkit_linux_arm64
chmod +x sk subkit
sudo mv sk subkit /usr/local/bin/
```

**Windows (PowerShell):**
```powershell
New-Item -ItemType Directory -Force -Path "$env:LOCALAPPDATA\subkit\bin" | Out-Null
Invoke-WebRequest -Uri "https://github.com/mikebild/subkit/releases/latest/download/sk_windows_x64.exe" -OutFile "$env:LOCALAPPDATA\subkit\bin\sk.exe"
Invoke-WebRequest -Uri "https://github.com/mikebild/subkit/releases/latest/download/subkit_windows_x64.exe" -OutFile "$env:LOCALAPPDATA\subkit\bin\subkit.exe"
# Add to PATH:
[Environment]::SetEnvironmentVariable('PATH', "$env:LOCALAPPDATA\subkit\bin;" + [Environment]::GetEnvironmentVariable('PATH', 'User'), 'User')
```

### Installing the Engine Binary

The engine binary is for operators who want to run subkit directly on a host without Docker. It requires a PostgreSQL instance.

```bash
# Linux x64 (most common for servers)
curl -fsSL -o engine https://github.com/mikebild/subkit/releases/latest/download/engine_linux_x64
chmod +x engine
sudo mv engine /usr/local/bin/

# macOS (local development)
curl -fsSL -o engine https://github.com/mikebild/subkit/releases/latest/download/engine_darwin_arm64
chmod +x engine
codesign --sign - --force engine
sudo mv engine /usr/local/bin/
```

For production deployments, Docker is the recommended approach (see [Backend System](#backend-system--install-configure-and-auto-update) below). The binary is published for all platforms but the Docker path provides migration management, Caddy TLS, and automated deploy/rollback.

### Installing the Tunnel Agent

The tunnel agent is installed separately on hosts inside the customer's private network. It is not needed on developer machines.

```bash
# Linux x64 (most common for on-prem)
curl -fsSL -o tunnel-agent https://github.com/mikebild/subkit/releases/latest/download/tunnel-agent_linux_x64
chmod +x tunnel-agent
sudo mv tunnel-agent /usr/local/bin/
```

All platform variants (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `windows-x64`) are available on the [releases page](https://github.com/mikebild/subkit/releases/latest).

---

## Setting Up the CLIs

### `sk` — end-user CLI

`sk` stores profiles in `~/.sk/config.json`. Each profile holds an engine URL, API key, and active tenant.

**API key login** (scripted / CI):
```bash
sk login --engine-url https://your-engine.example.com --api-key <key>
```

**Browser-based login** (Firebase / OIDC — opens a browser window):
```bash
sk login --engine-url https://your-engine.example.com
```

**Portal token login** (for portal-locked end users):
```bash
sk login --engine-url https://your-engine.example.com --portal-token <token>
```

**Verify the connection:**
```bash
sk status
```

**Multiple profiles:**
```bash
sk login --engine-url https://staging.example.com --api-key <key> --profile staging
sk login --engine-url https://prod.example.com    --api-key <key> --profile prod

# Switch profiles per invocation
sk status --profile staging
sk -p "list workflows" --profile prod
```

**Environment variable overrides** (highest priority):
```bash
export SUBKIT_ENGINE_URL=https://your-engine.example.com
export SUBKIT_API_KEY=sk_live_abc123
sk status   # uses env vars, ignores profile
```

### `subkit` — operator CLI

`subkit` stores profiles in `~/.subkit/config.json` with the same format and precedence as `sk`.

```bash
# Login
subkit login --engine-url https://your-engine.example.com --api-key <key>

# Or OIDC device flow (opens browser)
subkit login --engine-url https://your-engine.example.com

# Verify
subkit health
subkit profile show
```

**Manage named profiles:**
```bash
subkit profile set staging --engine-url https://staging.example.com --api-key <key>
subkit profile use staging
subkit profile list
```

### `tunnel-agent` — tunnel connectivity

The tunnel agent runs as a long-lived process on a host with access to internal services:

```bash
tunnel-agent \
  --engine-url wss://subkit-tunnel.your-domain.com \
  --api-key wf_live_abc123 \
  --targets "my-api=http://localhost:3000/,internal-svc=http://10.0.0.5:8080/"
```

**Environment variable configuration** (for systemd / container deploys):
```bash
export SUBKIT_ENGINE_URL=wss://subkit-tunnel.your-domain.com
export SUBKIT_API_KEY=wf_live_abc123
export SUBKIT_TARGETS="my-api=http://localhost:3000/"
tunnel-agent
```

**Updating the agent:**
```bash
tunnel-agent --self-update   # downloads new binary, exits — restart via systemd
```

The agent also checks for updates on startup and every 24 hours while running. It logs a structured warning when a newer version is available but never auto-restarts.

---

## Auto-Update (OTA)

All four binaries have built-in OTA (over-the-air) updates from GitHub Releases.

### Startup notification

On every invocation, the CLI checks GitHub for a newer version in the background (at most once per 24 hours, cached in `~/.sk/update-check.json` or `~/.subkit/update-check.json`). The check is non-blocking and never delays CLI startup. If a newer version is found, a banner is printed to stderr:

```
  Update available: 0.2.0
  Run `sk update` to install the latest version.
```

The notification does not interfere with piped output or JSON mode.

### Manual update

```bash
sk update              # update sk to latest stable
subkit update          # update subkit to latest stable
engine --self-update   # update engine binary, then restart
tunnel-agent --self-update  # update tunnel agent, then restart
```

**Options (CLIs):**
| Flag | Effect |
|------|--------|
| `--force` | Re-download even if already at the latest version |
| `--channel beta` | Include pre-release versions from GitHub |

### Update capabilities per binary

| Binary | Startup check | `update` / `--self-update` | Periodic re-check | Health endpoint |
|--------|:---:|:---:|:---:|:---:|
| `sk` | background, banner on stderr | `sk update` | via startup (24h cache) | n/a |
| `subkit` | background, banner on stderr | `subkit update` | via startup (24h cache) | n/a |
| `engine` | background, structured log | `engine --self-update` | via startup (24h cache) | `/v1/health` → `update_available`, `latest_version` |
| `tunnel-agent` | background, structured log | `tunnel-agent --self-update` | every 24h (long-running) | n/a |

### What the update does

1. Queries `https://api.github.com/repos/mikebild/subkit/releases/latest`
2. Compares the remote version against the running binary's embedded version
3. Downloads the correct binary for the current OS/architecture (e.g. `sk_darwin_arm64`)
4. Downloads `SHA256SUMS` and verifies the binary's hash before installation
5. On macOS: ad-hoc codesigns the downloaded binary
6. Atomically replaces the running binary (rename current to `.bak`, move new in, remove `.bak`)
7. On Windows: renames the running `.exe` to `.old` (Windows allows rename of locked executables), writes the new binary, cleans up `.old` on next run

**For server binaries** (`engine`, `tunnel-agent`): `--self-update` downloads the new binary and exits. The operator restarts the process via systemd, supervisor, or manually. The server never auto-restarts itself.

**Permissions:** If the binary lives in a root-owned directory (e.g. `/usr/local/bin/`), the updater detects the permission error and prints `run with sudo: sudo sk update`. On Windows: `run as Administrator`.

### Engine health endpoint — update info

When the engine starts, it checks GitHub for a newer version in the background. The result is exposed in the health endpoint:

```bash
curl -s https://your-engine.example.com/v1/health | jq
```

```json
{
  "status": "ok",
  "version": "1.2.3",
  "db_connected": true,
  "uptime_seconds": 3600,
  "update_available": true,
  "latest_version": "1.3.0"
}
```

The `update_available` and `latest_version` fields appear once the background check completes. Use this in monitoring dashboards to detect version drift.

### Disable auto-check

Set the environment variable `NO_UPDATE_CHECK=1` to suppress the startup version check entirely.

---

## Backend System — Install, Configure, and Auto-Update

The engine can be deployed in two ways:

| Method | Best for | Auto-update |
|--------|----------|-------------|
| **Docker Compose** (recommended) | Production, staging | Fully automated via GitHub Actions — tag a release, the pipeline builds, deploys, health-checks, and rolls back on failure |
| **Standalone binary** | Local development, bare-metal, edge | `engine --self-update` downloads the latest binary, operator restarts |

### Running the Engine Binary Directly

For local development or bare-metal deployments without Docker:

```bash
# 1. Download the engine binary
curl -fsSL -o engine https://github.com/mikebild/subkit/releases/latest/download/engine_linux_x64
chmod +x engine

# 2. Start PostgreSQL (any method)
# e.g. docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=subkit postgres:16-alpine

# 3. Configure environment
export DATABASE_URL=postgres://subkit:subkit@localhost:5432/subkit
export MASTER_KEY=$(openssl rand -hex 32)
export LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...
export PORT=3000

# 4. Run migrations and start
./engine
```

The binary reads all configuration from environment variables (see [Backend Configuration](#backend-configuration) below). It exposes the same HTTP API, MCP server, job queue, and tunnel endpoint as the Docker deployment.

**Version:** The engine binary embeds its version at compile time. Check it via the health endpoint:

```bash
curl -s http://localhost:3000/v1/health | jq .version
```

Or set `ENGINE_VERSION` as an environment variable to override (this is how the Docker image sets its version).

### Docker Compose Deployment (Production)

### Infrastructure Bootstrap

The `scripts/do-bootstrap.sh` script idempotently provisions the entire infrastructure on DigitalOcean:

```bash
export DO_TOKEN=dop_v1_...         # DigitalOcean API token
export ANTHROPIC_API_KEY=sk-ant-... # for seeding .env on the droplet
./scripts/do-bootstrap.sh
```

**What it provisions:**
1. **Container Registry** — `registry.digitalocean.com/subkit/` for engine and migrate images
2. **SSH key** — uploads `~/.ssh/subkit_deploy.pub` to DigitalOcean
3. **Droplet** — `s-2vcpu-4gb` in `fra1`, Docker pre-installed (`docker-20-04` image)
4. **DNS** — A records for `subkit-api.mikebild.dev` and `subkit-tunnel.mikebild.dev`
5. **Firewall** — ports 22 (SSH), 80 (HTTP redirect), 443 (HTTPS + HTTP/3)
6. **Deploy files** — copies `docker-compose.yml`, `docker-compose.prod.yml`, and `Caddyfile` to `/opt/subkit/`
7. **Environment** — seeds `.env` from `.env.example` (operator must edit with real secrets)
8. **doctl** — installs the DigitalOcean CLI on the droplet and authenticates against DOCR

**Customizable via environment variables:**

| Variable | Default | Purpose |
|----------|---------|---------|
| `REGION` | `fra1` | DigitalOcean region |
| `SIZE` | `s-2vcpu-4gb` | Droplet size |
| `DROPLET_NAME` | `subkit-engine` | Droplet hostname |
| `DOMAIN_ROOT` | `mikebild.dev` | DNS zone |
| `HOST_API` | `subkit-api` | Subdomain for the engine API |
| `HOST_TUNNEL` | `subkit-tunnel` | Subdomain for the tunnel endpoint |

### Backend Configuration

After bootstrap, SSH into the droplet and edit `/opt/subkit/.env`:

```bash
ssh -i ~/.ssh/subkit_deploy root@<droplet-ip> 'vi /opt/subkit/.env'
```

**Required secrets:**

| Variable | How to generate |
|----------|----------------|
| `MASTER_KEY` | `openssl rand -hex 32` — 32-byte AES-256-GCM encryption key |
| `POSTGRES_PASSWORD` | strong random password (also update `DATABASE_URL`) |
| `ANTHROPIC_API_KEY` | from console.anthropic.com |

**Optional integrations:**

| Variable | Purpose |
|----------|---------|
| `FIREBASE_PROJECT_ID` / `FIREBASE_LOGIN_URL` | Browser-based auth via Firebase |
| `SLACK_SIGNING_SECRET` / `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | Slack chat adapter |
| `TEAMS_APP_ID` / `TEAMS_APP_PASSWORD` | Microsoft Teams chat adapter |
| `GOOGLE_CHAT_PROJECT_ID` | Google Chat adapter |
| `S3_ENDPOINT` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` | S3-compatible object storage for large payloads |
| `CADDY_ACME_EMAIL` | Email for Let's Encrypt TLS certificates (required in production) |
| `TUNNEL_ENGINE_URL` | WebSocket URL for tunnel agents (e.g. `wss://subkit-tunnel.mikebild.dev`) |

### First Deploy

Push a git tag or merge a release-please PR:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The `release.yml` GitHub Actions workflow:
1. Runs the full test suite (lint, typecheck, db:migrate, tests)
2. Builds Docker images for engine and migrate, pushes to DOCR
3. Builds 15 CLI binaries across all platforms, uploads to GitHub Release with SHA256SUMS
4. SSHs into the droplet and deploys the new version
5. Runs smoke tests against the live endpoint

**Capture the admin API key** from the first deploy's seed logs:

```bash
ssh -i ~/.ssh/subkit_deploy root@<droplet-ip> \
  'cd /opt/subkit && docker compose -f docker-compose.yml -f docker-compose.prod.yml logs seed'
```

### Backend Auto-Update (OTA)

The backend updates automatically on every GitHub Release via the `release.yml` workflow.

**Deploy sequence:**

```
git tag v1.2.3 → GitHub Actions triggers
  1. Build + push engine:1.2.3 and migrate:1.2.3 to DOCR
  2. SSH into droplet
  3. Pull new images
  4. Run database migrations (abort on failure)
  5. Run seed (idempotent)
  6. Rolling restart: `docker compose up -d --no-deps engine`
  7. Health check loop (30 attempts x 5s = 150s max)
  8. If healthy → restart Caddy, prune old images
  9. If unhealthy → automatic rollback to previous version
  10. Run smoke tests (health endpoint, OpenAPI, providers, TLS)
```

**Automatic rollback:** Before deploying the new version, the workflow captures the currently running engine version. If the health check fails after 150 seconds, it redeploys the previous Docker image. Since every image is tagged with its version in DOCR (`engine:1.2.2`, `engine:1.2.3`), rollback is instantaneous.

**Zero downtime:** Docker Compose replaces the engine container with `up -d --no-deps`. The engine's `HEALTHCHECK` directive ensures Docker only routes traffic to the new container once `/v1/health` returns OK. Caddy reverse-proxies to `engine:3000` and continues serving during the switchover.

**Migration safety:** Drizzle migrations run before the engine restarts. They are forward-only and idempotent. The deploy script checks the migration container's exit code and aborts the entire deploy if migrations fail — the old engine container keeps running.

### GitHub Actions Secrets

Configure these in your repository settings (Settings > Secrets > Actions):

| Secret | Value |
|--------|-------|
| `DIGITALOCEAN_ACCESS_TOKEN` | DigitalOcean API token |
| `DROPLET_HOST` | Droplet IP address |
| `DROPLET_USER` | `root` |
| `DROPLET_SSH_KEY` | Contents of `~/.ssh/subkit_deploy` private key |
| `DEPLOY_URL` | `https://subkit-api.mikebild.dev` (for smoke tests) |

### Manual Backend Operations

**Check engine health:**
```bash
curl -s https://subkit-api.mikebild.dev/v1/health | jq
```

**View engine logs:**
```bash
ssh root@<droplet-ip> 'cd /opt/subkit && docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f engine'
```

**Manual rollback:**
```bash
ssh root@<droplet-ip> 'cd /opt/subkit && export ENGINE_VERSION=1.2.2 && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps engine'
```

**Run smoke tests:**
```bash
./scripts/smoke.sh https://subkit-api.mikebild.dev "1.2.3"
```

---

## Uninstall

### CLIs (macOS / Linux)

```bash
rm -f /usr/local/bin/sk /usr/local/bin/subkit
# or if installed to ~/.subkit/bin:
rm -rf ~/.subkit

# Remove sk config
rm -rf ~/.sk
```

### CLIs (Windows)

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\subkit"
# Remove from PATH:
$path = [Environment]::GetEnvironmentVariable('PATH', 'User')
$path = ($path -split ';' | Where-Object { $_ -notlike '*subkit*' }) -join ';'
[Environment]::SetEnvironmentVariable('PATH', $path, 'User')
```

### Tunnel Agent

```bash
sudo rm -f /usr/local/bin/tunnel-agent
```

### Backend

```bash
ssh root@<droplet-ip> 'cd /opt/subkit && docker compose -f docker-compose.yml -f docker-compose.prod.yml down -v'
# Then destroy the droplet via doctl or the DO console
```

---

## Available Binaries per Release

| Binary | macOS ARM64 | macOS x64 | Linux x64 | Linux ARM64 | Windows x64 |
|--------|:-----------:|:---------:|:---------:|:-----------:|:-----------:|
| `engine` | x | x | x | x | x |
| `sk` | x | x | x | x | x |
| `subkit` | x | x | x | x | x |
| `tunnel-agent` | x | x | x | x | x |

All 20 binaries plus `SHA256SUMS` are published as GitHub Release assets on every tagged release.

---

## Documentation Index

The files below are the single source of truth for the engine's technical concept, architecture, and stack choices. They are grouped by theme and meant to be read in order within a group.

### Foundation

- `01-concept.md` — what the engine is, what shape it takes, what it refuses to be.
- `02-domain-model.md` — glossary of every noun the engine reasons about.
- `03-architecture.md` — layered architecture, core flows, boot sequence.
- `04-data-model.md` — Postgres schema sketches for every entity and the outbox pattern.

### Engine Core

- `05-execution-engine.md` — step state machine, retries, timeouts, cancel, selectors.
- `06-queue-scheduler-pubsub.md` — pg-boss topology, cron reconciliation, LISTEN/NOTIFY outbox.
- `07-streaming-and-reactivity.md` — why native Web Streams and AsyncIterables instead of RxJS.
- `08-sandboxing.md` — QuickJS-WASM and Docker isolation tiers with resource caps.

### Integrations

- `09-connectors.md` — connector abstraction, drivers, OAuth2, dev/prod environments.
- `10-documentation-ingestion.md` — OpenAPI, GraphQL, HTML, Markdown, files, budgets, dedup.
- `13-webhooks.md` — Standard Webhooks inbound and outbound, retry cadence, replay.
- `14-chat-platforms.md` — Slack, Teams, Google Chat as first-class end-user interfaces.
- `15-tunnels.md` — WebSocket agent binary for reaching private-network systems.
- `23-templates.md` — curated connector template registry shipped as data, not code.

### AI Surfaces

- `16-ai-flows.md` — generate, repair, extract, converse flows with model routing and budgets.
- `17-conversations.md` — structured-intent tool loop, approvals, SSE and MCP streaming.
- `18-skills.md` — curated skill records, scopes, retrieval order, explicit non-learning stance.
- `19-self-healing.md` — drift detection, bounded repair loop, execution fixtures, patch candidates.
- `12-mcp-server.md` — MCP surface, transports, progress notifications, result offload cap.

### Operational Surfaces

- `11-identity-and-access.md` — Auth Provider chain, RBAC plus ABAC, before-request hooks.
- `20-versioning-and-history.md` — automatic workflow versioning, history, restore.
- `21-run-search.md` — execution query model with filters and free-text search.
- `22-extract.md` — `/v1/extract` endpoint for pulling structured data from uploaded files.
- `25-streaming-interfaces.md` — SSE as the canonical stream, MCP parallel surface.
- `26-cli.md` — the `subkit` operator CLI command surface and `subkit chat`.
- `27-sk-cli.md` — the `sk` end-user CLI: REPL, headless mode, sessions, slash commands.
- `27-api-surface.md` — REST endpoint table, auth header, request source semantics.

### Platform

- `24-openapi-and-clients.md` — published OpenAPI contract, in-repo typed client, external SDKs.
- `28-security.md` — encryption, tenancy, policy order, supply chain, sandbox posture.
- `29-observability.md` — Prometheus metrics, structured logging, audit trail.
- `30-defaults-and-limits.md` — canonical operational defaults and limits table.
- `31-developer-tooling.md` — Biome, Bun test, testcontainers, CI, optional pre-commit.
- `32-deployment.md` — compile, compose, env, healthcheck, graceful shutdown, backup.
- `33-verification.md` — end-to-end smoke test matrix for a fresh install.
- `34-installation.md` — CLI install, update, and uninstall for all platforms.
