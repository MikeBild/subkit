// P8 — LLM routing settings + usage ledger.
//
// - `tenant_llm_settings` normalises per-tenant model overrides, provider
//   credentials, and monthly budgets. The existing `tenants.llm_*` columns
//   are left in place for backward compatibility with P1; this table is
//   the canonical source of truth for the P8 flows.
// - `llm_usage` records every SDK call — success or failure — so budget
//   accounting, fallback telemetry, and operator debugging all land in a
//   single append-only ledger.

import {
  bigint,
  bigserial,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea, tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";

export const tenantLlmSettings = pgTable(
  "tenant_llm_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    llm_primary_model: text("llm_primary_model"),
    llm_fallback_model: text("llm_fallback_model"),
    llm_provider: text("llm_provider"),
    llm_provider_credentials_ciphertext: bytea("llm_provider_credentials_ciphertext"),
    llm_provider_credentials_iv: bytea("llm_provider_credentials_iv"),
    llm_provider_credentials_auth_tag: bytea("llm_provider_credentials_auth_tag"),
    llm_monthly_token_budget: integer("llm_monthly_token_budget"),
    ...timestamps,
  },
  (t) => [uniqueIndex("tenant_llm_settings_tenant_key").on(t.tenant_id)],
);

export const llmUsage = pgTable(
  "llm_usage",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    flow: text("flow").notNull(),
    model: text("model").notNull(),
    prompt_tokens: integer("prompt_tokens").notNull().default(0),
    completion_tokens: integer("completion_tokens").notNull().default(0),
    total_tokens: integer("total_tokens").notNull().default(0),
    latency_ms: integer("latency_ms").notNull().default(0),
    result: text("result").notNull(),
    error: text("error"),
    created_at: timestamps.created_at,
    // month bucket used by the budget accumulator. Stored as a bigint of
    // YYYYMM so we can `sum(total_tokens) where month_bucket = ?` cheaply.
    month_bucket: bigint("month_bucket", { mode: "number" }).notNull(),
  },
  (t) => [
    index("llm_usage_tenant_created_idx").on(t.tenant_id, t.created_at),
    index("llm_usage_tenant_month_idx").on(t.tenant_id, t.month_bucket),
  ],
);
