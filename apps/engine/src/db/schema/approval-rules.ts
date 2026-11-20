import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { tenants, users } from "./identity.ts";

export const TOOL_APPROVAL_RULE_STATES = [
  "observed",
  "offered",
  "active",
  "dismissed",
  "revoked",
] as const;
export type ToolApprovalRuleState = (typeof TOOL_APPROVAL_RULE_STATES)[number];

export const TOOL_APPROVAL_CONTENT_CLASSES = [
  "no_content",
  "same_content",
  "person_given",
] as const;
export type ToolApprovalContentClass = (typeof TOOL_APPROVAL_CONTENT_CLASSES)[number];

export interface ToolApprovalRuleScope {
  tool: string;
  target: string | null;
  account: string | null;
  recipients: string[];
  verb: string;
}

export const toolApprovalRules = pgTable(
  "tool_approval_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tool: text("tool").notNull(),
    scope_hash: text("scope_hash").notNull(),
    scope: jsonb("scope").$type<ToolApprovalRuleScope>().notNull(),
    state: text("state").$type<ToolApprovalRuleState>().notNull().default("observed"),
    approvals_count: integer("approvals_count").notNull().default(1),
    use_count: integer("use_count").notNull().default(0),
    offered_at: timestamp("offered_at", { withTimezone: true }),
    decided_at: timestamp("decided_at", { withTimezone: true }),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    last_used_at: timestamp("last_used_at", { withTimezone: true }),
    content_class: text("content_class")
      .$type<ToolApprovalContentClass>()
      .notNull()
      .default("no_content"),
    content_hash: text("content_hash"),
    expires_at: timestamp("expires_at", { withTimezone: true }),
    daily_limit: integer("daily_limit").notNull().default(20),
    uses_day: date("uses_day"),
    uses_on_day: integer("uses_on_day").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("tool_approval_rules_scope_key").on(t.tenant_id, t.user_id, t.scope_hash),
    index("tool_approval_rules_owner_state_idx").on(t.tenant_id, t.user_id, t.state),
    check(
      "tool_approval_rules_state_check",
      sql`${t.state} IN ('observed', 'offered', 'active', 'dismissed', 'revoked')`,
    ),
    check("tool_approval_rules_scope_hash_check", sql`${t.scope_hash} ~ '^[0-9a-f]{64}$'`),
    check("tool_approval_rules_tool_check", sql`char_length(${t.tool}) BETWEEN 1 AND 200`),
    check(
      "tool_approval_rules_scope_check",
      sql`jsonb_typeof(${t.scope}) = 'object' AND octet_length(${t.scope}::text) <= 4096`,
    ),
    check(
      "tool_approval_rules_counters_check",
      sql`${t.approvals_count} >= 1 AND ${t.use_count} >= 0`,
    ),
    check(
      "tool_approval_rules_content_class_check",
      sql`${t.content_class} IN ('no_content', 'same_content', 'person_given')`,
    ),
    check(
      "tool_approval_rules_content_hash_check",
      sql`${t.content_hash} IS NULL OR ${t.content_hash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "tool_approval_rules_daily_check",
      sql`${t.daily_limit} BETWEEN 1 AND 500 AND ${t.uses_on_day} >= 0`,
    ),
    check(
      "tool_approval_rules_revocation_check",
      sql`(${t.state} = 'revoked') = (${t.revoked_at} IS NOT NULL)`,
    ),
  ],
);

export type ToolApprovalRuleRow = typeof toolApprovalRules.$inferSelect;
