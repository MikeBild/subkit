# 03 — Architecture

The engine is a single Bun-compiled binary organized into layers. Edge protocols (REST, MCP, inbound webhooks, chat adapters, tunnel endpoints) funnel every request through a single Auth Provider chain that resolves a Principal; the Principal then flows into a Policy check before domain services touch any state. Domain services mutate Postgres inside transactions that also write to the outbox; the Execution Engine walks Workflow DAGs and dispatches Step work to in-process sandboxes, Docker sandboxes, or Connector Drivers. Background work is scheduled through pg-boss queues and cron, and pub/sub happens through Postgres LISTEN/NOTIFY fed by the outbox. Outbound surfaces — webhook deliveries, chat deliveries, tunnel egress — are just consumers of those queues.

## System diagram

```mermaid
flowchart TB
  subgraph Edge["Edge"]
    REST[REST]
    MCP[MCP]
    WHIN[Webhook Inbound]
    CHAT[Chat Adapters]
    TUN[Tunnel Endpoint]
  end

  subgraph Identity["Identity"]
    CHAIN[Auth Provider Chain]
  end

  subgraph PolicyLayer["Policy"]
    POL[Policy Evaluator]
    HOOK[Before-Request Hook]
  end

  subgraph Services["Domain Services"]
    WF[Workflows]
    CN[Connectors]
    SK[Skills]
    CV[Conversations]
    SC[Schedules]
    ID[Identity]
    EV[Events]
  end

  subgraph Engine["Execution Engine"]
    STEP[Step Runner]
  end

  subgraph Async["Queues and Pub/Sub"]
    PGB[pg-boss Queues]
    CRON[Cron Reconciler]
    OUT[Outbox + LISTEN/NOTIFY]
  end

  subgraph Sandboxes["Sandboxes"]
    QJS[QuickJS-WASM]
    DKR[Docker]
  end

  subgraph Drivers["Connector Drivers"]
    HTTP[HTTP]
    PG[Postgres]
    S3[S3]
    GQL[GraphQL]
  end

  subgraph AI["LLM and Context"]
    CTX[Context Enhancement]
    LLM[LLM Router]
  end

  subgraph Outbound["Outbound"]
    WHO[Webhook Outbound]
    CHD[Chat Deliveries]
    TEG[Tunnel Egress]
  end

  DB[(PostgreSQL)]

  REST --> CHAIN
  MCP --> CHAIN
  WHIN --> CHAIN
  CHAT --> CHAIN
  TUN --> CHAIN
  CHAIN --> POL
  POL --> Services
  Services --> DB
  Services --> Engine
  Engine --> HOOK
  HOOK --> Drivers
  Engine --> Sandboxes
  Drivers -->|through tunnel| TEG
  Engine --> AI
  Services --> Async
  Async --> DB
  Async --> Engine
  Async --> Outbound
```

## Sequence: scheduled workflow run

```mermaid
sequenceDiagram
  participant Cron as Cron Reconciler
  participant Q as pg-boss (execution.run)
  participant Eng as Step Runner
  participant DB as Postgres
  participant Drv as Connector Driver

  Cron->>DB: reconcile schedules
  Cron->>Q: enqueue execution.run job
  Q->>Eng: deliver job
  Eng->>DB: insert Execution (queued -> running)
  loop each Step
    Eng->>Drv: execute request/transform/call
    Drv-->>Eng: response or error
    Eng->>DB: write execution_step row
  end
  Eng->>DB: Execution succeeded, write outbox Event
  DB-->>Eng: NOTIFY execution.status
```

## Sequence: inbound-webhook-triggered workflow run

```mermaid
sequenceDiagram
  participant Ext as External System
  participant Edge as /v1/hooks/:slug
  participant Auth as Auth Provider Chain
  participant Ver as Signature Verifier
  participant DB as Postgres
  participant Q as pg-boss (execution.run)
  participant Eng as Step Runner

  Ext->>Edge: POST signed payload
  Edge->>Auth: resolve principal (tenant-scoped webhook)
  Edge->>Ver: verify Standard Webhooks or connector-native
  Ver-->>Edge: ok
  Edge->>DB: dedup by replay id
  Edge->>Q: enqueue execution.run with request_source=webhook
  Edge-->>Ext: 202 Accepted
  Q->>Eng: deliver job
  Eng->>DB: run workflow, write outbox Event
```

## Sequence: conversational authoring inside a chat thread

```mermaid
sequenceDiagram
  participant U as User in Slack
  participant Ad as Chat Adapter
  participant CS as Chat Session
  participant Cv as Conversation
  participant LLM as LLM Router
  participant Eng as Step Runner
  participant DB as Postgres

  U->>Ad: @bot create workflow that fetches invoices
  Ad->>DB: resolve Chat Identity, Chat Workspace
  Ad->>CS: bind thread to Chat Session
  CS->>Cv: attach or create Conversation
  Cv->>LLM: stream turn with assembled Context Enhancement
  loop tool-use loop (stepCountIs)
    LLM-->>Cv: tool call (propose_step / dry_run_step / ...)
    Cv->>Eng: execute dry_run_step
    Eng-->>Cv: preview result
    Cv-->>Ad: progressive message edit
  end
  LLM-->>Cv: request_human_approval
  Cv->>Ad: post approval card
  U->>Ad: click Approve
  Ad->>Cv: resume with decision
  Cv->>LLM: commit_draft
  Cv->>DB: write new Workflow Version + outbox Event
```

## Sequence: self-healing patch proposal and safe-patch auto-apply

```mermaid
sequenceDiagram
  participant Eng as Step Runner
  participant DB as Postgres
  participant Ing as Doc Ingestion
  participant LLM as LLM Router
  participant Fx as Execution Fixture
  participant Q as pg-boss (workflow.repair)
  participant Ad as Chat Adapter

  Eng->>DB: step failed with drift signal
  Eng->>Q: enqueue workflow.repair
  Q->>Ing: refresh connector docs
  Q->>LLM: bounded repair loop (update_field_path, rename_param, ...)
  LLM-->>Q: candidate patch
  Q->>Fx: dry-run candidate against fixture
  Fx-->>Q: ok
  Q->>DB: write Patch Candidate (classification=safe)
  alt classification=safe
    Q->>DB: auto-apply to Workflow Version
    Q->>DB: outbox Event patch.applied
  else classification=unsafe
    Q->>DB: park Patch Candidate for review
    Q->>Ad: Notification Rule: patch.proposed
  end
```

## Sequence: API-key rotation with overlap window

```mermaid
sequenceDiagram
  participant Adm as Admin (CLI)
  participant API as /v1/identity/api-keys
  participant DB as Postgres
  participant Caller as External Caller

  Adm->>API: POST rotate with overlap_seconds
  API->>DB: insert new api_key row with rotated_from_id
  API-->>Adm: return new token (displayed once)
  par within overlap window
    Caller->>API: request with old token
    API->>DB: verify by prefix + sha256
    API-->>Caller: ok, async flush last_used_at
  and
    Caller->>API: request with new token
    API->>DB: verify by prefix + sha256
    API-->>Caller: ok
  end
  Note over API,DB: after overlap_seconds, old api_key row is revoked automatically
  API->>DB: outbox Event apikey.rotated
```

## Boot sequence

The process starts by validating environment variables against a Zod schema and failing fast on any missing or malformed value. It then opens a Postgres connection pool and runs pending migrations. Once the schema is current, the Auth Provider registry imports every enabled provider file, each provider declares its capability surface, and the registry orders the chain per edge. pg-boss initializes its internal tables and starts its queue workers. The Cron Reconciler then walks every Schedule row and aligns it with pg-boss's cron registry so that schedule writes made while the engine was offline are not lost. The MCP server mounts onto the Hono router, the HTTP server binds and starts listening, and finally a dedicated `pg.Client` opens a LISTEN connection for every outbox channel and begins draining any events produced while the listener was offline by querying `events` rows whose id exceeds the `outbox_cursors` watermark.

```ts
// illustrative boot outline (not production code)
async function boot() {
  const env = validateEnv(process.env);                       // zod schema, fail fast
  const db = await connectPostgres(env.DATABASE_URL);
  await runMigrations(db);
  const auth = new AuthProviderRegistry();
  await auth.loadEnabled(env.AUTH_PROVIDERS);
  const boss = new PgBoss(env.DATABASE_URL);
  await boss.start();
  await reconcileSchedules(db, boss);
  const app = buildHonoApp(db, auth, boss);
  mountMcpServer(app, db, auth);
  const server = Bun.serve({ port: env.PORT, fetch: app.fetch });
  await openOutboxListener(db);                               // LISTEN + catch-up
  return { db, boss, server };
}
```
