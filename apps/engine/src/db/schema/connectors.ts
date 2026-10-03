import { sql } from "drizzle-orm";
import {
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
import { outboundConnections } from "./connections.ts";
import { tenants } from "./identity.ts";

export const environmentEnum = pgEnum("environment", ["dev", "prod"]);
export const credentialModeEnum = pgEnum("credential_mode", [
  "none",
  "header",
  "query",
  "bearer",
  "basic",
  "oauth2",
  "aws_sigv4",
  "token_mint",
  "oauth2_client",
  // Private key for machine-to-machine OAuth2 private_key_jwt flows.
  // See credentials/types.ts `OAuth2PrivateKeyCredentialValue`.
  "oauth2_private_key",
]);
export const endUserCombineModeEnum = pgEnum("end_user_combine_mode", ["merge", "replace"]);
export const connectorTemplateSourceEnum = pgEnum("connector_template_source", [
  "builtin",
  "tenant",
]);

// ----- connectors -----------------------------------------------------------

export const connectors = pgTable(
  "connectors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    display_name: text("display_name").notNull(),
    driver: text("driver").notNull(),
    environment: environmentEnum("environment").notNull().default("dev"),
    auth_type: credentialModeEnum("auth_type").notNull().default("none"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    base_url: text("base_url"),
    dsn: text("dsn"),
    // Categorized operator quirks (migration 0006 — replaces the legacy
    // `operator_notes` text column). Six string slots, each capped at
    // 2K chars; the context assembler picks only the categories
    // relevant to the current turn shape. Typed as a partial record so
    // the application layer can pass the same `OperatorQuirks` shape
    // (each slot independently optional) without coercing — drizzle's
    // jsonb column accepts whatever JSON the Zod schema validated.
    operator_quirks: jsonb("operator_quirks")
      .$type<Partial<Record<string, string>>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Self-description LINKS the connector publishes (llms.txt / llms-full.txt /
    // OpenAPI spec / GraphQL endpoint). LINKS ONLY — never the document bodies;
    // the full content lives in the discovery cache or is fetched on demand at
    // authoring time. Discovered on create + refreshed/enriched by the scheduler
    // (source: "discovery" | "self_healing" | "manual"). Surfaced to authoring
    // and to API/MCP consumers so they can fetch the docs themselves.
    self_description: jsonb("self_description")
      .$type<{
        links?: Array<{
          kind: "llms_txt" | "llms_full" | "openapi" | "graphql";
          url: string;
          source: "discovery" | "self_healing" | "manual";
          discovered_at: string;
        }>;
      }>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    template_slug: text("template_slug"),
    template_name: text("template_name"),
    template_source: connectorTemplateSourceEnum("template_source"),
    template_version: integer("template_version"),
    template_snapshot: jsonb("template_snapshot").$type<Record<string, unknown>>(),
    auto_refresh_cron: text("auto_refresh_cron"),
    last_ingested_at: timestamp("last_ingested_at", { withTimezone: true }),
    // Operator on/off switch, driver-agnostic. A disabled connector stays
    // fully configured and keeps its credentials; it is simply not offered
    // for use. Distinct from `deleted_at` (gone) and from `health_state`
    // (a verdict the engine derives from observed behaviour): `enabled` is
    // the one bit only a human sets.
    enabled: boolean("enabled").notNull().default(true),
    // The ENGINE's own account of the most recent failed interaction:
    // `[<error_code>] <sentence>`. Never the remote's text — a column
    // operators read, export and render cannot depend on recognising every
    // vendor's token shape, so the upstream body stays in the structured
    // log (retention + access control) and only the status is read out of
    // it. Today the MCP handshake path is the only writer; on the other
    // drivers the column is null and `health_reason` carries the verdict.
    // Cleared on the next success.
    last_error: text("last_error"),
    circuit_state: text("circuit_state").notNull().default("closed"),
    circuit_opened_at: timestamp("circuit_opened_at", { withTimezone: true }),
    circuit_failure_count: integer("circuit_failure_count").notNull().default(0),
    circuit_threshold: integer("circuit_threshold").notNull().default(5),
    circuit_reset_ms: integer("circuit_reset_ms").notNull().default(300000),
    needs_reauth: boolean("needs_reauth").notNull().default(false),
    auth_failed_at: timestamp("auth_failed_at", { withTimezone: true }),
    auth_failed_reason: text("auth_failed_reason"),
    // Rolled-up connector health: ok | degraded | needs_update | needs_reauth.
    // Written ONLY through connectors/health-state.ts (atomic edge-guarded
    // transitions, one notification + audit row per transition — same
    // discipline as needs_reauth). `needs_reauth` (bool) stays the
    // credential-specific flag; health_state is the presentation rollup that
    // also covers removed/deprecated endpoints (needs_update) and repeated
    // vendor failures (degraded). Read through effectiveConnectorHealth() so
    // circuit_state / needs_reauth / health_state never disagree in displays.
    health_state: text("health_state").notNull().default("ok"),
    health_reason: text("health_reason"),
    // Stable machine code for the current non-ok state (e.g.
    // endpoint_removed | endpoint_deprecated | auth_rejected | vendor_degraded).
    health_error_code: text("health_error_code"),
    health_changed_at: timestamp("health_changed_at", { withTimezone: true }),
    // Vendor-announced removal date (RFC 8594 `Sunset` header) for the
    // deprecated-endpoint case — lets doctor/notifications say "migrate
    // before <date>" instead of a bare warning.
    sunset_at: timestamp("sunset_at", { withTimezone: true }),
    // Replacement endpoint/docs URI from the vendor's `Link
    // rel="successor-version"|"deprecation"` header, when announced.
    successor_uri: text("successor_uri"),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // Partial unique: soft-deleted rows must NOT occupy the
    // (tenant_id, slug, environment) namespace. Without the
    // `WHERE deleted_at IS NULL` predicate the user pattern from
    // session abeefb33 fails: delete_connector + re-create with the
    // same slug → 23505 unique_violation, the LLM sees a vague
    // "database error" and emits cannot_help. Mirrors the same
    // partial-index pattern already in workflows.ts.
    uniqueIndex("connectors_tenant_slug_env_key")
      .on(t.tenant_id, t.slug, t.environment)
      .where(sql`${t.deleted_at} IS NULL`),
    index("connectors_needs_reauth_idx").on(t.tenant_id).where(sql`${t.needs_reauth} = true`),
    // Slug shape gate. The tool palette names an external MCP tool
    // `mcp_<slug>__<tool>`, so the `__` separator is only an unambiguous
    // split point while no slug may contain a `__` run. Slug must start
    // and end alphanumeric, allow `_`/`-` inside, and stay within 64
    // chars. Defence in depth: the API Zod schemas validate slugs, but
    // internal writers (seeds, migrations, repair flows) bypass them, and
    // a caller-supplied slug reaches the INSERT unmodified.
    // Runtime mirror: CONNECTOR_SLUG_RE in
    // apps/engine/src/connectors/types.ts.
    check(
      "connectors_slug_shape_check",
      sql`${t.slug} ~ '^[a-zA-Z0-9]([a-zA-Z0-9_-]{0,62}[a-zA-Z0-9])?$' AND ${t.slug} !~ '__'`,
    ),
    // SECRET-BY-REFERENCE gate for the mcp driver's auth block. Secret
    // material belongs in the AES-256-GCM `credentials` table and is
    // referenced from `config.mcp.auth` by `token_ref` / `credential_id`.
    // Scoped to `config->'mcp'->'auth'` rather than the whole config
    // root because other drivers legitimately carry header *names* and
    // query-parameter *names* there. PostgreSQL forbids subqueries in
    // CHECK, so the denied key-names are an explicit allowlist (the
    // jsonb `?` operator is immutable and allowed).
    check(
      "connectors_mcp_auth_no_inline_secrets_check",
      sql`${t.config} -> 'mcp' -> 'auth' IS NULL OR NOT (
        ${t.config} -> 'mcp' -> 'auth' ? 'client_secret' OR
        ${t.config} -> 'mcp' -> 'auth' ? 'password' OR
        ${t.config} -> 'mcp' -> 'auth' ? 'passphrase' OR
        ${t.config} -> 'mcp' -> 'auth' ? 'api_key' OR
        ${t.config} -> 'mcp' -> 'auth' ? 'apikey' OR
        ${t.config} -> 'mcp' -> 'auth' ? 'access_token' OR
        ${t.config} -> 'mcp' -> 'auth' ? 'refresh_token' OR
        ${t.config} -> 'mcp' -> 'auth' ? 'bearer_token' OR
        ${t.config} -> 'mcp' -> 'auth' ? 'secret'
      )`,
    ),
  ],
);

// ----- connector_oauth_states ----------------------------------------------

export const connectorOauthStates = pgTable(
  "connector_oauth_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    connector_id: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    state: text("state").notNull(),
    code_verifier: text("code_verifier").notNull(),
    redirect_uri: text("redirect_uri").notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    // G6 (runtime-logs review plan): scopes the engine asked the IdP
    // to grant on this authorization round. Space-separated, raw from
    // the OAuth2 `scope` parameter. The callback handler diffs this
    // against the bundle.scope (the granted set) and marks the
    // resulting credential `partial_grant` if non-empty.
    requested_scopes: text("requested_scopes"),
    // Where the person started this sign-in (cli | cockpit | chat | portal —
    // connectors/oauth-origin.ts), so the unauthenticated callback can send
    // them back to it. Only the word: the return address is built from the
    // connector id, never stored. Null on a row written before the column
    // existed, which reads as cli.
    origin: text("origin"),
  },
  (t) => [uniqueIndex("connector_oauth_states_state_key").on(t.state)],
);

// ----- connector_oauth_start_grants -----------------------------------------
// Single-use, 10-min-TTL grant tokens that allow an unauthenticated browser
// to start an OAuth2 authorization-code dance via
// GET /v1/connectors/{id}/oauth/start?grant=skog_<token>.
// The token is stored as a sha256 hex digest only (portal-token discipline).

export const connectorOauthStartGrants = pgTable(
  "connector_oauth_start_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // tenant_id is NOT NULL here (matches code, which always binds it). The
    // pre-consolidation migration left it nullable, but the runtime never
    // writes null — the v6 baseline tightens it to NOT NULL deliberately.
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    connector_id: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    // SHA-256 hex of the plaintext grant token. Only the hash is stored; the
    // plaintext is returned once at mint time and never persisted.
    token_sha256: text("token_sha256").notNull(),
    // Null when minted by the machine path (beginConnectorOAuthDance); set to
    // the operator's user/system-account id when minted via the tool surface.
    created_by_actor_id: uuid("created_by_actor_id"),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("connector_oauth_start_grants_token_sha256_key").on(t.token_sha256)],
);

// ----- connector_credential_setup_grants ------------------------------------
// Single-use, 10-min-TTL grant tokens that allow an unauthenticated browser
// to view + submit a credential-setup form for a non-OAuth (bearer / basic /
// header / query) connector via
//   GET  /v1/connectors/{id}/credentials/setup?grant=sksg_<token>  (validate,
//        does NOT consume — the form must still be submittable)
//   POST /v1/connectors/{id}/credentials/setup                     (consumes
//        atomically, then writes the credential).
// The token is stored as a sha256 hex digest only (portal-token discipline).
// Deliberately a SEPARATE table from connector_oauth_start_grants: that
// table's contract is consume-on-first-touch (a single GET starts the OAuth
// dance), whereas a credential-setup flow is two hits (render, then submit) —
// reusing the OAuth table would let a leaked OAuth grant redeem here too.

export const connectorCredentialSetupGrants = pgTable(
  "connector_credential_setup_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    connector_id: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    // SHA-256 hex of the plaintext grant token. Only the hash is stored; the
    // plaintext is returned once at mint time and never persisted.
    token_sha256: text("token_sha256").notNull(),
    // The principal that minted the grant (via request_connector_reauth).
    // Recorded so consumeSetupGrant can attribute the resulting
    // clearConnectorReauth() call to the operator who requested the fix.
    created_by_actor_id: uuid("created_by_actor_id"),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("connector_credential_setup_grants_token_sha256_key").on(t.token_sha256)],
);

// ----- connector_environments ----------------------------------------------

export const connectorEnvironments = pgTable(
  "connector_environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    connector_id: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    environment: environmentEnum("environment").notNull(),
    overrides: jsonb("overrides"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("connector_environments_connector_env_key").on(t.connector_id, t.environment),
  ],
);

// ----- connector_promotions ------------------------------------------------

export const connectorPromotions = pgTable(
  "connector_promotions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    idempotency_key_hash: text("idempotency_key_hash").notNull(),
    request_fingerprint: text("request_fingerprint").notNull(),
    source_connector_id: uuid("source_connector_id").notNull(),
    target_connector_id: uuid("target_connector_id").notNull(),
    strategy: text("strategy").notNull(),
    response: jsonb("response").$type<Record<string, unknown>>().notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("connector_promotions_tenant_idempotency_key").on(
      t.tenant_id,
      t.idempotency_key_hash,
    ),
    index("connector_promotions_source_idx").on(t.tenant_id, t.source_connector_id),
    index("connector_promotions_target_idx").on(t.tenant_id, t.target_connector_id),
  ],
);

// ----- credentials ----------------------------------------------------------

export const credentials = pgTable(
  "credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    // Owning resource. A credential belongs to exactly one connector —
    // including an external MCP server, which is a connector whose driver
    // is `mcp`. There is no second owner column and therefore no owner
    // XOR to keep honest.
    connector_id: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    environment: environmentEnum("environment").notNull(),
    mode: credentialModeEnum("mode").notNull(),
    // Stable authority identity: replacements and permission changes advance
    // it; routine OAuth token refresh with unchanged scopes does not.
    authority_revision: integer("authority_revision").notNull().default(1),
    // AES-256-GCM ciphertext (see apps/engine/src/crypto/aes-gcm.ts). Writers call encryptSecret(), readers decryptSecret(), keyed by env.MASTER_KEY.
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    auth_tag: bytea("auth_tag").notNull(),
    oauth2_refresh_ciphertext: bytea("oauth2_refresh_ciphertext"),
    oauth2_refresh_iv: bytea("oauth2_refresh_iv"),
    oauth2_refresh_auth_tag: bytea("oauth2_refresh_auth_tag"),
    oauth2_expires_at: timestamp("oauth2_expires_at", { withTimezone: true }),
    // G6 (runtime-logs review plan): scopes the IdP actually granted
    // on the most recent OAuth flow, from the token-exchange response's
    // `scope` field, stored space-separated whatever separator the server
    // answered with. Diffed against the
    // matching `connector_oauth_states.requested_scopes` at callback
    // time; when granted ⊊ requested, the credential is `partial_grant`
    // and probe / test surface the missing scopes to the LLM.
    granted_scopes: text("granted_scopes"),
    // Points the credential at an outbound connection (Cockpit: "Verbindung
    // wählen") instead of a pasted key. When set, the access token is read
    // from the connection's current secret version at request time and the
    // ciphertext columns hold an empty oauth2 payload. Disconnecting the
    // connection leaves the credential behind with nothing to send, which the
    // connector shows as "Zugangsdaten fehlen".
    connection_id: uuid("connection_id").references(() => outboundConnections.id, {
      onDelete: "set null",
    }),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // One credential slot per (connector, environment, mode). No longer
    // partial: `connector_id` is NOT NULL, so the former
    // `WHERE connector_id IS NOT NULL` predicate was always true.
    uniqueIndex("credentials_connector_env_mode_key").on(t.connector_id, t.environment, t.mode),
    check("credentials_authority_revision_positive", sql`${t.authority_revision} > 0`),
  ],
);

// ----- end_user_credentials -------------------------------------------------

/** Per-end-user credentials. Retained for rows written by versions that had
 *  the write endpoint; nothing reads them at execution time and no route
 *  creates them any more. See http/routes/connectors/credentials.ts. */
export const endUserCredentials = pgTable(
  "end_user_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    connector_id: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    enduser_ref: text("enduser_ref").notNull(),
    combine_mode: endUserCombineModeEnum("combine_mode").notNull(),
    // AES-256-GCM ciphertext (see apps/engine/src/crypto/aes-gcm.ts). Writers call encryptSecret(), readers decryptSecret(), keyed by env.MASTER_KEY.
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    auth_tag: bytea("auth_tag").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("end_user_credentials_unique_key").on(t.tenant_id, t.connector_id, t.enduser_ref),
  ],
);

// ----- schema_versions ------------------------------------------------------

export const schemaVersions = pgTable(
  "schema_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    connector_id: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    endpoint_key: text("endpoint_key").notNull(),
    workflow_id: uuid("workflow_id"),
    step_id: text("step_id"),
    schema: jsonb("schema").notNull(),
    observed_schema: jsonb("observed_schema"),
    seen_at: timestamp("seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("schema_versions_connector_endpoint_seen_idx").on(
      t.connector_id,
      t.endpoint_key,
      t.seen_at,
    ),
    index("schema_versions_provenance_seen_idx").on(
      t.tenant_id,
      t.connector_id,
      t.endpoint_key,
      t.workflow_id,
      t.step_id,
      t.seen_at,
    ),
  ],
);
