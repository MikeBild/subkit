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
    // TODO(P5): wire AES-256-GCM from env.MASTER_KEY
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
