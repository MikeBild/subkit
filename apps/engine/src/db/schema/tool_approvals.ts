import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bytea, tenantId } from "./_common.ts";
import { tenants } from "./identity.ts";

export const toolApprovals = pgTable(
  "tool_approvals",
  {
    id: uuid("id").primaryKey(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    principal_id: uuid("principal_id").notNull(),
    claimed_execution_id: uuid("claimed_execution_id"),
    tool: text("tool").notNull(),
    surface: text("surface").notNull(),
    execution_mode: text("execution_mode"),
    args_ciphertext: bytea("args_ciphertext").notNull(),
    args_iv: bytea("args_iv").notNull(),
    args_auth_tag: bytea("args_auth_tag").notNull(),
    args_hash: text("args_hash").notNull(),
    preview_ciphertext: bytea("preview_ciphertext"),
    preview_iv: bytea("preview_iv"),
    preview_auth_tag: bytea("preview_auth_tag"),
    portal_token_sha256: text("portal_token_sha256"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    granted_at: timestamp("granted_at", { withTimezone: true }),
    granted_by_user_id: uuid("granted_by_user_id"),
    granted_via: text("granted_via"),
    declined_at: timestamp("declined_at", { withTimezone: true }),
    consumed_at: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [
    index("tool_approvals_tenant_id_idx").on(t.tenant_id, t.id),
    index("tool_approvals_expiry_sweep_idx").on(t.expires_at).where(sql`${t.consumed_at} IS NULL`),
    uniqueIndex("tool_approvals_portal_token_sha256_key").on(t.portal_token_sha256),
  ],
);

export type ToolApprovalRow = typeof toolApprovals.$inferSelect;
