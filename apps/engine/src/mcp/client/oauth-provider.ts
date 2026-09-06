// DB-backed `OAuthClientProvider` for the external-MCP CLIENT direction
// (interactive OAuth 2.1 + PKCE against an OAuth-only
// external MCP server).
//
// subkit acts as an OAuth *client* against an external MCP server. The
// `@modelcontextprotocol/sdk` transports drive the whole dance through
// the `OAuthClientProvider` interface: they ask us for client identity,
// tokens, and the PKCE verifier, and they hand us back freshly-minted
// tokens (and, on dynamic registration, a freshly-issued client) to
// persist. This class wires every one of those callbacks onto subkit's
// existing durable stores so the flow survives a process restart and the
// SDK's built-in pre-expiry refresh persists automatically.
//
// STORAGE MAPPING (where each piece of state lives):
//   - client_id + client_secret  → `credentials` (mode "oauth2_client")
//                                   keyed by connector_id. The non-secret
//                                   client_id is ALSO mirrored into
//                                   `connectors.config.mcp.auth.client_id`.
//   - access/refresh token + exp  → `credentials` (mode "oauth2") keyed
//                                   by connector_id.
//   - PKCE code_verifier          → `mcp_oauth_states.code_verifier`,
//                                   the in-flight authorization row keyed
//                                   by `state`.
//   - authorization_url           → `mcp_oauth_states.authorization_url`
//                                   (interactive only).
//   - authorization-server origin → `mcp_oauth_states.as_issuer`
//                                   (interactive only; RFC 9207 iss check).
//
// SECRET-BY-REFERENCE: token material and client_secret live ONLY in the
// AES-256-GCM `credentials` table. They NEVER touch `mcp_oauth_states`,
// `connectors.config.mcp.auth`, or the logs.
//
// INTERACTIVE vs NON-INTERACTIVE: the pool's palette handshake constructs
// this provider with `interactive: false` and NO `mcp_oauth_states` row.
// In that mode the SDK can still replay an existing token and refresh it,
// but it must NEVER open a browser or persist an orphan authorization
// URL — `redirectToAuthorization` is a no-op there, and the transport
// surfaces `UnauthorizedError` on connect (the pool parks the server in
// backoff). The interactive authorize/callback routes own the actual
// browser round-trip, and only those construct this with `interactive:
// true` against a live state row.
//
// GENERIC: no Atlassian/Rovo literal — RFC 9728 / RFC 8414 discovery is
// driven by the SDK off the server URL.

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { and, desc, eq, gt } from "drizzle-orm";
import {
  getCredentialForConnector,
  getOAuth2ClientCredential,
  rotateOAuth2Tokens,
  upsertCredential,
} from "../../credentials/service.ts";
import type { Db } from "../../db/client.ts";
import { credentials, mcpOauthStates } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import type { RequestSource } from "../../observability/service-metadata.ts";
import { now } from "../../utils/clock.ts";
import type { McpAuthConfig } from "./registry.ts";
import { updateMcpAuthConfig } from "./registry.ts";

/** Identity the SDK presents to the external server's IdP on
 *  registration / authorization. The DCR (RFC 7591) request body is
 *  derived from this; a server with a pre-provisioned client ignores most
 *  of it and only needs the client_id from `clientInformation()`. */
const CLIENT_NAME = "sk-mcp-client";

export interface McpDbOAuthClientProviderInput {
  db: Db;
  tenant_id: string;
  connector_id: string;
  environment: "dev" | "prod";
  /** The OAuth redirect URI the authorize route registered + persisted on
   *  the `mcp_oauth_states` row. For the non-interactive pool handshake it
   *  is the same canonical callback URL (never browser-opened). */
  redirect_uri: string;
  /** The flow's `state` string. For interactive flows this matches the
   *  `mcp_oauth_states.state` row the authorize route created. For the
   *  pool's non-interactive palette handshake there is NO state row; the
   *  value is unused (no verifier/URL persistence happens). */
  state: string;
  /** Non-secret oauth2 shape from `connectors.config.mcp.auth`. */
  auth: McpAuthConfig;
  /** True only on the authorize/callback browser round-trip. False for
   *  the pool's palette handshake — `redirectToAuthorization` no-ops and
   *  the verifier callbacks have no row to read/write. */
  interactive: boolean;
  /** Surface that drove this flow (route → api/cli, pool handshake →
   *  chat, …). Stamped onto the `connector.mcp_client_registered` audit
   *  rows the provider writes when it mirrors / clears the registered
   *  client_id on the connector config, so those rows attribute to the
   *  real entry point instead of a hard-coded one. */
  request_source: RequestSource;
}

export class McpDbOAuthClientProvider implements OAuthClientProvider {
  private readonly db: Db;
  private readonly tenant_id: string;
  private readonly connector_id: string;
  private readonly environment: "dev" | "prod";
  private readonly redirect_uri: string;
  private readonly _state: string;
  private readonly auth: McpAuthConfig;
  private readonly interactive: boolean;
  private readonly request_source: RequestSource;

  constructor(input: McpDbOAuthClientProviderInput) {
    this.db = input.db;
    this.tenant_id = input.tenant_id;
    this.connector_id = input.connector_id;
    this.environment = input.environment;
    this.redirect_uri = input.redirect_uri;
    this._state = input.state;
    this.auth = input.auth;
    this.interactive = input.interactive;
    this.request_source = input.request_source;
  }

  get redirectUrl(): string {
    return this.redirect_uri;
  }

  get clientMetadata(): OAuthClientMetadata {
    const metadata: OAuthClientMetadata = {
      client_name: CLIENT_NAME,
      redirect_uris: [this.redirect_uri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    };
    if (this.auth.scope !== undefined) metadata.scope = this.auth.scope;
    return metadata;
  }

  state(): string {
    return this._state;
  }

  /**
   * The registered client identity. Prefers the encrypted `oauth2_client`
   * credential (client_id + optional client_secret); falls back to the
   * non-secret `client_id` mirrored on `auth_config`. Returns `undefined`
   * when neither is present — the SDK then performs RFC 7591 dynamic
   * client registration and calls `saveClientInformation`.
   */
  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    const cred = await getOAuth2ClientCredential(
      this.tenant_id,
      this.connector_id,
      this.environment,
      this.db,
    );
    if (cred) {
      const info: OAuthClientInformation = { client_id: cred.client_id };
      if (cred.client_secret !== undefined) info.client_secret = cred.client_secret;
      return info;
    }
    // No registration slot yet — fall back to a pre-provisioned client_id
    // carried (non-secret) on auth_config. A bare client_id with no secret
    // is a public client; the SDK uses PKCE without a client_secret.
    if (this.auth.client_id) {
      return { client_id: this.auth.client_id };
    }
    return undefined;
  }

  /**
   * Persist a dynamically-registered (RFC 7591) client. The client_secret
   * (if the IdP issued one) goes to the encrypted `oauth2_client`
   * credential slot; the non-secret client_id is ALSO mirrored onto
   * `connectors.config.mcp.auth.client_id` so a future provider built before
   * the credential is read still has the id, and operators can see which
   * client is registered without decrypting a secret.
   */
  async saveClientInformation(info: OAuthClientInformation): Promise<void> {
    await upsertCredential(
      {
        tenant_id: this.tenant_id,
        connector_id: this.connector_id,
        environment: this.environment,
        mode: "oauth2_client",
        value: {
          mode: "oauth2_client",
          client_id: info.client_id,
          ...(info.client_secret !== undefined ? { client_secret: info.client_secret } : {}),
        },
        actor_id: null,
        source: "oauth_callback",
      },
      this.db,
    );
    // Mirror the non-secret client_id onto auth_config so it survives
    // independently of the credential read path. Carry the existing
    // issuer/scope forward unchanged.
    const next: McpAuthConfig = { ...this.auth, kind: "oauth2", client_id: info.client_id };
    await updateMcpAuthConfig(this.db, this.tenant_id, this.connector_id, next, {
      actor_id: null,
      request_source: this.request_source,
    });
    logger.info({
      module: "mcp_oauth",
      action: "client.registered",
      msg: "persisted dynamically-registered OAuth client for external MCP server",
      tenant_id: this.tenant_id,
      connector_id: this.connector_id,
      has_secret: info.client_secret !== undefined,
    });
  }

  /**
   * The cached OAuth tokens, if any. `expires_in` is derived from the
   * persisted `oauth2_expires_at` so the SDK's transport refreshes the
   * token PRE-expiry on its own (it treats `expires_in` as seconds from
   * now). Returns `undefined` when the server has no oauth2 credential yet —
   * that is the "needs authorization" signal.
   */
  async tokens(): Promise<OAuthTokens | undefined> {
    const resolved = await getCredentialForConnector(
      this.tenant_id,
      this.connector_id,
      this.environment,
      this.db,
    );
    if (resolved?.value.mode !== "oauth2") return undefined;
    const v = resolved.value;
    if (!v.access_token) return undefined;
    // Expiry lives on the credentials ROW column (`oauth2_expires_at`), which is
    // always populated; `value.expires_at` is only overlaid when a refresh token
    // is present, so a no-refresh token would otherwise read as never-expiring.
    const expiresAt = resolved.row.oauth2_expires_at ?? null;
    const expired = expiresAt ? expiresAt.getTime() <= now() : false;
    // Past local expiry with NO refresh_token: clamping expires_in to 0 would
    // drive an SDK refresh that cannot succeed (nothing to refresh with) — a
    // doomed round-trip. Return undefined instead so the SDK takes the
    // "authorization required" path directly (the pool parks the server for
    // re-auth, or a mid-session 401 already invalidated the token).
    if (expired && !v.refresh_token) return undefined;
    const out: OAuthTokens = {
      access_token: v.access_token,
      token_type: v.token_type || "Bearer",
    };
    if (v.scope !== undefined) out.scope = v.scope;
    if (v.refresh_token) out.refresh_token = v.refresh_token;
    if (expiresAt) {
      const secs = Math.floor((expiresAt.getTime() - now()) / 1000);
      // Refreshable token: a past expiry yields 0 → SDK refreshes pre-emptively.
      out.expires_in = secs > 0 ? secs : 0;
    }
    return out;
  }

  /**
   * Persist freshly-minted tokens (authorization-code exchange OR the
   * SDK's automatic pre-expiry refresh). This is the auto-refresh
   * persistence hook: when the transport refreshes a token mid-session it
   * calls here, and the rotated bundle lands in the encrypted credentials
   * row keyed by connector_id.
   *
   * DETERMINISM: a token write is a credential side-effect, the same
   * posture as the connector refresh-worker — the OAuth dance never enters
   * a replayed turn. Carry the prior refresh token forward when the IdP
   * omits a new one (non-rotating IdPs), so a still-valid refresh token is
   * never wiped.
   */
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    let refresh: string | null = tokens.refresh_token ?? null;
    const prior =
      !this.interactive || !refresh
        ? await getCredentialForConnector(
            this.tenant_id,
            this.connector_id,
            this.environment,
            this.db,
          )
        : null;
    if (!refresh && prior?.value.mode === "oauth2") refresh = prior.value.refresh_token;
    const expiresAt =
      typeof tokens.expires_in === "number" ? new Date(now() + tokens.expires_in * 1000) : null;
    if (!this.interactive) {
      // Only the browser authorization flow establishes a new credential.
      // A pool handshake can refresh an existing grant, not replace identity
      // or detach credentials managed by an outbound connection.
      if (prior?.value.mode !== "oauth2" || prior.row.connection_id) {
        throw new Error("interactive authorization required before tokens can be saved");
      }
      await rotateOAuth2Tokens(
        {
          tenant_id: this.tenant_id,
          credential_id: prior.row.id,
          access_token: tokens.access_token,
          token_type: tokens.token_type,
          scope: tokens.scope,
          refresh_token: refresh,
          expires_at: expiresAt,
          actor_id: null,
        },
        this.db,
      );
    } else
      await upsertCredential(
        {
          tenant_id: this.tenant_id,
          connector_id: this.connector_id,
          environment: this.environment,
          mode: "oauth2",
          value: {
            mode: "oauth2",
            access_token: tokens.access_token,
            token_type: tokens.token_type || "Bearer",
            ...(tokens.scope !== undefined ? { scope: tokens.scope } : {}),
          },
          oauth2_refresh_token: refresh,
          oauth2_expires_at: expiresAt,
          ...(tokens.scope !== undefined ? { oauth2_granted_scopes: tokens.scope } : {}),
          actor_id: null,
          source: "oauth_callback",
        },
        this.db,
      );
    logger.info({
      module: "mcp_oauth",
      action: "tokens.saved",
      msg: "persisted oauth2 tokens for external MCP server",
      tenant_id: this.tenant_id,
      connector_id: this.connector_id,
      has_refresh: refresh != null,
      expires_at: expiresAt?.toISOString() ?? null,
    });
  }

  /**
   * Persist the PKCE code verifier on the in-flight authorization row.
   * Interactive flows only — the verifier is generated as the SDK builds
   * the authorization URL and re-read at the callback to validate the
   * exchange. There is no `mcp_oauth_states` row for the non-interactive
   * pool handshake, so this is a no-op there.
   */
  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    if (!this.interactive) return;
    // Defense in depth: scope the write to (tenant_id, connector_id, state)
    // and a non-expired row. The unique `state` already disambiguates, but
    // pinning connector_id + expiry means a leaked/stale state can never
    // steer a verifier onto the wrong server's in-flight row.
    await this.db
      .update(mcpOauthStates)
      .set({ code_verifier: codeVerifier })
      .where(
        and(
          eq(mcpOauthStates.tenant_id, this.tenant_id),
          eq(mcpOauthStates.connector_id, this.connector_id),
          eq(mcpOauthStates.state, this._state),
          gt(mcpOauthStates.expires_at, new Date(now())),
        ),
      );
  }

  /**
   * Read back the PKCE code verifier for the current flow. Only reachable
   * on the interactive authorize/callback path; a missing or non-existent
   * state row is a hard error (the callback can't validate the exchange
   * without it).
   */
  async codeVerifier(): Promise<string> {
    if (!this.interactive) {
      throw new Error(
        "codeVerifier() is only available for an interactive MCP OAuth flow (no state row in the non-interactive handshake)",
      );
    }
    const rows = await this.db
      .select({ code_verifier: mcpOauthStates.code_verifier })
      .from(mcpOauthStates)
      .where(
        and(
          eq(mcpOauthStates.tenant_id, this.tenant_id),
          eq(mcpOauthStates.connector_id, this.connector_id),
          eq(mcpOauthStates.state, this._state),
          gt(mcpOauthStates.expires_at, new Date(now())),
        ),
      )
      // Prefer the freshest in-flight row if more than one shares the state.
      .orderBy(desc(mcpOauthStates.expires_at))
      .limit(1);
    const verifier = rows[0]?.code_verifier;
    if (!verifier) {
      throw new Error("no PKCE code_verifier on the mcp_oauth_states row for this flow state");
    }
    return verifier;
  }

  /**
   * Direct the user agent to the authorization endpoint. INTERACTIVE
   * GUARD: only the browser round-trip persists the URL (the authorize
   * route reads it off the row and 302s the operator there). The pool's
   * non-interactive palette handshake MUST NOT open anything or write an
   * orphan URL — it is a strict no-op so a connect attempt against an
   * un-authorized server never emits a stray authorization link; instead
   * the transport raises `UnauthorizedError` on connect and the pool parks
   * the server in backoff.
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.interactive) return;
    // Capture the authorization-server origin alongside the URL. The
    // callback re-checks RFC 9207 `iss` against this `as_issuer` origin to
    // detect an AS mix-up (a code returned by a different authorization
    // server than the flow began against). Origin only — no path/query.
    await this.db
      .update(mcpOauthStates)
      .set({
        authorization_url: authorizationUrl.toString(),
        as_issuer: authorizationUrl.origin,
      })
      .where(
        and(eq(mcpOauthStates.tenant_id, this.tenant_id), eq(mcpOauthStates.state, this._state)),
      );
  }

  /**
   * Invalidate credentials the server reported as no longer valid, so the
   * next handshake re-authorizes instead of replaying a dead token. All
   * deletes are tenant-scoped.
   *   - 'tokens' / 'all' : drop the oauth2 access/refresh credential.
   *   - 'client'         : drop the oauth2_client identity AND clear the
   *                        mirrored client_id from auth_config so DCR runs
   *                        afresh.
   *   - 'verifier'       : clear the PKCE verifier on the flow's state row.
   */
  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "tokens" || scope === "all") {
      const resolved = await getCredentialForConnector(
        this.tenant_id,
        this.connector_id,
        this.environment,
        this.db,
      );
      if (resolved) {
        await this.db
          .delete(credentials)
          .where(
            and(eq(credentials.tenant_id, this.tenant_id), eq(credentials.id, resolved.row.id)),
          );
      }
    }
    if (scope === "client" || scope === "all") {
      await this.db
        .delete(credentials)
        .where(
          and(
            eq(credentials.tenant_id, this.tenant_id),
            eq(credentials.connector_id, this.connector_id),
            eq(credentials.environment, this.environment),
            eq(credentials.mode, "oauth2_client"),
          ),
        );
      // Strip the mirrored client_id so the next flow re-registers.
      const next: McpAuthConfig = { kind: "oauth2" };
      if (this.auth.issuer !== undefined) next.issuer = this.auth.issuer;
      if (this.auth.scope !== undefined) next.scope = this.auth.scope;
      await updateMcpAuthConfig(this.db, this.tenant_id, this.connector_id, next, {
        actor_id: null,
        request_source: this.request_source,
      });
    }
    if (scope === "verifier" && this.interactive) {
      await this.db
        .update(mcpOauthStates)
        .set({ code_verifier: "" })
        .where(
          and(eq(mcpOauthStates.tenant_id, this.tenant_id), eq(mcpOauthStates.state, this._state)),
        );
    }
  }

  // validateResourceURL is intentionally left undefined: the SDK derives
  // the RFC 8707 resource indicator from the server URL on its own.
}

/** Factory the authorize/callback routes (and the pool) call to build a
 *  provider. Keeps the constructor shape in one place so callers don't
 *  hand-roll the input object. */
export function makeMcpOAuthProvider(
  input: McpDbOAuthClientProviderInput,
): McpDbOAuthClientProvider {
  return new McpDbOAuthClientProvider(input);
}
