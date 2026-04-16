# 32 — Deployment

The engine ships as a single Bun-compiled binary that runs next to a Postgres instance. There is no application server, no language runtime to install, and no GUI. A small `docker-compose.yml` is the canonical local and small-production layout. The Tunnel agent is a separate distributable binary that runs on the customer side and is **not** part of the engine compose file.

## Compiling the binary

The engine compiles with one command per target triple. Trade-off: per-triple compilation multiplies build time, but the resulting artifact has zero runtime dependencies, which is what customers actually want.

```sh
# Linux x64
bun build --compile --target=bun-linux-x64 ./src/index.ts --outfile=workflow-engine-linux-x64

# Linux arm64
bun build --compile --target=bun-linux-arm64 ./src/index.ts --outfile=workflow-engine-linux-arm64

# macOS x64
bun build --compile --target=bun-darwin-x64 ./src/index.ts --outfile=workflow-engine-darwin-x64

# macOS arm64
bun build --compile --target=bun-darwin-arm64 ./src/index.ts --outfile=workflow-engine-darwin-arm64

# Windows x64
bun build --compile --target=bun-windows-x64 ./src/index.ts --outfile=workflow-engine-windows-x64.exe
```

The Tunnel agent compiles from the same codebase with a separate entry point:

```sh
bun build --compile --target=bun-linux-x64 ./src/agent.ts --outfile=tunnel-agent-linux-x64
```

### macOS: ad-hoc code signing

Bun-compiled binaries carry no code signature. On recent macOS (especially Apple Silicon) Apple Mobile File Integrity (AMFI) refuses to launch any unsigned executable with "completely unsigned code" and terminates the process before `main` runs. This is distinct from the Gatekeeper quarantine flag set by Safari downloads — it applies to any unsigned binary, including ones compiled locally. Only ad-hoc code signing fixes it.

The repo ships a helper at `scripts/codesign-macos.sh` that ad-hoc signs a Mach-O with a synthetic identity and no-ops on non-Darwin hosts. The `build:engine`, `build:agent`, and `build:cli` package scripts chain it in automatically, so `bun run build:all` produces launchable binaries on macOS with no additional steps. Trade-off: ad-hoc signing is enough for local dev and trusted internal hosts, but public distribution still requires a real Developer ID signature plus notarization through Apple.

There is one Bun-specific quirk worth knowing about: a plain `codesign --sign - --force` on a freshly compiled Bun binary fails with `invalid or unsupported format for signature`, even though the Mach-O carries an `LC_CODE_SIGNATURE` load command. Calling `codesign --remove-signature` first resets the signature region and lets the subsequent sign succeed. The helper script does both steps. To sign an out-of-band binary manually:

```sh
codesign --remove-signature path/to/binary 2>/dev/null || true
codesign --sign - --force path/to/binary
codesign -dv path/to/binary 2>&1 | grep Signature   # expect: Signature=adhoc
```

## Container image

The container image is a distroless / scratch base with the compiled binary copied in. There is no shell, no package manager, and no language runtime in the runtime image. Trade-off: distroless images make container debugging harder (no `sh` to exec into) and pay back by shrinking the attack surface to almost nothing.

```dockerfile
# Dockerfile
FROM oven/bun:1 AS build
WORKDIR /src
COPY bun.lockb package.json ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun build --compile --target=bun-linux-x64 ./src/index.ts --outfile=/out/workflow-engine

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /out/workflow-engine /workflow-engine
USER nonroot
EXPOSE 8080
ENTRYPOINT ["/workflow-engine"]
```

## docker-compose layout

The compose file pins images to immutable digests. MinIO and `dockerd` are optional and gated by the `with-storage` and `with-sandbox` profiles respectively. Trade-off: profiles add a layer of indirection but let the same file serve both the minimal "just app + Postgres" and the full "app + Postgres + storage + custom-tool sandbox" cases.

```yaml
# docker-compose.yml
services:
  app:
    image: ghcr.io/example/workflow-engine@sha256:...
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://engine:engine@postgres:5432/engine
      MASTER_KEY: ${MASTER_KEY}
      LLM_PRIMARY: ${LLM_PRIMARY}
      LLM_FALLBACK: ${LLM_FALLBACK}
      PUBLIC_BASE_URL: ${PUBLIC_BASE_URL}
      PORT: "8080"
    ports: ["8080:8080"]
    healthcheck:
      test: ["CMD", "/workflow-engine", "healthcheck"]
      interval: 10s
      timeout: 3s
      retries: 5
    networks: [internal]

  postgres:
    image: postgres:16@sha256:...
    environment:
      POSTGRES_USER: engine
      POSTGRES_PASSWORD: engine
      POSTGRES_DB: engine
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U engine"]
      interval: 5s
      retries: 10
    networks: [internal]

  minio:
    image: minio/minio@sha256:...
    profiles: [with-storage]
    command: ["server", "/data"]
    environment:
      MINIO_ROOT_USER: ${S3_ACCESS_KEY}
      MINIO_ROOT_PASSWORD: ${S3_SECRET_KEY}
    volumes: [miniodata:/data]
    networks: [internal]

  dockerd:
    image: docker:25-dind@sha256:...
    profiles: [with-sandbox]
    privileged: true
    environment: { DOCKER_TLS_CERTDIR: "" }
    networks: [internal]

networks:
  internal:

volumes:
  pgdata:
  miniodata:
```

## Environment variables

The engine reads its configuration from environment variables. Per-Tenant and per-Workspace overrides live in the database; the environment carries only what the binary needs to bootstrap.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string. |
| `MASTER_KEY` | 32-byte base64 root key for AES-256-GCM. See `28-security.md`. |
| `LLM_PRIMARY` | Default primary LLM provider id. Per-Tenant override on the `tenants` row. |
| `LLM_FALLBACK` | Default fallback LLM provider id. |
| `S3_ENDPOINT` | Object storage endpoint for payload offload. Optional. |
| `S3_ACCESS_KEY` | Object storage access key. Optional. |
| `S3_SECRET_KEY` | Object storage secret key. Optional. |
| `DOCKER_HOST` | URL of the Docker Engine for the custom-tool sandbox tier. Optional. |
| `PORT` | TCP port the HTTP server binds to. |
| `PUBLIC_BASE_URL` | Externally reachable base URL. Used in webhook URLs, chat deeplinks, OIDC redirect URIs, MCP transport URLs. |
| `SLACK_SIGNING_SECRET` | Slack Events API signing secret. |
| `SLACK_CLIENT_ID` | Slack OAuth client id. |
| `SLACK_CLIENT_SECRET` | Slack OAuth client secret. |
| `TEAMS_APP_ID` | Bot Framework app id (Teams). |
| `TEAMS_APP_PASSWORD` | Bot Framework app password (Teams). |
| `GOOGLE_CHAT_PROJECT_ID` | GCP project id hosting the Google Chat bot. |
| `GOOGLE_CHAT_SERVICE_ACCOUNT_JSON` | Inline service-account JSON for Google Chat. |

**There is no SMTP configuration and no email provider environment variable.** Email is not a notification channel in v1. A Tenant that needs email delivery builds an email Connector itself and drives it from a Workflow.

Per-Workspace chat secrets (Slack bot tokens, Teams credentials, Google Chat tokens) are encrypted in `chat_workspaces` and never live in the environment after the install OAuth flow completes.

## Healthcheck

The engine exposes `GET /v1/health`. The check is shallow (the process is up and the HTTP server is listening) by default, with an optional `?deep=1` mode that also pings Postgres and the configured queue. Trade-off: a deep check makes the orchestrator slower to mark the container ready; the shallow default is the right call for the load-balancer health check, with the deep variant reserved for an operator's own monitoring.

```mermaid
sequenceDiagram
  participant LB as Load balancer
  participant App as Engine
  participant Pg as Postgres
  LB->>App: GET /v1/health
  App-->>LB: 200 {status:"ok"}
  Note over LB,App: shallow default
  LB->>App: GET /v1/health?deep=1
  App->>Pg: SELECT 1
  Pg-->>App: 1
  App-->>LB: 200 {status:"ok",pg:"ok",queue:"ok"}
```

## Graceful shutdown

On `SIGTERM` the engine starts a graceful drain:

1. Stop accepting new HTTP requests on the listener; in-flight requests complete normally.
2. Stop pulling new jobs from `pg-boss`; in-flight jobs run to completion or until the per-job timeout.
3. Flush queued outbound webhook deliveries and chat deliveries; anything that does not flush in time stays on the durable queue and is retried on the next instance.
4. Close the LISTEN connection on the dedicated `pg.Client`. The cursor is persisted so the next instance picks up where this one left off.
5. Send a `tunnel.shutdown` frame to every connected Tunnel agent so the agent reconnects to the next instance instead of timing out.
6. Close the Postgres pool, exit the process.

If the drain does not complete within the shutdown deadline the process is force-killed; the durable queue and the outbox cursor mean restart is still clean.

```mermaid
flowchart TD
  S[SIGTERM] --> A[stop HTTP listener]
  A --> B[drain pg-boss workers]
  B --> C[flush webhook deliveries]
  C --> D[flush chat deliveries]
  D --> E[close LISTEN client]
  E --> F[signal tunnel agents]
  F --> G[exit]
```

## Backup and restore

| Concern | Practice |
|---|---|
| Postgres backup | `pg_dump -Fc` on a schedule. The full state of the engine — Workflows, Connectors, Credentials, Executions, audit log, queues — lives in Postgres. |
| Postgres restore | `pg_restore -d engine` against a fresh database. The engine restarts cleanly because the durable queue and the outbox catch up from the cursor table. |
| Object storage backup | If MinIO is in use, snapshot the `miniodata` volume on the same schedule. The offloaded payloads referenced by `result_storage_uri` live there. |
| Encryption keys | `MASTER_KEY` is **not** in the database backup. It must be backed up separately, in a secret manager, with the same rigor as a TLS private key. |

Trade-off: separating the key from the data is the only safe place to be. A backup that contains both ciphertext and key is no better than plaintext.

## Publishing the Tunnel agent

The Tunnel agent compiles from the same source tree, with `./src/agent.ts` as the entry point and a separate `bun build --compile` invocation per target triple. The agent is published as a standalone binary that customers install on a host inside their private network. It does not ship as a container image because the entire point of the agent is to live on a customer-controlled host with outbound network access to the engine.

```sh
bun build --compile --target=bun-linux-x64    ./src/agent.ts --outfile=tunnel-agent-linux-x64
bun build --compile --target=bun-linux-arm64  ./src/agent.ts --outfile=tunnel-agent-linux-arm64
bun build --compile --target=bun-darwin-x64   ./src/agent.ts --outfile=tunnel-agent-darwin-x64
bun build --compile --target=bun-darwin-arm64 ./src/agent.ts --outfile=tunnel-agent-darwin-arm64
bun build --compile --target=bun-windows-x64  ./src/agent.ts --outfile=tunnel-agent-windows-x64.exe
```

The CLI surfaces it as `subkit tunnel-agent run`, but the underlying binary is shippable on its own for customers who do not want the full CLI on the agent host. Trade-off: shipping a separate agent binary adds release surface; the gain is that the agent has a tiny attack profile and zero engine dependencies.
