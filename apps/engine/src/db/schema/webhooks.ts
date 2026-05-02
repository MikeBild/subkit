import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea, tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";
import { workflows } from "./workflows.ts";

// ----- webhooks_inbound -----------------------------------------------------

export const webhooksInbound = pgTable(
  "webhooks_inbound",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    workflow_id: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    verifier: text("verifier").notNull(),
    native_verifier_config: jsonb("native_verifier_config"),
    secret_ciphertext: bytea("secret_ciphertext").notNull(),
    secret_iv: bytea("secret_iv").notNull(),
    secret_auth_tag: bytea("secret_auth_tag").notNull(),
    active: boolean("active").default(true).notNull(),
    /** How the row was provisioned. `crud` rows come from the
     *  authenticated `POST /v1/webhooks/inbound` surface; `trigger`
     *  rows are reverse-bound by the workflow save path
     *  (`bindFromWorkflow`). The fire-time audit surface routes the
     *  new `webhook.trigger.fired` /
     *  `webhook.trigger.failed_verification` actions only for
     *  `trigger` rows; `crud` rows continue to emit the legacy
     *  `webhook.inbound.received` / `webhook.inbound.denied`. */
    origin: text("origin").notNull().default("crud"),
    ...timestamps,
  },
  (t) => [uniqueIndex("webhooks_inbound_tenant_slug_key").on(t.tenant_id, t.slug)],
);

// ----- subscriptions --------------------------------------------------------

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    event_pattern: text("event_pattern").notNull(),
    target_url: text("target_url").notNull(),
    // AES-256-GCM ciphertext (see apps/engine/src/crypto/aes-gcm.ts). Writers call encryptSecret(), readers decryptSecret(), keyed by env.MASTER_KEY.
    secret_ciphertext: bytea("secret_ciphertext").notNull(),
    secret_iv: bytea("secret_iv").notNull(),
    secret_auth_tag: bytea("secret_auth_tag").notNull(),
    rotating_secret_ciphertext: bytea("rotating_secret_ciphertext"),
    rotating_secret_iv: bytea("rotating_secret_iv"),
    rotating_secret_auth_tag: bytea("rotating_secret_auth_tag"),
    filters: jsonb("filters"),
    active: boolean("active").default(true).notNull(),
    circuit_open_until: timestamp("circuit_open_until", { withTimezone: true }),
    consecutive_failures: integer("consecutive_failures").default(0).notNull(),
    ...timestamps,
  },
  (t) => [index("subscriptions_tenant_active_idx").on(t.tenant_id, t.active)],
);

// ----- webhooks_outbound ----------------------------------------------------

export const webhooksOutbound = pgTable(
  "webhooks_outbound",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    subscription_id: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "set null",
    }),
    signing_keys: jsonb("signing_keys").notNull(),
    circuit_state: text("circuit_state").default("closed").notNull(),
    ...timestamps,
  },
  (t) => [index("webhooks_outbound_tenant_sub_idx").on(t.tenant_id, t.subscription_id)],
);

// ----- deliveries -----------------------------------------------------------

export const deliveries = pgTable(
  "deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    subscription_id: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    event_id: uuid("event_id").notNull(),
    outbox_event_id: bigint("outbox_event_id", { mode: "number" }),
    attempt: integer("attempt").notNull(),
    attempt_number: integer("attempt_number").default(1).notNull(),
    status: text("status").notNull(),
    response_code: integer("response_code"),
    error: text("error"),
    // One of the FailureClass values
    // (`transient_network` | `transient_5xx` | `rate_limited` |
    //  `auth_failure` | `permanent_4xx` | `unknown`). Null on success.
    classification: text("classification"),
    // When status='dead_letter': why the delivery was abandoned.
    //   `circuit_open`       — breaker short-circuit, never attempted.
    //   `exhausted_retries`  — retry ladder ran to completion.
    //   `permanent_failure`  — classifier flagged a terminal 4xx/auth.
    terminal_reason: text("terminal_reason"),
    request_hash: text("request_hash"),
    event_type: text("event_type"),
    target_url: text("target_url"),
    response_body: text("response_body"),
    duration_ms: integer("duration_ms"),
    next_retry_at: timestamp("next_retry_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("deliveries_tenant_sub_created_idx").on(t.tenant_id, t.subscription_id, t.created_at),
    index("deliveries_status_retry_idx").on(t.status, t.next_retry_at),
    // Lets a dashboard list per-tenant dead-letter rows without a full scan.
    index("deliveries_tenant_status_created_idx").on(t.tenant_id, t.status, t.created_at),
  ],
);

// P11: dedup table for Standard Webhooks webhook-id replay protection.
export const webhookReplaySeen = pgTable(
  "webhook_replay_seen",
  {
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    webhook_id: uuid("webhook_id")
      .notNull()
      .references(() => webhooksInbound.id, { onDelete: "cascade" }),
    standard_webhook_id: text("standard_webhook_id").notNull(),
    seen_at: timestamp("seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("webhook_replay_seen_key").on(t.tenant_id, t.webhook_id, t.standard_webhook_id),
    index("webhook_replay_seen_seen_at_idx").on(t.seen_at),
  ],
);
