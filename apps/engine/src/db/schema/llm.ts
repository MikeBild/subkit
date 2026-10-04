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
import { executions } from "./executions.ts";
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
    enable_prompt_cache: boolean("enable_prompt_cache").notNull().default(true),
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
    user_id: uuid("user_id"),
    actor_type: text("actor_type").notNull().default("system"),
    created_at: timestamps.created_at,
    month_bucket: bigint("month_bucket", { mode: "number" }).notNull(),
    execution_id: uuid("execution_id").references(() => executions.id, {
      onDelete: "set null",
    }),
    conversation_id: uuid("conversation_id"),
  },
  (t) => [
    index("llm_usage_tenant_created_idx").on(t.tenant_id, t.created_at),
    index("llm_usage_tenant_month_idx").on(t.tenant_id, t.month_bucket),
    index("llm_usage_execution_idx").on(t.tenant_id, t.execution_id),
    index("llm_usage_conversation_idx").on(t.tenant_id, t.conversation_id),
    index("llm_usage_tenant_user_month_idx").on(t.tenant_id, t.user_id, t.month_bucket),
    index("llm_usage_tenant_user_created_idx").on(t.tenant_id, t.user_id, t.created_at),
  ],
);

export const userLlmSettings = pgTable(
  "user_llm_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    user_id: uuid("user_id").notNull(),
    llm_monthly_token_budget: integer("llm_monthly_token_budget"),
    ...timestamps,
  },
  (t) => [uniqueIndex("user_llm_settings_tenant_user_uq").on(t.tenant_id, t.user_id)],
);
