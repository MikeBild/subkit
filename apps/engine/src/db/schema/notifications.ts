// P-GC5: notification channels + rules + deliveries.
//
// Notifications are an independent delivery path that runs off the
// outbox next to outbound webhooks. A notification rule matches an
// event (by type glob, workflow glob, severity, request source) and
// targets a specific chat channel; the service layer applies a
// per-channel token-bucket rate limit and a persistent circuit
// breaker before handing off to the chat adapter.

import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";

// Severity ladder used for rule severity filtering.
// debug < info < warn < error < critical
export const NOTIFICATION_SEVERITIES = ["debug", "info", "warn", "error", "critical"] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

// ----- notification_channels -----------------------------------------------

export const notificationChannels = pgTable(
  "notification_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    workspace_id: text("workspace_id").notNull(),
    channel_id: text("channel_id").notNull(),
    platform: text("platform").notNull(),
    default_severity: text("default_severity").default("info").notNull(),
    rate_limit_per_minute: integer("rate_limit_per_minute").default(60).notNull(),
    circuit_state: text("circuit_state").default("closed").notNull(),
    circuit_open_until: timestamp("circuit_open_until", { withTimezone: true }),
    consecutive_failures: integer("consecutive_failures").default(0).notNull(),
    active: boolean("active").default(true).notNull(),
    ...timestamps,
  },
  (t) => [
    index("notification_channels_tenant_ws_channel_idx").on(
      t.tenant_id,
      t.workspace_id,
      t.channel_id,
    ),
  ],
);

// ----- notification_rules --------------------------------------------------

export const notificationRules = pgTable(
  "notification_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    event_pattern: text("event_pattern").notNull(),
    workflow_pattern: text("workflow_pattern").default("*").notNull(),
    severity: text("severity").default("info").notNull(),
    request_source_filter: jsonb("request_source_filter"),
    target_workspace_id: text("target_workspace_id").notNull(),
    target_channel_id: text("target_channel_id").notNull(),
    active: boolean("active").default(true).notNull(),
    ...timestamps,
  },
  (t) => [
    index("notification_rules_tenant_event_idx").on(t.tenant_id, t.event_pattern),
    index("notification_rules_tenant_target_idx").on(
      t.tenant_id,
      t.target_workspace_id,
      t.target_channel_id,
    ),
  ],
);

// ----- notification_deliveries ---------------------------------------------

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    rule_id: uuid("rule_id").references(() => notificationRules.id, { onDelete: "set null" }),
    channel_id: uuid("channel_id").references(() => notificationChannels.id, {
      onDelete: "set null",
    }),
    event_type: text("event_type").notNull(),
    event_payload: jsonb("event_payload"),
    severity: text("severity").notNull(),
    status: text("status").notNull(),
    reason: text("reason"),
    error: text("error"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("notification_deliveries_tenant_status_idx").on(t.tenant_id, t.status, t.created_at),
  ],
);

export type NotificationChannelRow = typeof notificationChannels.$inferSelect;
export type NotificationRuleRow = typeof notificationRules.$inferSelect;
export type NotificationDeliveryRow = typeof notificationDeliveries.$inferSelect;
