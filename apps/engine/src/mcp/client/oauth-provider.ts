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

const CLIENT_NAME = "sk-mcp-client";

export interface McpDbOAuthClientProviderInput {
  db: Db;
  tenant_id: string;
  connector_id: string;
  environment: "dev" | "prod";
  redirect_uri: string;
  state: string;
  auth: McpAuthConfig;
  interactive: boolean;
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
    if (this.auth.client_id) {
      return { client_id: this.auth.client_id };
    }
    return undefined;
  }

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
    const expiresAt = resolved.row.oauth2_expires_at ?? null;
    const expired = expiresAt ? expiresAt.getTime() <= now() : false;
    if (expired && !v.refresh_token) return undefined;
    const out: OAuthTokens = {
      access_token: v.access_token,
      token_type: v.token_type || "Bearer",
    };
    if (v.scope !== undefined) out.scope = v.scope;
    if (v.refresh_token) out.refresh_token = v.refresh_token;
    if (expiresAt) {
      const secs = Math.floor((expiresAt.getTime() - now()) / 1000);
      out.expires_in = secs > 0 ? secs : 0;
    }
    return out;
  }

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

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    if (!this.interactive) return;
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
      .orderBy(desc(mcpOauthStates.expires_at))
      .limit(1);
    const verifier = rows[0]?.code_verifier;
    if (!verifier) {
      throw new Error("no PKCE code_verifier on the mcp_oauth_states row for this flow state");
    }
    return verifier;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.interactive) return;
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
}

export function makeMcpOAuthProvider(
  input: McpDbOAuthClientProviderInput,
): McpDbOAuthClientProvider {
  return new McpDbOAuthClientProvider(input);
}
