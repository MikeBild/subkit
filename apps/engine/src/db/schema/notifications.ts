// P-GC5: notification channels + rules + deliveries.
//
// Notifications are an independent delivery path that runs off the
// outbox next to outbound webhooks. A notification rule matches an
// event (by type glob, workflow glob, severity, request source) and
// targets a specific chat channel; the service layer applies a
// per-channel token-bucket rate limit and a persistent circuit
// breaker before handing off to the chat adapter.

import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { tenantId, timestamps } from "./_common.ts";
import { tenants, users } from "./identity.ts";

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

// ----- cli_notification_inbox ----------------------------------------------
//
// Durable, pull-based task inbox for the tenant. The default rule
// (`_cli` / `_inbox`) routes every matching event into this table via
// the `SkCliAdapter` — a local INSERT, no chat platform involved. The
// table name predates the cockpit, which reads the same rows; it is a
// stable identifier and is not renamed for vocabulary alignment.
//
// A row is a task, not a log line: `actionable` says whether a person
// has to do something about it and `resource_type` / `resource_id`
// point at what they would open. Both are written at INSERT time from
// `classifyEvent`, so `actionable_only` can be a SQL predicate
// underneath the cursor rather than a post-filter that would yield
// short and empty pages.
//
// Consumption is a per-user read mark in `cli_notification_inbox_reads`,
// never a DELETE — one operator's ack must not empty a colleague's
// inbox. Rows leave only through the retention sweep. The
// `(tenant_id, id)` index serves the monotonic cursor walk.

export const cliNotificationInbox = pgTable(
  "cli_notification_inbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    delivery_id: uuid("delivery_id").references(() => notificationDeliveries.id, {
      onDelete: "set null",
    }),
    severity: text("severity").notNull(),
    event_type: text("event_type").notNull(),
    event_payload: jsonb("event_payload"),
    actionable: boolean("actionable").default(false).notNull(),
    resource_type: text("resource_type"),
    resource_id: text("resource_id"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("cli_notification_inbox_tenant_cursor_idx").on(t.tenant_id, t.id),
    // Partial: `actionable_only=true` is the "what must I deal with"
    // view and stays a narrow slice of the table. Same precedent as
    // `workflows_tool_catalog_lru_idx` — the ordering is declared here,
    // the `WHERE` is owned by the generated migration `.sql`.
    index("cli_notification_inbox_actionable_idx")
      .on(t.tenant_id, t.id)
      .where(sql`${t.actionable}`),
  ],
);

// ----- cli_notification_inbox_reads -----------------------------------------
//
// Per-user read state over the inbox. `tenant_id` is denormalized so
// every row carries its tenant (the isolation invariant) and so the
// tenant filter can be the first WHERE clause on the read path.
//
// `user_id` references `users.id`: only a `kind: "user"` principal has
// one. A system-account principal's id comes from `system_accounts`
// and must never reach this column.

export const cliNotificationInboxReads = pgTable(
  "cli_notification_inbox_reads",
  {
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    inbox_id: bigint("inbox_id", { mode: "number" })
      .notNull()
      .references(() => cliNotificationInbox.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    read_at: timestamp("read_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.inbox_id, t.user_id] }),
    index("cli_notification_inbox_reads_user_idx").on(t.tenant_id, t.user_id, t.inbox_id),
  ],
);

export type NotificationChannelRow = typeof notificationChannels.$inferSelect;
export type NotificationRuleRow = typeof notificationRules.$inferSelect;
export type NotificationDeliveryRow = typeof notificationDeliveries.$inferSelect;
export type CliNotificationInboxRow = typeof cliNotificationInbox.$inferSelect;
export type CliNotificationInboxReadRow = typeof cliNotificationInboxReads.$inferSelect;
