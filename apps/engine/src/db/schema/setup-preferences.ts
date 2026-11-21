import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { tenants, users } from "./identity.ts";

export type NotificationSchedulePreference =
  | { mode: "immediately" }
  | { mode: "working_hours"; from: string; to: string; days?: number[] | undefined }
  | { mode: "daily_digest"; at: string };

export const userSetupPreferences = pgTable(
  "user_setup_preferences",
  {
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    default_chat_mode: text("default_chat_mode").$type<"ask" | "auto" | "plan">(),
    default_environment: text("default_environment").$type<"dev" | "prod">(),
    approver_kind: text("approver_kind").$type<"self" | "teammate" | "pair">(),
    approver_email: text("approver_email"),
    approver_user_id: uuid("approver_user_id"),
    approver_invite_id: uuid("approver_invite_id"),
    notification_schedule: jsonb("notification_schedule").$type<NotificationSchedulePreference>(),
    timezone: text("timezone"),
    critical_breakthrough: boolean("critical_breakthrough").notNull().default(false),
    last_digest_at: timestamp("last_digest_at", { withTimezone: true }),
    notifications_paused_at: timestamp("notifications_paused_at", { withTimezone: true }),
    notifications_paused_until: timestamp("notifications_paused_until", { withTimezone: true }),
    first_job: text("first_job"),
    services: jsonb("services").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.user_id] }),
    check(
      "user_setup_preferences_chat_mode_check",
      sql`${t.default_chat_mode} IS NULL OR ${t.default_chat_mode} IN ('ask', 'auto', 'plan')`,
    ),
    check(
      "user_setup_preferences_environment_check",
      sql`${t.default_environment} IS NULL OR ${t.default_environment} IN ('dev', 'prod')`,
    ),
    check(
      "user_setup_preferences_approver_check",
      sql`(${t.approver_kind} IS NULL AND ${t.approver_email} IS NULL AND ${t.approver_user_id} IS NULL AND ${t.approver_invite_id} IS NULL) OR (${t.approver_kind} = 'self' AND ${t.approver_email} IS NULL AND ${t.approver_user_id} IS NULL AND ${t.approver_invite_id} IS NULL) OR (${t.approver_kind} IN ('teammate', 'pair') AND char_length(${t.approver_email}) BETWEEN 3 AND 254)`,
    ),
    check(
      "user_setup_preferences_schedule_check",
      sql`${t.notification_schedule} IS NULL OR (jsonb_typeof(${t.notification_schedule}) = 'object' AND octet_length(${t.notification_schedule}::text) <= 256)`,
    ),
    check(
      "user_setup_preferences_pause_check",
      sql`${t.notifications_paused_until} IS NULL OR (${t.notifications_paused_at} IS NOT NULL AND ${t.notifications_paused_until} > ${t.notifications_paused_at})`,
    ),
    check(
      "user_setup_preferences_timezone_check",
      sql`${t.timezone} IS NULL OR char_length(${t.timezone}) BETWEEN 1 AND 64`,
    ),
    check(
      "user_setup_preferences_first_job_check",
      sql`${t.first_job} IS NULL OR char_length(${t.first_job}) BETWEEN 1 AND 120`,
    ),
    check(
      "user_setup_preferences_services_check",
      sql`jsonb_typeof(${t.services}) = 'array' AND jsonb_array_length(${t.services}) <= 50 AND octet_length(${t.services}::text) <= 4096`,
    ),
  ],
);

export type UserSetupPreferencesRow = typeof userSetupPreferences.$inferSelect;
