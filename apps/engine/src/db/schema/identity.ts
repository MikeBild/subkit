import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
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
import { cockpitInstallations } from "./cockpit-installations.ts";

export const userStatusEnum = pgEnum("user_status", ["invited", "active", "disabled"]);
export const auditActorKindEnum = pgEnum("audit_actor_kind", [
  "user",
  "system_account",
  "system",
  "unknown",
]);
export const egressGuardModeEnum = pgEnum("egress_guard_mode", ["strict", "permissive"]);

export const tenantOriginEnum = pgEnum("tenant_origin", ["self_hosted", "self_service"]);
export const tenantStatusEnum = pgEnum("tenant_status", [
  "active",
  "suspended",
  "pending_deletion",
]);

export const authIdentities = pgTable(
  "auth_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issuer_url: text("issuer_url").notNull(),
    subject: text("subject").notNull(),
    email: text("email").notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("auth_identities_issuer_subject_key").on(t.issuer_url, t.subject)],
);

export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    display_name: text("display_name").notNull(),
    llm_primary: text("llm_primary"),
    llm_fallback: text("llm_fallback"),
    egress_guard_mode: egressGuardModeEnum("egress_guard_mode"),
    timezone: text("timezone").default("UTC").notNull(),
    last_proactive_scan_at: timestamp("last_proactive_scan_at", { withTimezone: true }),
    last_skill_candidate_analyze_at: timestamp("last_skill_candidate_analyze_at", {
      withTimezone: true,
    }),
    last_connector_reauth_scan_at: timestamp("last_connector_reauth_scan_at", {
      withTimezone: true,
    }),
    last_endpoint_contract_scan_at: timestamp("last_endpoint_contract_scan_at", {
      withTimezone: true,
    }),
    is_operator: boolean("is_operator").default(false).notNull(),
    origin: tenantOriginEnum("origin").default("self_hosted").notNull(),
    status: tenantStatusEnum("status").default("active").notNull(),
    owner_identity_id: uuid("owner_identity_id").references(() => authIdentities.id),
    deletion_requested_at: timestamp("deletion_requested_at", { withTimezone: true }),
    deletion_scheduled_for: timestamp("deletion_scheduled_for", { withTimezone: true }),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("tenants_slug_key").on(t.slug),
    uniqueIndex("tenants_owner_identity_key").on(t.owner_identity_id),
    check(
      "tenants_origin_owner_check",
      sql`(${t.origin} = 'self_hosted' AND ${t.owner_identity_id} IS NULL) OR (${t.origin} = 'self_service' AND ${t.owner_identity_id} IS NOT NULL AND NOT ${t.is_operator})`,
    ),
    check(
      "tenants_deletion_schedule_check",
      sql`(${t.status} <> 'pending_deletion' AND ${t.deletion_requested_at} IS NULL AND ${t.deletion_scheduled_for} IS NULL) OR (${t.status} = 'pending_deletion' AND ${t.origin} = 'self_service' AND ${t.deletion_requested_at} IS NOT NULL AND ${t.deletion_scheduled_for} IS NOT NULL AND ${t.deletion_requested_at} < ${t.deletion_scheduled_for})`,
    ),
    uniqueIndex("tenants_operator_key").on(t.is_operator).where(sql`${t.is_operator}`),
  ],
);

export const engineSettings = pgTable("engine_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updated_by: uuid("updated_by"),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    auth_identity_id: uuid("auth_identity_id").references(() => authIdentities.id),
    email: text("email").notNull(),
    display_name: text("display_name"),
    role_id: uuid("role_id").notNull(),
    status: userStatusEnum("status").default("active").notNull(),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("users_tenant_email_key").on(t.tenant_id, t.email),
    uniqueIndex("users_tenant_auth_identity_key").on(t.tenant_id, t.auth_identity_id),
  ],
);

export const userIdentities = pgTable(
  "user_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider_id: text("provider_id").notNull(),
    issuer_url: text("issuer_url"),
    product_id: text("product_id"),
    subject: text("subject").notNull(),
    email: text("email").notNull(),
    last_seen_at: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("user_identities_tenant_provider_subject_key").on(
      t.tenant_id,
      t.provider_id,
      t.subject,
    ),
    uniqueIndex("user_identities_tenant_user_provider_key").on(
      t.tenant_id,
      t.user_id,
      t.provider_id,
    ),
    index("user_identities_tenant_user_idx").on(t.tenant_id, t.user_id),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    auth_identity_id: uuid("auth_identity_id").references(() => authIdentities.id),
    installation_id: uuid("installation_id").references(() => cockpitInstallations.id, {
      onDelete: "cascade",
    }),
    product_id: text("product_id"),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    last_seen_at: timestamp("last_seen_at", { withTimezone: true }),
    absolute_expires_at: timestamp("absolute_expires_at", { withTimezone: true }),
    token_sha256: text("token_sha256"),
    ...timestamps,
  },
  (t) => [
    index("sessions_user_expires_idx").on(t.user_id, t.expires_at),
    index("sessions_absolute_expires_idx").on(t.absolute_expires_at),
    index("sessions_last_seen_idx").on(t.last_seen_at),
    index("sessions_token_sha256_idx").on(t.token_sha256),
    index("sessions_installation_idx").on(t.installation_id),
  ],
);

export const oidcLoginStates = pgTable(
  "oidc_login_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id"),
    membership_invite_id: uuid("membership_invite_id").references(
      (): AnyPgColumn => userInvites.id,
      { onDelete: "cascade" },
    ),
    installation_id: uuid("installation_id").references(() => cockpitInstallations.id, {
      onDelete: "cascade",
    }),
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

export const systemAccounts = pgTable(
  "system_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    role_id: uuid("role_id"),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("system_accounts_tenant_name_key").on(t.tenant_id, t.name)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    user_id: uuid("user_id"),
    system_account_id: uuid("system_account_id"),
    creator_kind: auditActorKindEnum("creator_kind"),
    creator_id: uuid("creator_id"),
    prefix: text("prefix").notNull(),
    token_sha256: text("token_sha256").notNull(),
    name: text("name"),
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
    check(
      "api_keys_creator_identity_check",
      sql`(${t.creator_kind} is null and ${t.creator_id} is null) or (${t.creator_kind} is not null and ${t.creator_kind} = 'system' and ${t.creator_id} is null) or (${t.creator_kind} is not null and ${t.creator_kind} in ('user', 'system_account') and ${t.creator_id} is not null)`,
    ),
    index("api_keys_tenant_revoked_idx").on(t.tenant_id, t.revoked_at),
    index("api_keys_rotating_out_at_idx").on(t.rotating_out_at),
  ],
);

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

export const userInvites = pgTable(
  "user_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    prefix: text("prefix").notNull(),
    token_sha256: text("token_sha256").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    allowed_workflows: jsonb("allowed_workflows").$type<string[]>(),
    allowed_connectors: jsonb("allowed_connectors").$type<string[]>(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    redeemed_at: timestamp("redeemed_at", { withTimezone: true }),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    created_by: uuid("created_by"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("user_invites_prefix_key").on(t.prefix),
    index("user_invites_tenant_user_idx").on(t.tenant_id, t.user_id),
  ],
);

export const authProviderConfigs = pgTable(
  "auth_provider_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    priority: integer("priority").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    config_ciphertext: bytea("config_ciphertext"),
    config_iv: bytea("config_iv"),
    config_auth_tag: bytea("config_auth_tag"),
    ...timestamps,
  },
  (t) => [index("auth_provider_configs_tenant_priority_idx").on(t.tenant_id, t.priority)],
);
