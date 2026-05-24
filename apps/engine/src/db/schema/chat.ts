import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea, tenantId, timestamps } from "./_common.ts";
import { conversations } from "./conversations.ts";
import { tenants, users } from "./identity.ts";

export const chatPlatformEnum = pgEnum("chat_platform", ["slack", "teams", "google_chat"]);

// ----- chat_workspaces ------------------------------------------------------

export const chatWorkspaces = pgTable(
  "chat_workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    platform: chatPlatformEnum("platform").notNull(),
    workspace_id: text("workspace_id").notNull(),
    default_channel: text("default_channel"),
    // AES-256-GCM ciphertext (see apps/engine/src/crypto/aes-gcm.ts). Writers call encryptSecret(), readers decryptSecret(), keyed by env.MASTER_KEY.
    bot_ciphertext: bytea("bot_ciphertext").notNull(),
    bot_iv: bytea("bot_iv").notNull(),
    bot_auth_tag: bytea("bot_auth_tag").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("chat_workspaces_tenant_platform_workspace_key").on(
      t.tenant_id,
      t.platform,
      t.workspace_id,
    ),
    // GLOBAL uniqueness on (platform, workspace_id): a Slack `team_id`
    // (and Teams/Google equivalents) is a real-world unique workspace
    // that can belong to exactly ONE tenant. Without this constraint,
    // tenant B could install the same workspace tenant A already
    // installed, and dispatcher / queue / handleSyncInteraction lookups
    // (which key on `(platform, workspace_id)` because they don't yet
    // know the tenant) would pick non-deterministically between the
    // two rows — every inbound event could land under either tenant.
    // The per-tenant unique key above is kept for clarity; the global
    // index is the actual tenant-isolation guarantee at the DB layer.
    uniqueIndex("chat_workspaces_platform_workspace_global_key").on(t.platform, t.workspace_id),
  ],
);

// ----- chat_identities ------------------------------------------------------

export const chatIdentities = pgTable(
  "chat_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    workspace_id: text("workspace_id").notNull(),
    platform_user_id: text("platform_user_id").notNull(),
    linked_at: timestamp("linked_at", { withTimezone: true }).defaultNow().notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("chat_identities_platform_workspace_user_key").on(
      t.platform,
      t.workspace_id,
      t.platform_user_id,
    ),
  ],
);

// ----- chat_sessions --------------------------------------------------------

export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    workspace_id: uuid("workspace_id")
      .notNull()
      .references(() => chatWorkspaces.id, { onDelete: "cascade" }),
    thread_id: text("thread_id").notNull(),
    conversation_id: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [uniqueIndex("chat_sessions_workspace_thread_key").on(t.workspace_id, t.thread_id)],
);

// ----- chat_events_seen -----------------------------------------------------
//
// Replay dedup for inbound chat events. Slack retries every Events API
// post up to 3× with the same `event_id`; without this table the dispatcher
// would run the same turn multiple times. We attempt an INSERT and treat a
// unique-violation as "already seen" — the worker drops the duplicate
// before touching the conversation pipeline. Mirrors
// `webhooks/inbound/dedup.ts` (`webhook_replay_seen`).

export const chatEventsSeen = pgTable(
  "chat_events_seen",
  {
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    workspace_id: uuid("workspace_id")
      .notNull()
      .references(() => chatWorkspaces.id, { onDelete: "cascade" }),
    /** The platform-native event id: Slack `event_id` (Events API),
     *  `view.id` (`view_submission`), `trigger_id` (`block_actions`), or
     *  a hash of `command+text+ts` for slash commands. */
    platform_event_id: text("platform_event_id").notNull(),
    seen_at: timestamp("seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // The unique key intentionally does NOT lead with tenant_id even
    // though the table carries one (kept for tenant-scoped retention
    // sweeps + future RLS). `workspace_id` references `chat_workspaces.id`
    // which is globally unique post-migration 0028
    // (`chat_workspaces_platform_workspace_global_key`), so a
    // (workspace_id, platform_event_id) pair is already tenant-unique
    // transitively — adding tenant_id would be redundant.
    uniqueIndex("chat_events_seen_key").on(t.workspace_id, t.platform_event_id),
    index("chat_events_seen_seen_at_idx").on(t.seen_at),
  ],
);

// ----- chat_deliveries ------------------------------------------------------

export const chatDeliveries = pgTable(
  "chat_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    workspace_id: uuid("workspace_id")
      .notNull()
      .references(() => chatWorkspaces.id, { onDelete: "cascade" }),
    thread_id: text("thread_id"),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    attempt: integer("attempt").default(0).notNull(),
    status: text("status").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("chat_deliveries_workspace_status_created_idx").on(
      t.workspace_id,
      t.status,
      t.created_at,
    ),
  ],
);
