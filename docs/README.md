# subkit — Documentation

subkit is a headless backend workflow engine. It runs as a single Bun-compiled binary next to PostgreSQL, exposes REST, MCP, CLI, Chat Adapters (Slack, Microsoft Teams, Google Chat), inbound and outbound Webhooks, and private-network Tunnels, and is authored conversationally with AI-assisted drafting and human-in-the-loop approval. It has no GUI, no visual builder, and no email channel. Everything a workflow needs — connectors, credentials, schedules, skills, conversations, self-healing patches, events, audit logs — lives in Postgres, and every operator-facing surface is agent-friendly.

This docs folder is the single source of truth for the engine's technical concept, architecture, and stack choices. The files are grouped by theme and are meant to be read in order within a group.

## Foundation

- `01-concept.md` — what the engine is, what shape it takes, what it refuses to be.
- `02-domain-model.md` — glossary of every noun the engine reasons about.
- `03-architecture.md` — layered architecture, core flows, boot sequence.
- `04-data-model.md` — Postgres schema sketches for every entity and the outbox pattern.

## Engine Core

- `05-execution-engine.md` — step state machine, retries, timeouts, cancel, selectors.
- `06-queue-scheduler-pubsub.md` — pg-boss topology, cron reconciliation, LISTEN/NOTIFY outbox.
- `07-streaming-and-reactivity.md` — why native Web Streams and AsyncIterables instead of RxJS.
- `08-sandboxing.md` — QuickJS-WASM and Docker isolation tiers with resource caps.

## Integrations

- `09-connectors.md` — connector abstraction, drivers, OAuth2, dev/prod environments.
- `10-documentation-ingestion.md` — OpenAPI, GraphQL, HTML, Markdown, files, budgets, dedup.
- `13-webhooks.md` — Standard Webhooks inbound and outbound, retry cadence, replay.
- `14-chat-platforms.md` — Slack, Teams, Google Chat as first-class end-user interfaces.
- `15-tunnels.md` — WebSocket agent binary for reaching private-network systems.
- `23-templates.md` — curated connector template registry shipped as data, not code.

## AI Surfaces

- `16-ai-flows.md` — generate, repair, extract, converse flows with model routing and budgets.
- `17-conversations.md` — structured-intent tool loop, approvals, SSE and MCP streaming.
- `18-skills.md` — curated skill records, scopes, retrieval order, explicit non-learning stance.
- `19-self-healing.md` — drift detection, bounded repair loop, execution fixtures, patch candidates.
- `12-mcp-server.md` — MCP surface, transports, progress notifications, result offload cap.

## Operational Surfaces

- `11-identity-and-access.md` — Auth Provider chain, RBAC plus ABAC, before-request hooks.
- `20-versioning-and-history.md` — automatic workflow versioning, history, restore.
- `21-run-search.md` — execution query model with filters and free-text search.
- `22-extract.md` — `/v1/extract` endpoint for pulling structured data from uploaded files.
- `25-streaming-interfaces.md` — SSE as the canonical stream, MCP parallel surface.
- `26-cli.md` — the `subkit` CLI command surface and the `subkit chat` experience.
- `27-api-surface.md` — REST endpoint table, auth header, request source semantics.

## Platform

- `24-openapi-and-clients.md` — published OpenAPI contract, in-repo typed client, external SDKs.
- `28-security.md` — encryption, tenancy, policy order, supply chain, sandbox posture.
- `29-observability.md` — Prometheus metrics, structured logging, audit trail.
- `30-defaults-and-limits.md` — canonical operational defaults and limits table.
- `31-developer-tooling.md` — Biome, Bun test, testcontainers, CI, optional pre-commit.
- `32-deployment.md` — compile, compose, env, healthcheck, graceful shutdown, backup.
- `33-verification.md` — end-to-end smoke test matrix for a fresh install.
