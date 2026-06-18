// External MCP servers consumed by subkit's MCP client. Per-tenant.
//
// subkit hosts its own MCP server (apps/engine/src/mcp/server.ts) for
// external MCP clients to call into. This table
// is the inverse direction: tenants register external MCP servers
// (Notion-MCP, GitHub-MCP, Vercel-MCP, ...) whose tools the LLM in the
// conversation loop can invoke.
//
// `namespace` is a URL-safe slug used as the tool-name prefix in the
// merged tool palette: `mcp_<namespace>__<remote_tool_name>`. The
// double-underscore separator survives AI SDK's tool-name regex
// (^[a-zA-Z0-9_-]+$). Namespaces are unique per tenant.
//
// `auth_config` carries the OAuth/bearer/api-key shape inline as jsonb;
// the MCP client pool resolves credentials at handshake time. We keep
// it as opaque jsonb rather than pointing at the credentials table
// because MCP auth_provider shapes (PKCE flows, dynamic client
// registration) do not match the static credential rows.
//
// SECRET-BY-REFERENCE CONTRACT: writers MUST store secret material
// (client_secret, bearer tokens, api keys, passwords) in the
// `credentials` table (AES-256-GCM encrypted) and reference it from
// `auth_config` via `token_ref` / `credential_id`. Never inline
// secrets at the top level — the `mcp_servers_auth_config_no_inline_secrets_check`
// CHECK constraint below fails the INSERT/UPDATE if it sees a key
// matching the known-secret pattern at the root of `auth_config`.
//
// Audit-action vocabulary. The configuration table is tenant-mutable
// state, so every write MUST emit an `audit_log` row via the
// standard audit recorder. The committed action vocabulary is:
//
//     mcp_server.registered    — INSERT into mcp_servers
//     mcp_server.config_updated — UPDATE of url / auth_config / namespace
//     mcp_server.disabled      — status flipped 'active' → 'disabled'
//     mcp_server.re_enabled    — status flipped 'disabled' → 'active'
//     mcp_server.errored       — status flipped to 'error' (last_error set)
//     mcp_server.deleted       — DELETE (or soft-delete equivalent)
//     mcp_server.handshake_ok  — successful handshake; last_handshake_at set
//
// Each audit row must include `request_source` (CLI vs API vs MCP) plus
// the tenant_id and the resource_id of the affected mcp_servers row.

import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";

export type McpServerTransport = "http" | "sse" | "stdio";
export type McpServerStatus = "active" | "disabled" | "error";

export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    // Human-friendly display name; not used for tool-name composition.
    name: text("name").notNull(),
    // URL-safe slug, unique per tenant. Used as `mcp_<namespace>__<tool>`.
    namespace: text("namespace").notNull(),
    transport: text("transport").$type<McpServerTransport>().notNull(),
    // HTTP/SSE URL or, for stdio, the resolved command path.
    url: text("url").notNull(),
    // Opaque auth shape; resolved by the MCP client pool at handshake.
    // Examples: { kind: "bearer", token_ref: "..." },
    // { kind: "oauth2", issuer: "...", client_id: "...", ... }.
    auth_config: jsonb("auth_config").$type<Record<string, unknown>>(),
    status: text("status").$type<McpServerStatus>().notNull().default("active"),
    last_handshake_at: timestamp("last_handshake_at", { withTimezone: true }),
    last_error: text("last_error"),
    // Hash of the most recently observed tool manifest; used by the
    // schema-drift tracker to invalidate the tool cache when the remote
    // server changes its tools.
    // SOLE WRITERS: only the handshake/drift paths write this column —
    // `recordMcpServerHandshakeState` (mcp/client/registry.ts) and the
    // schema-drift reconciler (mcp/client/schema-drift.ts). The operator
    // PATCH surface (`updatePatchSchema` / `updateMcpServer`) deliberately
    // excludes it: the SIEM discriminator on `mcp_server.config_updated`
    // (changed_fields === ["tools_manifest_hash"] ⇒ drift, not a human
    // edit) depends on no other writer ever touching the hash.
    tools_manifest_hash: text("tools_manifest_hash"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("mcp_servers_tenant_namespace_uq").on(t.tenant_id, t.namespace),
    index("mcp_servers_tenant_status_idx").on(t.tenant_id, t.status),
    check("mcp_servers_transport_check", sql`${t.transport} IN ('http','sse','stdio')`),
    check("mcp_servers_status_check", sql`${t.status} IN ('active','disabled','error')`),
    // Defence-in-depth shape gate. The HTTP/MCP boundaries Zod-validate
    // namespace inputs, but internal writers (admin tools, seeds,
    // repair flows) could bypass that — a malformed slug would produce
    // tool names that fail AI SDK's `^[a-zA-Z0-9_-]+$` regex silently.
    // Namespace must start + end with alphanumeric, allow `_`/`-`
    // inside, and forbid `__` runs so the `mcp_<ns>__<tool>` split
    // convention stays deterministic.
    // Runtime mirror: MCP_NAMESPACE_REGEX in apps/engine/src/api/
    // common-schemas.ts is the single runtime source of this shape; the
    // SQL literal below stays as applied (migrations don't change).
    check(
      "mcp_servers_namespace_shape_check",
      sql`${t.namespace} ~ '^[a-zA-Z0-9]([a-zA-Z0-9_-]{0,62}[a-zA-Z0-9])?$' AND ${t.namespace} !~ '__'`,
    ),
    // SECRET-BY-REFERENCE gate. Reject INSERT / UPDATE that puts the
    // canonical secret keys at the root of `auth_config`. Writers
    // must reference the `credentials` table via `token_ref` /
    // `credential_id` instead. PostgreSQL forbids subqueries in CHECK
    // so this is an explicit allowlist of denied keys (the `?`
    // operator on jsonb is immutable and allowed). Add to the list
    // when a new secret key-name convention appears.
    check(
      "mcp_servers_auth_config_no_inline_secrets_check",
      sql`${t.auth_config} IS NULL OR NOT (
        ${t.auth_config} ? 'client_secret' OR
        ${t.auth_config} ? 'password' OR
        ${t.auth_config} ? 'passphrase' OR
        ${t.auth_config} ? 'api_key' OR
        ${t.auth_config} ? 'apikey' OR
        ${t.auth_config} ? 'access_token' OR
        ${t.auth_config} ? 'refresh_token' OR
        ${t.auth_config} ? 'bearer_token' OR
        ${t.auth_config} ? 'secret'
      )`,
    ),
  ],
);
