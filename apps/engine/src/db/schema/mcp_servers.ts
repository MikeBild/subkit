// External MCP servers consumed by subkit's MCP client. Per-tenant.
//
// subkit hosts its own MCP server (apps/engine/src/mcp/server.ts) for
// external agents (Claude Code, Cursor, Codex) to call into. This table
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

import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
    tools_manifest_hash: text("tools_manifest_hash"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("mcp_servers_tenant_namespace_uq").on(t.tenant_id, t.namespace),
    index("mcp_servers_tenant_status_idx").on(t.tenant_id, t.status),
  ],
);
