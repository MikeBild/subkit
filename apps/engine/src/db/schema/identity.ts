import {
  bigint,
  boolean,
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

// ----- enums ----------------------------------------------------------------

export const userRoleEnum = pgEnum("user_role", ["admin", "member", "enduser"]);
export const auditActorKindEnum = pgEnum("audit_actor_kind", ["user", "system_account", "system"]);
export const egressGuardModeEnum = pgEnum("egress_guard_mode", ["strict", "permissive"]);

// ----- tenants --------------------------------------------------------------

export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    display_name: text("display_name").notNull(),
    llm_primary: text("llm_primary"),
    llm_fallback: text("llm_fallback"),
    llm_monthly_token_budget: bigint("llm_monthly_token_budget", { mode: "number" }),
    egress_guard_mode: egressGuardModeEnum("egress_guard_mode"),
    // Default timezone for cron triggers authored from natural language.
    // Resolution chain: conversation prompt → this column → 'UTC'.
    timezone: text("timezone").default("UTC").notNull(),
    // Stamp set by the scheduler when a proactive self-healing drift scan
    // last fired for this tenant. The reconciler uses a compare-and-set on
    // this column to ensure exactly-once firing per cadence across multi-
    // instance deployments. NULL means "never scanned" — the next pass
    // fires immediately.
    last_proactive_scan_at: timestamp("last_proactive_scan_at", { withTimezone: true }),
    // Stamp set by the scheduler when the skill-candidate pattern analysis
    // last fired for this tenant. Same compare-and-set cadence mechanism as
    // last_proactive_scan_at — the reconciler CAS-stamps this column so the
    // `skill-candidate.analyze` job is enqueued exactly once per cadence
    // across multi-instance deployments. NULL means "never analysed" — the
    // next reconciler pass fires immediately.
    last_skill_candidate_analyze_at: timestamp("last_skill_candidate_analyze_at", {
      withTimezone: true,
    }),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("tenants_slug_key").on(t.slug)],
);

/** Internal engine state store — bootstrap sentinel + token envelope only.
 *  User-facing runtime configuration moved to `subkit.config.json` in v3.5
 *  (see `apps/engine/src/config/schema.ts`). This table now persists
 *  exclusively system-level state that boot-path code mutates without
 *  going through the audit + tenant scope rules of the config loader.
 *
 *  The pre-v3.5 use cases (per-tenant LLM keys, observability endpoints,
 *  token budgets) have all migrated to the config file; existing rows
 *  for those keys are ignored after the v3.5 upgrade and can be deleted
 *  by the operator at any time. */
export const engineSettings = pgTable("engine_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updated_by: uuid("updated_by"),
});

// ----- users ----------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: userRoleEnum("role").notNull(),
    // Pass-2 C1: foreign key into `roles`. Populated via seed and the
    // RBAC management API. The legacy `role` enum column stays for
    // backward compatibility with existing tests and bootstrap code.
    role_id: uuid("role_id"),
    oidc_subject: text("oidc_subject"),
    external_subject: text("external_subject"),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("users_tenant_email_key").on(t.tenant_id, t.email),
    uniqueIndex("users_tenant_oidc_key").on(t.tenant_id, t.oidc_subject),
    uniqueIndex("users_tenant_external_subject_key").on(t.tenant_id, t.external_subject),
  ],
);

// ----- sessions -------------------------------------------------------------

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    // GC6: sliding + absolute TTL tracking. `last_seen_at` is bumped on
    // every successful resolve and participates in the 8 h sliding window.
    // `absolute_expires_at` is set once at creation and caps the session
    // at 30 d regardless of activity.
    last_seen_at: timestamp("last_seen_at", { withTimezone: true }),
    absolute_expires_at: timestamp("absolute_expires_at", { withTimezone: true }),
    // Pass-2 A1: sha256 of the 32-byte random nonce embedded in the
    // signed session cookie so the resolver can look up the row without
    // trusting the cookie body.
    token_sha256: text("token_sha256"),
    ...timestamps,
  },
  (t) => [
    index("sessions_user_expires_idx").on(t.user_id, t.expires_at),
    index("sessions_absolute_expires_idx").on(t.absolute_expires_at),
    index("sessions_last_seen_idx").on(t.last_seen_at),
    index("sessions_token_sha256_idx").on(t.token_sha256),
  ],
);

// ----- oidc_login_states ---------------------------------------------------
//
// Pending authorization codes. A row lands in `startLogin` and is
// atomically read + deleted in `finishLogin` before the token exchange.
// The `state` column is the anti-CSRF value echoed back by the IdP.

export const oidcLoginStates = pgTable(
  "oidc_login_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id"),
    state: text("state").notNull(),
    code_verifier: text("code_verifier").notNull(),
    nonce: text("nonce").notNull(),
    redirect_to: text("redirect_to"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("oidc_login_states_state_key").on(t.state),
    index("oidc_login_states_expires_idx").on(t.expires_at),
  ],
);

// ----- system_accounts ------------------------------------------------------

export const systemAccounts = pgTable(
  "system_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    // Pass-2 C1: role assignment for machine accounts. Null-safe —
    // providers fall back to the `member` role when unset.
    role_id: uuid("role_id"),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("system_accounts_tenant_name_key").on(t.tenant_id, t.name)],
);

// ----- api_keys -------------------------------------------------------------

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    user_id: uuid("user_id"),
    system_account_id: uuid("system_account_id"),
    prefix: text("prefix").notNull(),
    token_sha256: text("token_sha256").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    allowed_workflows: jsonb("allowed_workflows").$type<string[]>(),
    allowed_connectors: jsonb("allowed_connectors").$type<string[]>(),
    not_before: timestamp("not_before", { withTimezone: true }),
    expires_at: timestamp("expires_at", { withTimezone: true }),
    rotating_out_at: timestamp("rotating_out_at", { withTimezone: true }),
    last_used_at: timestamp("last_used_at", { withTimezone: true }),
    rotated_from_id: uuid("rotated_from_id"),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("api_keys_prefix_key").on(t.prefix),
    index("api_keys_tenant_revoked_idx").on(t.tenant_id, t.revoked_at),
    index("api_keys_rotating_out_at_idx").on(t.rotating_out_at),
  ],
);

// ----- portal_tokens --------------------------------------------------------

export const portalTokens = pgTable(
  "portal_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    enduser_ref: text("enduser_ref").notNull(),
    prefix: text("prefix").notNull(),
    token_sha256: text("token_sha256").notNull(),
    allowed_workflows: jsonb("allowed_workflows").$type<string[]>().notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("portal_tokens_prefix_key").on(t.prefix),
    index("portal_tokens_tenant_enduser_idx").on(t.tenant_id, t.enduser_ref),
  ],
);

// ----- auth_provider_configs ------------------------------------------------

export const authProviderConfigs = pgTable(
  "auth_provider_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    priority: integer("priority").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    // AES-256-GCM ciphertext (see apps/engine/src/crypto/aes-gcm.ts). Writers call encryptSecret(), readers decryptSecret(), keyed by env.MASTER_KEY.
    config_ciphertext: bytea("config_ciphertext"),
    config_iv: bytea("config_iv"),
    config_auth_tag: bytea("config_auth_tag"),
    ...timestamps,
  },
  (t) => [index("auth_provider_configs_tenant_priority_idx").on(t.tenant_id, t.priority)],
);
