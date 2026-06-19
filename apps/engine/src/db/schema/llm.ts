// P8 — LLM routing settings + usage ledger.
//
// - `tenant_llm_settings` normalises per-tenant model overrides, provider
//   credentials, and monthly budgets. The existing `tenants.llm_*` columns
//   are left in place for backward compatibility with P1; this table is
//   the canonical source of truth for the P8 flows.
// - `llm_usage` records every SDK call — success or failure — so budget
//   accounting, fallback telemetry, and operator debugging all land in a
//   single append-only ledger.

import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
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
    enable_prompt_cache: boolean("enable_prompt_cache").notNull().default(true),
    // Conversation-quality extensions (migration 0028).
    //   system_prompt_additions — appended to the stable prompt block (cache-friendly).
    //   default_environment    — the environment (dev|prod) the LLM assumes when the
    //                             user does not specify one; surfaced in [TENANT STATE].
    //   auto_discovery         — enables the attachment-upload → discovery background job.
    //   failure_notification_channels — list of notification channel IDs that receive
    //                             conversation-failure alerts (see failure-hooks.ts).
    //   confirmation_profile   — strict | relaxed | resume_aware. Governs the
    //                             confirm_before_execution policy for long-idle sessions.
    system_prompt_additions: text("system_prompt_additions"),
    default_environment: text("default_environment").notNull().default("dev"),
    auto_discovery: boolean("auto_discovery").notNull().default(true),
    failure_notification_channels: jsonb("failure_notification_channels")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    confirmation_profile: text("confirmation_profile").notNull().default("strict"),
    ...timestamps,
  },
  (t) => [uniqueIndex("tenant_llm_settings_tenant_key").on(t.tenant_id)],
);

// Per-tenant DLP rules (migration 0028). Applied to every step output before
// the LLM sees it. Enforced by execution/response-filters.ts.
//   path_match      — JSON path expression (supports '*' and '**' wildcards).
//   pattern_regex   — optional: only redact when the value matches this regex.
//   action          — mask | drop | hash.
//   reason          — operator-facing justification; written to audit metadata.
export const tenantDlpRules = pgTable(
  "tenant_dlp_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    path_match: text("path_match").notNull(),
    pattern_regex: text("pattern_regex"),
    action: text("action").notNull(),
    reason: text("reason"),
    enabled: boolean("enabled").notNull().default(true),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("tenant_dlp_rules_tenant_enabled_idx").on(t.tenant_id, t.enabled)],
);

// Per-tenant vendor recipe overrides. The central manifest
// (`apps/engine/src/conversations/seed/vendor-recipes/*.json`) is the
// canonical source; this table lets an operator override specific fields
// for a single tenant (e.g., a bespoke stdio command path, an auth header
// that differs from the public template) without forking the manifest.
//
// `override` is a shallow-merged JSON patch over the base VendorRecipe —
// any key present wins, missing keys fall through to the manifest.
export const vendorRecipeOverrides = pgTable(
  "vendor_recipe_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    client: text("client").notNull(),
    override: jsonb("override").$type<Record<string, unknown>>().notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("vendor_recipe_overrides_tenant_client_uq").on(t.tenant_id, t.client)],
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
    cache_read_tokens: integer("cache_read_tokens").notNull().default(0),
    cache_creation_tokens: integer("cache_creation_tokens").notNull().default(0),
    latency_ms: integer("latency_ms").notNull().default(0),
    result: text("result").notNull(),
    error: text("error"),
    created_at: timestamps.created_at,
    // month bucket used by the budget accumulator. Stored as a bigint of
    // YYYYMM so we can `sum(total_tokens) where month_bucket = ?` cheaply.
    // `total_tokens` here is the effective-cost weighting (cache reads at
    // 10 %, cache creation at 125 %); see llm/pricing.ts.
    month_bucket: bigint("month_bucket", { mode: "number" }).notNull(),
  },
  (t) => [
    index("llm_usage_tenant_created_idx").on(t.tenant_id, t.created_at),
    index("llm_usage_tenant_month_idx").on(t.tenant_id, t.month_bucket),
  ],
);
