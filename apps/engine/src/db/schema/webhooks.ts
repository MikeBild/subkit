import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
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
    origin: text("origin").notNull().default("crud"),
    admission_hold: jsonb("admission_hold").$type<{
      reason_code:
        | "execution_authority_required"
        | "execution_authority_expired"
        | "execution_authority_exhausted"
        | "execution_authority_revoked"
        | "execution_authority_changed";
      observed_at: string;
    }>(),
    ...timestamps,
  },
  (t) => [uniqueIndex("webhooks_inbound_slug_key").on(t.slug)],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    event_pattern: text("event_pattern").notNull(),
    target_url: text("target_url").notNull(),
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
    classification: text("classification"),
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
    index("deliveries_tenant_status_created_idx").on(t.tenant_id, t.status, t.created_at),
  ],
);

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

export const webhookHeldDeliveries = pgTable(
  "webhook_held_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    inbound_id: uuid("inbound_id").references(() => webhooksInbound.id, { onDelete: "set null" }),
    workflow_id: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    delivery_id: text("delivery_id").notNull(),
    event_type: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    body_bytes: integer("body_bytes").notNull(),
    state: text("state")
      .$type<"held" | "replaying" | "replayed" | "expired" | "replay_failed">()
      .default("held")
      .notNull(),
    reason_code: text("reason_code").notNull(),
    outcome_code: text("outcome_code"),
    execution_id: uuid("execution_id"),
    claim_token: uuid("claim_token"),
    claimed_until: timestamp("claimed_until", { withTimezone: true }),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    settled_at: timestamp("settled_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("webhook_held_deliveries_delivery_key").on(
      t.tenant_id,
      t.inbound_id,
      t.delivery_id,
    ),
    index("webhook_held_deliveries_hook_state_idx").on(t.tenant_id, t.inbound_id, t.state),
    index("webhook_held_deliveries_state_expires_idx").on(t.state, t.expires_at),
    check(
      "webhook_held_deliveries_state_check",
      sql`${t.state} IN ('held', 'replaying', 'replayed', 'expired', 'replay_failed')`,
    ),
    check(
      "webhook_held_deliveries_claim_check",
      sql`(${t.state} = 'replaying') = (${t.claim_token} IS NOT NULL AND ${t.claimed_until} IS NOT NULL)`,
    ),
    check("webhook_held_deliveries_body_bytes_check", sql`${t.body_bytes} BETWEEN 0 AND 1048576`),
    check(
      "webhook_held_deliveries_delivery_id_check",
      sql`char_length(${t.delivery_id}) BETWEEN 1 AND 512`,
    ),
  ],
);
