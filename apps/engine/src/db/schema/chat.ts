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
    // TODO(P5): wire AES-256-GCM from env.MASTER_KEY
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
