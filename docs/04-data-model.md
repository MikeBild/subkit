# 04 — Data Model

Every row in the schema follows a small set of conventions. Every table has an `id` primary key, a `tenant_id` foreign key for tenancy isolation (except the `tenants` table itself), a `created_at` timestamp, and an `updated_at` timestamp. Flexible fields — step configuration, prompt assembly output, webhook headers, step inputs and outputs — are stored as `jsonb`. Encrypted columns are always a triple: `ciphertext`, `iv`, and `auth_tag`, written by the AES-256-GCM helper and never decrypted outside the engine. Soft deletion uses a nullable `deleted_at` column where the entity needs a tombstone (Workflows, Connectors, Credentials, Skills); append-only tables (`executions`, `audit_log`, `events`) are never soft-deleted.

The sketches below are illustrative Drizzle-style schema snippets written for this document. They name the columns the engine cares about, not every operational detail.

## Identity and access

### `tenants`
Top tenancy boundary. One row per customer or isolated environment.

```ts
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  display_name: text("display_name").notNull(),
  llm_primary: text("llm_primary"),            // overrides env default
  llm_fallback: text("llm_fallback"),
  llm_monthly_token_budget: bigint("llm_monthly_token_budget", { mode: "number" }),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});
```

Indexes: unique on `slug`.

### `users`
A human identity inside a tenant.

```ts
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull().references(() => tenants.id),
  email: text("email").notNull(),
  role: text("role", { enum: ["admin", "member", "enduser"] }).notNull(),
  oidc_subject: text("oidc_subject"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
  deleted_at: timestamp("deleted_at"),
});
```

Indexes: unique on `(tenant_id, email)`, unique on `(tenant_id, oidc_subject)`.

### `sessions`
App-owned session table. Signed cookies via `jose` reference this row.

```ts
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  user_id: uuid("user_id").notNull().references(() => users.id),
  expires_at: timestamp("expires_at").notNull(),
  revoked_at: timestamp("revoked_at"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});
```

Indexes: `(user_id, expires_at)` for sliding-window lookup.

### `system_accounts`
Non-human principals. Cannot log into any interactive surface.

```ts
export const systemAccounts = pgTable("system_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull().references(() => tenants.id),
  name: text("name").notNull(),
  description: text("description"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
  deleted_at: timestamp("deleted_at"),
});
```

Indexes: unique on `(tenant_id, name)`.

### `api_keys`
Revocable bearer tokens. Stored as `prefix` plus `sha256(token)`.

```ts
export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  user_id: uuid("user_id"),                            // exactly one of user_id or system_account_id
  system_account_id: uuid("system_account_id"),
  prefix: text("prefix").notNull(),                    // public, indexable
  token_sha256: text("token_sha256").notNull(),        // verified constant-time
  scopes: jsonb("scopes").$type<string[]>().notNull(),
  allowed_workflows: jsonb("allowed_workflows").$type<string[]>(),
  allowed_connectors: jsonb("allowed_connectors").$type<string[]>(),
  not_before: timestamp("not_before"),
  expires_at: timestamp("expires_at"),
  last_used_at: timestamp("last_used_at"),             // async flushed
  rotated_from_id: uuid("rotated_from_id"),
  revoked_at: timestamp("revoked_at"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});
```

Indexes: unique on `prefix`, filtered on `(tenant_id, revoked_at)`.

### `portal_tokens`
A scoped flavor of API key bound to a specific end user and an allowlist of workflows.

```ts
export const portalTokens = pgTable("portal_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  enduser_ref: text("enduser_ref").notNull(),          // opaque external id
  prefix: text("prefix").notNull(),
  token_sha256: text("token_sha256").notNull(),
  allowed_workflows: jsonb("allowed_workflows").$type<string[]>().notNull(),
  expires_at: timestamp("expires_at").notNull(),
  revoked_at: timestamp("revoked_at"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});
```

Indexes: unique on `prefix`, `(tenant_id, enduser_ref)`.

### `auth_provider_configs`
Per-tenant Auth Provider configuration rows. Encrypted config for OIDC client secrets lives here.

```ts
export const authProviderConfigs = pgTable("auth_provider_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  provider: text("provider").notNull(),                // "oidc" | "api_key" | future values
  priority: integer("priority").notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  config_ciphertext: bytea("config_ciphertext"),       // encrypted provider-specific config
  config_iv: bytea("config_iv"),
  config_auth_tag: bytea("config_auth_tag"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});
```

Indexes: `(tenant_id, priority)`.

## Workflows and schedules

### `workflows`
The logical handle for a workflow. `current_version_id` points at the active version.

```ts
export const workflows = pgTable("workflows", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  current_version_id: uuid("current_version_id"),
  lifecycle: text("lifecycle", { enum: ["draft", "active", "archived"] }).notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
  deleted_at: timestamp("deleted_at"),
});
```

Indexes: unique on `(tenant_id, slug)`.

### `workflow_versions`
Immutable version history. Every upsert writes a new row.

```ts
export const workflowVersions = pgTable("workflow_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  workflow_id: uuid("workflow_id").notNull().references(() => workflows.id),
  version: integer("version").notNull(),
  dag: jsonb("dag").notNull(),                         // steps + edges + schemas
  author_user_id: uuid("author_user_id"),
  author_system_account_id: uuid("author_system_account_id"),
  note: text("note"),
  created_at: timestamp("created_at").defaultNow().notNull(),
});
```

Indexes: unique on `(workflow_id, version)`, `(tenant_id, workflow_id)`.

### `workflows_schedules`
Cron bindings for workflows, reconciled against pg-boss at boot.

```ts
export const workflowsSchedules = pgTable("workflows_schedules", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  workflow_id: uuid("workflow_id").notNull(),
  cron: text("cron").notNull(),
  timezone: text("timezone").default("UTC").notNull(),
  paused: boolean("paused").default(false).notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});
```

Indexes: `(tenant_id, workflow_id)`.

## Connectors and credentials

### `connectors`
A typed handle for an external system. The `(slug, environment)` composite is the runtime identity.

```ts
export const connectors = pgTable("connectors", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  slug: text("slug").notNull(),
  display_name: text("display_name").notNull(),
  driver: text("driver").notNull(),                    // "http" | "postgres" | "s3" | "graphql" | ...
  base_url: text("base_url"),
  tunnel_id: uuid("tunnel_id"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
  deleted_at: timestamp("deleted_at"),
});
```

Indexes: unique on `(tenant_id, slug)`.

### `connector_environments`
One row per `(connector_id, environment)`. Holds per-environment overrides.

```ts
export const connectorEnvironments = pgTable("connector_environments", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  connector_id: uuid("connector_id").notNull().references(() => connectors.id),
  environment: text("environment", { enum: ["dev", "prod"] }).notNull(),
  overrides: jsonb("overrides"),                       // base_url overrides, headers, etc.
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});
```

Indexes: unique on `(connector_id, environment)`.

### `credentials`
Operator-owned credentials for a connector. Always encrypted.

```ts
export const credentials = pgTable("credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  connector_id: uuid("connector_id").notNull(),
  environment: text("environment", { enum: ["dev", "prod"] }).notNull(),
  mode: text("mode").notNull(),                        // none | header | query | bearer | basic | oauth2
  ciphertext: bytea("ciphertext").notNull(),
  iv: bytea("iv").notNull(),
  auth_tag: bytea("auth_tag").notNull(),
  oauth2_refresh_ciphertext: bytea("oauth2_refresh_ciphertext"),
  oauth2_refresh_iv: bytea("oauth2_refresh_iv"),
  oauth2_refresh_auth_tag: bytea("oauth2_refresh_auth_tag"),
  oauth2_expires_at: timestamp("oauth2_expires_at"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
  deleted_at: timestamp("deleted_at"),
});
```

Indexes: unique on `(connector_id, environment)`. Encryption: AES-256-GCM.

### `end_user_credentials`
Credentials supplied by an end user, combined at runtime with operator credentials in MERGE or REPLACE mode.

```ts
export const endUserCredentials = pgTable("end_user_credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  connector_id: uuid("connector_id").notNull(),
  enduser_ref: text("enduser_ref").notNull(),
  combine_mode: text("combine_mode", { enum: ["merge", "replace"] }).notNull(),
  ciphertext: bytea("ciphertext").notNull(),
  iv: bytea("iv").notNull(),
  auth_tag: bytea("auth_tag").notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});
```

Indexes: unique on `(tenant_id, connector_id, enduser_ref)`. Encryption: AES-256-GCM.

## Skills

### `skills`
Hand-authored LLM context records.

```ts
export const skills = pgTable("skills", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  scope: text("scope", { enum: ["global", "connector", "workflow"] }).notNull(),
  connector_id: uuid("connector_id"),
  workflow_id: uuid("workflow_id"),
  title: text("title").notNull(),
  body: text("body").notNull(),
  examples: jsonb("examples"),
  lifecycle: text("lifecycle", { enum: ["draft", "active", "archived"] }).notNull(),
  version: integer("version").notNull().default(1),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});
```

Indexes: `(tenant_id, scope, connector_id)`, `(tenant_id, scope, workflow_id)`.

## Conversations

### `conversations`
A resumable AI authoring session.

```ts
export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  target_workflow_id: uuid("target_workflow_id"),
  target_connector_id: uuid("target_connector_id"),
  draft: jsonb("draft"),                               // current draft DAG under authoring
  status: text("status", { enum: ["active", "awaiting_approval", "committed", "abandoned"] }).notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});
```

Indexes: `(tenant_id, status)`.

### `conversation_messages`
Per-turn log.

```ts
export const conversationMessages = pgTable("conversation_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  conversation_id: uuid("conversation_id").notNull(),
  role: text("role", { enum: ["user", "assistant", "tool", "system"] }).notNull(),
  content: jsonb("content").notNull(),
  tokens_in: integer("tokens_in"),
  tokens_out: integer("tokens_out"),
  created_at: timestamp("created_at").defaultNow().notNull(),
});
```

Indexes: `(conversation_id, created_at)`.

### `conversation_tool_calls`
Structured-intent tool invocations inside the loop.

```ts
export const conversationToolCalls = pgTable("conversation_tool_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  conversation_id: uuid("conversation_id").notNull(),
  tool: text("tool").notNull(),                        // propose_step, dry_run_step, ...
  input: jsonb("input").notNull(),
  output: jsonb("output"),
  approval_required: boolean("approval_required").default(false).notNull(),
  approved_at: timestamp("approved_at"),
  approved_by_user_id: uuid("approved_by_user_id"),
  created_at: timestamp("created_at").defaultNow().notNull(),
});
```

Indexes: `(conversation_id, created_at)`.

## Executions and repair

### `executions`
Append-only run history.

```ts
export const executions = pgTable("executions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  workflow_id: uuid("workflow_id").notNull(),
  workflow_version_id: uuid("workflow_version_id").notNull(),
  status: text("status", { enum: ["queued", "running", "succeeded", "failed", "aborted", "timed_out"] }).notNull(),
  request_source: text("request_source").notNull(),     // api | cli | scheduler | mcp | webhook | tool-chain | ui
  execution_mode: text("execution_mode", { enum: ["dev", "prod"] }).notNull(),
  parent_execution_id: uuid("parent_execution_id"),
  result_storage_uri: text("result_storage_uri"),      // s3://... when offloaded
  started_at: timestamp("started_at"),
  finished_at: timestamp("finished_at"),
  created_at: timestamp("created_at").defaultNow().notNull(),
});
```

Indexes: `(tenant_id, workflow_id, started_at desc)`, `(tenant_id, status)`, `(tenant_id, request_source)`.

### `execution_steps`
Per-step outcome, preview-truncated.

```ts
export const executionSteps = pgTable("execution_steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  execution_id: uuid("execution_id").notNull(),
  step_key: text("step_key").notNull(),
  kind: text("kind").notNull(),                        // request | transform | call | wait | branch | parallel | loop
  status: text("status").notNull(),
  input_preview: jsonb("input_preview"),               // depth 5, array 5, keys 1000
  output_preview: jsonb("output_preview"),
  error: jsonb("error"),
  started_at: timestamp("started_at"),
  finished_at: timestamp("finished_at"),
});
```

Indexes: `(execution_id, started_at)`.

### `execution_fixtures`
Recorded request/response samples used as the dry-run corpus for self-healing.

```ts
export const executionFixtures = pgTable("execution_fixtures", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  connector_id: uuid("connector_id").notNull(),
  endpoint_key: text("endpoint_key").notNull(),        // method + path template
  request: jsonb("request").notNull(),
  response: jsonb("response").notNull(),
  captured_at: timestamp("captured_at").defaultNow().notNull(),
});
```

Indexes: `(connector_id, endpoint_key)`.

### `schema_versions`
Tracked shape of a connector endpoint over time.

```ts
export const schemaVersions = pgTable("schema_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  connector_id: uuid("connector_id").notNull(),
  endpoint_key: text("endpoint_key").notNull(),
  schema: jsonb("schema").notNull(),                   // canonicalized JSON schema
  seen_at: timestamp("seen_at").defaultNow().notNull(),
});
```

Indexes: `(connector_id, endpoint_key, seen_at desc)`.

### `patch_candidates`
Proposed repairs from the self-healing loop.

```ts
export const patchCandidates = pgTable("patch_candidates", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  workflow_id: uuid("workflow_id").notNull(),
  diff: jsonb("diff").notNull(),                       // structured patch
  classification: text("classification", { enum: ["safe", "unsafe"] }).notNull(),
  fixture_id: uuid("fixture_id"),
  status: text("status", { enum: ["proposed", "applied", "rejected", "superseded"] }).notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});
```

Indexes: `(tenant_id, workflow_id, status)`.

## Before-Request Hooks

### `request_hooks`
Per-role JavaScript hooks evaluated before every outbound `request` Step. Executed in the QuickJS-WASM sandbox.

```ts
export const requestHooks = pgTable("request_hooks", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  role: text("role").notNull(),                        // admin | member | enduser
  source: text("source").notNull(),                    // JS source
  version: integer("version").notNull().default(1),
  enabled: boolean("enabled").default(true).notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});
```

Indexes: `(tenant_id, role, version desc)`.

## Webhooks and subscriptions

### `webhooks_inbound`
Inbound hook endpoints bound to a workflow.

```ts
export const webhooksInbound = pgTable("webhooks_inbound", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  slug: text("slug").notNull(),
  workflow_id: uuid("workflow_id").notNull(),
  verifier: text("verifier").notNull(),                // standard | github | stripe | ...
  secret_ciphertext: bytea("secret_ciphertext").notNull(),
  secret_iv: bytea("secret_iv").notNull(),
  secret_auth_tag: bytea("secret_auth_tag").notNull(),
  active: boolean("active").default(true).notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});
```

Indexes: unique on `(tenant_id, slug)`. Encryption: AES-256-GCM on the secret.

### `subscriptions`
Outbound event subscriptions.

```ts
export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  event_pattern: text("event_pattern").notNull(),     // glob, e.g. execution.*
  target_url: text("target_url").notNull(),
  secret_ciphertext: bytea("secret_ciphertext").notNull(),
  secret_iv: bytea("secret_iv").notNull(),
  secret_auth_tag: bytea("secret_auth_tag").notNull(),
  filters: jsonb("filters"),
  active: boolean("active").default(true).notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});
```

Indexes: `(tenant_id, active)`.

### `webhooks_outbound`
Configured outbound endpoints; usually created from Subscriptions but kept separate when an operator pins signing key rotation metadata per endpoint.

```ts
export const webhooksOutbound = pgTable("webhooks_outbound", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  subscription_id: uuid("subscription_id"),
  signing_keys: jsonb("signing_keys").notNull(),       // multi-key rotation metadata
  circuit_state: text("circuit_state").default("closed").notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});
```

Indexes: `(tenant_id, subscription_id)`.

### `deliveries`
Per-attempt delivery log for outbound webhooks.

```ts
export const deliveries = pgTable("deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  subscription_id: uuid("subscription_id").notNull(),
  event_id: uuid("event_id").notNull(),
  attempt: integer("attempt").notNull(),
  status: text("status").notNull(),                    // pending | delivered | failed | dead_letter
  response_code: integer("response_code"),
  next_retry_at: timestamp("next_retry_at"),
  created_at: timestamp("created_at").defaultNow().notNull(),
});
```

Indexes: `(tenant_id, subscription_id, created_at desc)`, `(status, next_retry_at)`.

## Chat

### `chat_workspaces`
Per-tenant binding to a chat installation.

```ts
export const chatWorkspaces = pgTable("chat_workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  platform: text("platform", { enum: ["slack", "teams", "google_chat"] }).notNull(),
  workspace_id: text("workspace_id").notNull(),
  default_channel: text("default_channel"),
  bot_ciphertext: bytea("bot_ciphertext").notNull(),
  bot_iv: bytea("bot_iv").notNull(),
  bot_auth_tag: bytea("bot_auth_tag").notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});
```

Indexes: unique on `(tenant_id, platform, workspace_id)`. Encryption: AES-256-GCM on bot credentials.

### `chat_identities`
Links a chat-platform user to a tenant User.

```ts
export const chatIdentities = pgTable("chat_identities", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  user_id: uuid("user_id").notNull(),
  platform: text("platform").notNull(),
  workspace_id: text("workspace_id").notNull(),
  platform_user_id: text("platform_user_id").notNull(),
  linked_at: timestamp("linked_at").defaultNow().notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});
```

Indexes: unique on `(platform, workspace_id, platform_user_id)`.

### `chat_sessions`
Thread-to-Conversation binding.

```ts
export const chatSessions = pgTable("chat_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  workspace_id: uuid("workspace_id").notNull(),        // references chat_workspaces.id
  thread_id: text("thread_id").notNull(),
  conversation_id: uuid("conversation_id").notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});
```

Indexes: unique on `(workspace_id, thread_id)`.

### `chat_deliveries`
Outbound chat message queue companion.

```ts
export const chatDeliveries = pgTable("chat_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  workspace_id: uuid("workspace_id").notNull(),
  thread_id: text("thread_id"),
  kind: text("kind").notNull(),                        // message | update | ephemeral | card
  payload: jsonb("payload").notNull(),
  attempt: integer("attempt").default(0).notNull(),
  status: text("status").notNull(),                    // pending | delivered | failed
  created_at: timestamp("created_at").defaultNow().notNull(),
});
```

Indexes: `(workspace_id, status, created_at)`.

## Tunnels

### `tunnels`
A registered WebSocket tunnel session from a customer-side agent.

```ts
export const tunnels = pgTable("tunnels", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  name: text("name").notNull(),
  agent_token_sha256: text("agent_token_sha256").notNull(),
  last_seen_at: timestamp("last_seen_at"),
  state: text("state", { enum: ["registered", "connected", "disconnected"] }).notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});
```

Indexes: unique on `(tenant_id, name)`.

### `tunnel_targets`
Per-target routing entries inside a Tunnel.

```ts
export const tunnelTargets = pgTable("tunnel_targets", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  tunnel_id: uuid("tunnel_id").notNull(),
  target_name: text("target_name").notNull(),
  concurrency_cap: integer("concurrency_cap").default(16).notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});
```

Indexes: unique on `(tunnel_id, target_name)`.

## Audit

### `audit_log`
Immutable record of every identity and policy action.

```ts
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  actor_kind: text("actor_kind").notNull(),            // user | system_account | engine
  actor_id: uuid("actor_id"),
  action: text("action").notNull(),                    // apikey.issue | policy.change | ...
  target_kind: text("target_kind"),
  target_id: uuid("target_id"),
  meta: jsonb("meta"),
  at: timestamp("at").defaultNow().notNull(),
});
```

Indexes: `(tenant_id, at desc)`, `(tenant_id, action)`.

## Outbox

The engine uses the transactional outbox pattern for every externally visible side effect. A domain write and an `events` insert happen in the same transaction; a Postgres `NOTIFY` wakes a dedicated `pg.Client` listener; the listener fans out to the in-process event bus and to outbound queue jobs. On reconnect or cold start, the listener catches up by reading the `outbox_cursors` watermark and selecting any `events` rows whose id exceeds it. The protocol is deliberately simple: `NOTIFY` payloads carry only the event id, so a missed wake-up is harmless — the catch-up query will pick it up, and every consumer is idempotent on `event_id`.

### `events`
The outbox table.

```ts
export const events = pgTable("events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  tenant_id: uuid("tenant_id").notNull(),
  channel: text("channel").notNull(),                  // execution.status | workflow.chain | ...
  type: text("type").notNull(),                        // execution.succeeded | patch.proposed | ...
  payload: jsonb("payload").notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
});
```

Indexes: `(channel, id)`, `(tenant_id, created_at desc)`.

The NOTIFY payload is the smallest possible envelope:

```ts
// emitted from the same transaction as the domain write
await tx.execute(sql`SELECT pg_notify(${channel}, ${String(eventId)})`);
```

### `outbox_cursors`
Per-channel watermark for listener catch-up.

```ts
export const outboxCursors = pgTable("outbox_cursors", {
  channel: text("channel").primaryKey(),
  last_seen_id: bigint("last_seen_id", { mode: "number" }).notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});
```

Replay protocol: on listener startup or after a reconnect the dedicated `pg.Client` reopens every channel with `LISTEN`, then runs `SELECT id, type, payload FROM events WHERE channel = $1 AND id > $2 ORDER BY id` against each cursor, dispatches each row, and advances `last_seen_id` per batch. While the listener is running, NOTIFY wake-ups trigger the same `SELECT id > last_seen_id` query to drain anything the notification may have raced. Consumers dedupe on `event_id` so replay is always safe.
