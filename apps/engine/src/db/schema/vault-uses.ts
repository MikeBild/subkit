import {
  VAULT_PAYMENT_STATUSES,
  VAULT_USE_PURPOSES,
  VAULT_USE_STATUSES,
  type VaultPaymentStatus,
  type VaultUsePurpose,
  type VaultUseStatus,
} from "@shared/vault-uses.ts";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea, tenantId, timestamps } from "./_common.ts";
import { vaultItems } from "./connectors.ts";
import { deviceRunners } from "./devices.ts";
import { tenants, users } from "./identity.ts";

export {
  VAULT_PAYMENT_STATUSES,
  VAULT_USE_PURPOSES,
  VAULT_USE_STATUSES,
  type VaultPaymentStatus,
  type VaultUsePurpose,
  type VaultUseStatus,
};

export const vaultUses = pgTable(
  "vault_uses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    item_id: uuid("item_id")
      .notNull()
      .references(() => vaultItems.id, { onDelete: "cascade" }),
    actor_id: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    purpose: text("purpose").$type<VaultUsePurpose>().notNull(),
    origin: text("origin").notNull(),
    conversation_id: uuid("conversation_id"),
    run_id: uuid("run_id"),
    task_id: uuid("task_id"),
    device_id: uuid("device_id")
      .notNull()
      .references(() => deviceRunners.id, { onDelete: "cascade" }),
    command_id: text("command_id").notNull(),
    status: text("status").$type<VaultUseStatus>().notNull().default("pending"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("vault_uses_command_key").on(t.tenant_id, t.command_id),
    index("vault_uses_item_idx").on(t.tenant_id, t.item_id, t.created_at),
    check("vault_uses_purpose_check", sql`${t.purpose} IN ('sign_in', 'pay')`),
    check(
      "vault_uses_status_check",
      sql`${t.status} IN ('pending', 'running', 'submitted', 'uncertain', 'failed')`,
    ),
  ],
);

export const vaultSecretTickets = pgTable(
  "vault_secret_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    device_id: uuid("device_id")
      .notNull()
      .references(() => deviceRunners.id, { onDelete: "cascade" }),
    use_id: uuid("use_id")
      .notNull()
      .references(() => vaultUses.id, { onDelete: "cascade" }),
    command_id: text("command_id").notNull(),
    payload_ciphertext: bytea("payload_ciphertext").notNull(),
    payload_iv: bytea("payload_iv").notNull(),
    payload_auth_tag: bytea("payload_auth_tag").notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("vault_secret_tickets_use_key").on(t.use_id),
    index("vault_secret_tickets_expiry_idx").on(t.expires_at),
  ],
);

export const vaultPayments = pgTable(
  "vault_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    owner_user_id: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    card_item_id: uuid("card_item_id")
      .notNull()
      .references(() => vaultItems.id, { onDelete: "cascade" }),
    card_value_digest: text("card_value_digest").notNull(),
    card_brand: text("card_brand").notNull(),
    card_last4: text("card_last4").notNull(),
    origin: text("origin").notNull(),
    page_fingerprint: text("page_fingerprint").notNull(),
    fields: jsonb("fields").$type<Record<string, string>>().notNull(),
    field_frames: jsonb("field_frames").$type<Record<string, string>>().notNull(),
    submit_ref: text("submit_ref").notNull(),
    amount_minor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    device_id: uuid("device_id")
      .notNull()
      .references(() => deviceRunners.id, { onDelete: "cascade" }),
    command_id: text("command_id").notNull(),
    conversation_id: uuid("conversation_id"),
    tool_call_id: text("tool_call_id"),
    task_run_id: uuid("task_run_id"),
    execution_id: uuid("execution_id"),
    status: text("status").$type<VaultPaymentStatus>().notNull().default("pending"),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    approved_at: timestamp("approved_at", { withTimezone: true }),
    use_id: uuid("use_id").references(() => vaultUses.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("vault_payments_owner_status_idx").on(t.tenant_id, t.owner_user_id, t.status),
    uniqueIndex("vault_payments_command_key").on(t.tenant_id, t.command_id),
    uniqueIndex("vault_payments_tool_call_key")
      .on(t.tenant_id, t.tool_call_id)
      .where(sql`${t.tool_call_id} IS NOT NULL`),
    check(
      "vault_payments_status_check",
      sql`${t.status} IN ('pending', 'approved', 'consumed', 'expired', 'rejected')`,
    ),
    check("vault_payments_amount_check", sql`${t.amount_minor} > 0`),
    check("vault_payments_currency_check", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check("vault_payments_fingerprint_check", sql`${t.page_fingerprint} ~ '^[a-f0-9]{64}$'`),
  ],
);
