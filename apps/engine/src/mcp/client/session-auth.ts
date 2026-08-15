// How a pooled MCP session authenticates, and what to do when its
// credential dies mid-session.
//
// Split out of pool.ts because none of it owns a connection: given a
// server row it resolves either a static `Authorization` header or an SDK
// `OAuthClientProvider` by reading the encrypted `credentials` table, and
// it knows how to drop a token the remote has started refusing. The pool
// keeps what only it can own — which client, whose tenant, the handshake,
// the eviction, the backoff.
//
// THE SPLIT BETWEEN THE TWO PATHS IS THE POINT. `bearer` / `basic` / `none`
// are resolved once into a header mounted on the transport. The three
// oauth2 kinds are NOT: their whole token lifecycle — replay, pre-expiry
// refresh, persistence — belongs to the SDK's `authProvider`, and
// resolving a header for them here would mean a second party minting
// tokens the provider does not know about.

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  ClientCredentialsProvider,
  PrivateKeyJwtProvider,
} from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import {
  getCredentialForConnector,
  getOAuth2ClientCredential,
  getOAuth2PrivateKeyCredential,
} from "../../credentials/service.ts";
import type { DecryptedCredential } from "../../credentials/types.ts";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/logger.ts";
import type { RequestSource } from "../../observability/service-metadata.ts";
import { McpDbOAuthClientProvider } from "./oauth-provider.ts";
import { buildMcpOAuthRedirectUri } from "./oauth-redirect.ts";
import {
  getMcpConnector,
  type McpAuthConfig,
  type McpConnectorRow,
  McpPreflightError,
} from "./registry.ts";

/**
 * Resolve the static `Authorization` header (if any) for a server's
 * auth_config, reading the secret by reference from the AES-256-GCM
 * credentials table. Handles ONLY the static-header kinds — `none` (empty),
 * `bearer`, and `basic`. The `oauth2` kind is NOT resolved here: it is
 * driven end to end by the SDK transport's `authProvider` (see
 * `McpDbOAuthClientProvider`), which owns token replay, pre-expiry
 * refresh, and persistence. Returns the header map to mount on the
 * transport's `requestInit`, or `{}` for none.
 */
export async function resolveAuthHeaders(
  db: Db,
  tenant_id: string,
  connector_id: string,
  auth: McpAuthConfig,
  environment: "dev" | "prod",
): Promise<Record<string, string>> {
  if (auth.kind === "none") return {};
  // oauth2 / M2M kinds carry no static header — the authProvider supplies
  // the token via the SDK's non-interactive fetch path.
  if (
    auth.kind === "oauth2" ||
    auth.kind === "oauth2_client_credentials" ||
    auth.kind === "oauth2_private_key_jwt"
  )
    return {};

  const resolved = await getCredentialForConnector(tenant_id, connector_id, environment, db);
  if (!resolved) {
    throw new McpPreflightError(
      "credential_missing",
      `mcp.auth.kind '${auth.kind}' references a credential that does not exist for this connector`,
    );
  }
  return resolveStaticAuthHeaders(auth, resolved.value);
}

/** Resolve static MCP auth from either a vault value or a single-use draft value. */
export function resolveStaticAuthHeaders(
  auth: McpAuthConfig,
  value: DecryptedCredential | null,
): Record<string, string> {
  if (auth.kind === "none") {
    if (value !== null && value.mode !== "none") {
      throw new McpPreflightError(
        "credential_invalid",
        `mcp.auth.kind 'none' cannot use credential mode '${value.mode}'`,
      );
    }
    return {};
  }
  if (
    auth.kind === "oauth2" ||
    auth.kind === "oauth2_client_credentials" ||
    auth.kind === "oauth2_private_key_jwt"
  ) {
    throw new McpPreflightError(
      "credential_invalid",
      `mcp.auth.kind '${auth.kind}' requires its persisted OAuth provider and cannot use a static draft credential`,
    );
  }
  if (!value) {
    throw new McpPreflightError(
      "credential_missing",
      `mcp.auth.kind '${auth.kind}' requires a credential`,
    );
  }

  switch (auth.kind) {
    case "bearer": {
      if (value.mode !== "bearer") {
        throw new McpPreflightError(
          "credential_invalid",
          `expected bearer credential for server, got mode '${value.mode}'`,
        );
      }
      return { Authorization: `Bearer ${value.token}` };
    }
    case "basic": {
      if (value.mode !== "basic") {
        throw new McpPreflightError(
          "credential_invalid",
          `expected basic credential for server, got mode '${value.mode}'`,
        );
      }
      // RFC 7617 — the userid:password pair, base64. Used by remote MCP
      // servers that accept non-interactive personal API tokens (e.g.
      // Atlassian Rovo: base64(email:api_token)).
      const pair = Buffer.from(`${value.username}:${value.password}`, "utf8").toString("base64");
      return { Authorization: `Basic ${pair}` };
    }
  }
}

/**
 * Canonical OAuth callback URL handed to the (non-interactive) handshake
 * provider as its `redirect_uri`. The palette handshake never opens a
 * browser or runs a code exchange, so this value is only used to populate
 * the SDK's `clientMetadata.redirect_uris` on a DCR (RFC 7591) registration.
 *
 * CRITICAL (redirect_uri parity): this MUST be byte-identical to the value
 * the interactive authorize route registers (both go through
 * `buildMcpOAuthRedirectUri` → `MCP_OAUTH_CALLBACK_PATH`). If the pool's DCR
 * registered any other redirect_uri while the authorize flow used the MCP
 * callback, the IdP would reject the authorization request with
 * `redirect_uri_mismatch`. There is deliberately NO fallback when no public
 * origin is configured: the interactive /authorize route 400s in the same
 * condition, so a fallback here would DCR-register a redirect_uri the
 * authorize flow can never use — a permanent `redirect_uri_mismatch`.
 * Instead we throw; `connectClient`'s catch parks the server in
 * error+backoff with this message as its redact-safe `last_error`, the
 * same degradation as any other handshake failure.
 */
export function oauthRedirectUriFor(): string {
  const canonical = buildMcpOAuthRedirectUri();
  if (canonical) return canonical;
  throw new McpPreflightError(
    "config_incomplete",
    "no canonical OAuth redirect URI — set server.public_base_url",
  );
}

/** Detect an Unauthorized/401 from a remote tool call. Matches both the
 *  SDK's typed `UnauthorizedError` and a generic 401 surfaced as a message
 *  (some transports raise a plain Error carrying the HTTP status).
 *
 *  THE MESSAGE MATCH IS ONLY SAFE BEHIND A TRANSPORT VERDICT. `\b401\b`
 *  matches the digit sequence anywhere, including inside a remote's own
 *  complaint about an argument — so the caller must have already
 *  established that no answer arrived before asking this. It is not a
 *  question you can put to an error the peer sent back. */
export function isUnauthorized(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true;
  if (err instanceof Error) {
    if (err.name === "UnauthorizedError") return true;
    if (/\b401\b|\bunauthorized\b/i.test(err.message)) return true;
  }
  return false;
}

/**
 * Drop the oauth2 access/refresh token credential for a server after a
 * mid-session 401, so the next handshake re-authorizes instead of replaying
 * the dead token. No-op for non-oauth2 servers (no token to invalidate) or
 * a vanished server row. Tenant/server-scoped via the provider's own
 * tenant-filtered delete.
 */
export async function invalidateOAuth2TokenForServer(
  db: Db,
  tenant_id: string,
  connector_id: string,
  environment: "dev" | "prod",
  requestSource: RequestSource,
): Promise<void> {
  const row = await getMcpConnector(db, tenant_id, connector_id);
  if (!row) return;
  const auth = row.auth;
  if (auth.kind !== "oauth2") return;
  const provider = new McpDbOAuthClientProvider({
    db,
    tenant_id,
    connector_id,
    environment,
    // Reaching a mid-session 401 implies this oauth2 server connected in
    // this process, which requires the canonical redirect URI to resolve —
    // so this cannot throw here (config is fixed for the process lifetime).
    redirect_uri: oauthRedirectUriFor(),
    state: "",
    auth,
    interactive: false,
    request_source: requestSource,
  });
  await provider.invalidateCredentials("tokens");
  logger.warn({
    module: "mcp_client",
    action: "tool.invoke.token_invalidated",
    msg: "external MCP tool call returned 401; invalidated oauth2 token so the next handshake re-authorizes",
    tenant_id,
    connector_id,
    connector_slug: row.slug,
  });
}
/**
 * Resolve the SDK `OAuthClientProvider` for a server row, or `undefined`
 * when the auth kind uses a static header (bearer / basic / none).
 *
 * - `oauth2` → `McpDbOAuthClientProvider` in non-interactive mode (no
 *   browser, no code exchange; a missing token surfaces as
 *   `UnauthorizedError` on connect and is caught by `connectClient`).
 * - `oauth2_client_credentials` → SDK `ClientCredentialsProvider`. Reads
 *   the client_id + client_secret from the `oauth2_client` credential
 *   slot (same slot used by the interactive oauth2 path). If absent →
 *   throws a clear error (caught → parked in error+backoff).
 * - `oauth2_private_key_jwt` → SDK `PrivateKeyJwtProvider`. Reads the
 *   client_id, private_key, and algorithm from the `oauth2_private_key`
 *   credential slot. If absent → throws (caught → parked).
 *
 * Both M2M providers discover the token endpoint via RFC 9728 off
 * `base_url` — the `issuer` field in `auth_config` is documentation-only.
 * Both cache their access token in-memory (no `saveTokens` persistence);
 * only the long-lived secret (client_secret / private_key) is stored
 * encrypted in `credentials`.
 */
export async function resolveAuthProvider(
  db: Db,
  tenant_id: string,
  row: McpConnectorRow,
  auth: McpAuthConfig,
  environment: "dev" | "prod",
  requestSource: RequestSource,
): Promise<OAuthClientProvider | undefined> {
  switch (auth.kind) {
    case "oauth2":
      return new McpDbOAuthClientProvider({
        db,
        tenant_id,
        connector_id: row.id,
        environment,
        // Throws when no canonical redirect URI is configured — caught
        // by connectClient and parked as a redact-safe last_error + backoff.
        redirect_uri: oauthRedirectUriFor(),
        // No mcp_oauth_states row exists for the palette handshake; the
        // state value is unused in non-interactive mode.
        state: "",
        auth,
        interactive: false,
        request_source: requestSource,
      });

    case "oauth2_client_credentials": {
      // Read the client_secret from the `oauth2_client` credential slot,
      // which is where the route handler writes it (same slot as DCR
      // for the interactive oauth2 path).
      const cred = await getOAuth2ClientCredential(tenant_id, row.id, environment, db);
      if (cred == null) {
        throw new McpPreflightError(
          "credential_missing",
          "oauth2_client_credentials server has no client credential — register the client_id and client_secret first",
        );
      }
      if (!cred.client_secret) {
        throw new McpPreflightError(
          "credential_invalid",
          "oauth2_client_credentials server credential is missing client_secret",
        );
      }
      return new ClientCredentialsProvider({
        clientId: cred.client_id,
        clientSecret: cred.client_secret,
        ...(auth.scope ? { scope: auth.scope } : {}),
      });
    }

    case "oauth2_private_key_jwt": {
      // Read the private_key + algorithm from the `oauth2_private_key`
      // credential slot (distinct from the `oauth2_client` slot).
      const cred = await getOAuth2PrivateKeyCredential(tenant_id, row.id, environment, db);
      if (cred == null) {
        throw new McpPreflightError(
          "credential_missing",
          "oauth2_private_key_jwt server has no private key credential — register the client_id, private_key, and algorithm first",
        );
      }
      return new PrivateKeyJwtProvider({
        clientId: cred.client_id,
        privateKey: cred.private_key,
        algorithm: cred.algorithm,
        ...(auth.scope ? { scope: auth.scope } : {}),
      });
    }

    default:
      // bearer / basic / none — no provider; static header path.
      return undefined;
  }
}
