// Pending interactive-OAuth (2.1) flow state for the external-MCP CLIENT
// direction.
//
// NOTE: this is NOT the same concern as `mcp_oauth.ts`. That file holds
// the tables for the MCP authorization SERVER subkit *hosts* (clients,
// authorization codes, access/refresh tokens minted for inbound agents).
// THIS table is the inverse direction: subkit acting as an OAuth CLIENT
// against an external MCP server (e.g. an OAuth-only server) that
// requires a browser authorization-code + PKCE round-trip before its
// tools can be consumed.
//
// One row = one in-flight authorization. The headless OAuth provider:
//   1. INSERTs a row at flow start (state + redirect_uri + expires_at).
//   2. Persists `authorization_url` + `as_issuer` when its
//      `redirectToAuthorization` callback fires (the authorization-server
//      origin the URL points at).
//   3. UPDATEs `code_verifier` once PKCE generates it (it may be empty
//      on the first INSERT, mirroring `connectorOauthStates`' flow).
//   4. is consumed (and deleted) by the callback handler, which looks
//      the row up by `state`, validates the RFC 9207 `iss` against the
//      stored `as_issuer` origin, exchanges the code, and writes the
//      resulting token to the `credentials` table (secret-by-reference —
//      no token material is ever stored on this row).
//
// Mirrors `connectorOauthStates` (schema/connectors.ts) and points at the
// same `connectors` table; it stays a separate table because it carries
// three columns `connector_oauth_states` does not — `authorization_url`
// (the SDK builds it, the route does not), `as_issuer` (the RFC 9207
// mix-up check) and `started_by_actor_id`. Folding the two would either
// drop those or grow the other table for one driver. No Atlassian/Rovo
// literal lives here — the shape is generic across any OAuth-2.1 MCP
// server.

import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantId } from "./_common.ts";
import { connectors } from "./connectors.ts";
import { tenants } from "./identity.ts";

export const mcpOauthStates = pgTable(
  "mcp_oauth_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    connector_id: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    state: text("state").notNull(),
    // PKCE verifier. Mirrors `connectorOauthStates.code_verifier`
    // (NOT NULL). The headless provider may INSERT with an empty string
    // and UPDATE once PKCE is generated, so the column is NOT NULL with a
    // default of '' rather than nullable. The `'' = not-yet-set` default is
    // deliberate (INSERT placeholder → UPDATE on PKCE generation, same as
    // connector_oauth_states); oauth-provider's `codeVerifier()` rejects the
    // empty string, so a half-initialised row can never drive an exchange.
    code_verifier: text("code_verifier").notNull().default(""),
    redirect_uri: text("redirect_uri").notNull(),
    // The full authorization URL the provider directs the browser to.
    // Persisted by the headless provider's `redirectToAuthorization`
    // callback; null until that fires.
    authorization_url: text("authorization_url"),
    // Authorization-server issuer origin captured at flow start (the
    // origin of the authorization endpoint the provider directed the
    // browser to). Re-checked at callback time: when the AS echoes RFC
    // 9207 `iss`, its origin must match this — a mismatch means the code
    // came back from a different authorization server (mix-up attack).
    as_issuer: text("as_issuer"),
    // Space-separated scopes requested on this round, raw from the OAuth2
    // `scope` parameter — mirrors `connectorOauthStates.requested_scopes`.
    requested_scopes: text("requested_scopes"),
    // The principal that started this flow (the authorize route's
    // `principal.id`). The UNAUTHENTICATED callback reads it off the
    // claimed row and threads it as `actor_id` into the authorized /
    // authorization_failed audit recorders, so the lifecycle attributes
    // to the flow's originator instead of a blurred system actor. Nullable:
    // a flow without a resolvable originator stays a system-actor trail.
    started_by_actor_id: uuid("started_by_actor_id"),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("mcp_oauth_states_state_key").on(t.state),
    index("mcp_oauth_states_tenant_server_idx").on(t.tenant_id, t.connector_id),
  ],
);

export type McpOauthStateRow = typeof mcpOauthStates.$inferSelect;
