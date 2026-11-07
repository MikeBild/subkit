import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_common.ts";
import { tenants, users } from "./identity.ts";

export const permissions = pgTable(
  "permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    resource_type: text("resource_type").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("permissions_name_key").on(t.name)],
);

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    is_builtin: boolean("is_builtin").notNull().default(false),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("roles_tenant_name_key").on(t.tenant_id, t.name),
    check(
      "roles_reserved_name_builtin_only",
      sql`${t.is_builtin} OR ${t.name} NOT IN ('admin','member','enduser','metrics_scraper','portal_token_user')`,
    ),
  ],
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    role_id: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permission_id: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.role_id, t.permission_id] }),
    index("role_permissions_role_idx").on(t.role_id),
    index("role_permissions_permission_idx").on(t.permission_id),
  ],
);

export const resourceGrants = pgTable(
  "resource_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    subject_type: text("subject_type").notNull(),
    subject_id: uuid("subject_id").notNull(),
    resource_type: text("resource_type").notNull(),
    resource_id: uuid("resource_id").notNull(),
    permission_id: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
    granted_by: uuid("granted_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("resource_grants_unique_key").on(
      t.tenant_id,
      t.subject_type,
      t.subject_id,
      t.resource_type,
      t.resource_id,
      t.permission_id,
    ),
    index("resource_grants_subject_idx").on(t.tenant_id, t.subject_type, t.subject_id),
    index("resource_grants_resource_idx").on(t.tenant_id, t.resource_type, t.resource_id),
  ],
);

export const groups = pgTable(
  "groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    ...timestamps,
  },
  (t) => [uniqueIndex("groups_tenant_name_key").on(t.tenant_id, t.name)],
);

export const groupMembers = pgTable(
  "group_members",
  {
    group_id: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    added_by: uuid("added_by"),
    added_at: timestamp("added_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.group_id, t.user_id] }),
    index("group_members_user_idx").on(t.user_id),
  ],
);

export const groupRoleAssignments = pgTable(
  "group_role_assignments",
  {
    group_id: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    role_id: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.group_id, t.role_id] }),
    index("group_role_assignments_role_idx").on(t.role_id),
  ],
);
