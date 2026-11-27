import { createHash } from "node:crypto";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { and, desc, eq, gt } from "drizzle-orm";
import type { LocalMcpScope } from "../../connectors/index.ts";
import { getDriverFetch, guardedFetch } from "../../connectors/index.ts";
import type { CredentialUseSnapshot, VerifiedProviderIdentity } from "../../credentials/index.ts";
import {
  getCredentialForConnector,
  getOAuth2ClientCredential,
  rotateOAuth2Tokens,
  upsertCredential,
} from "../../credentials/service.ts";
import type { Db } from "../../db/client.ts";
import { withTenantScope } from "../../db/index.ts";
import { mcpOauthStates, vaultItems } from "../../db/schema/index.ts";
import { logger } from "../../logging/index.ts";
import type { RequestSource } from "../../observability/service-metadata.ts";
import { now } from "../../utils/clock.ts";
import {
  captureMcpCredentialGeneration,
  observedMcpCredentialGeneration,
  observedMcpCredentialId,
} from "./credential-observation.ts";
import { type RegistrationAuthMethod, registrationAuthMethod } from "./registration-method.ts";
import type { McpAuthConfig } from "./registry.ts";
import { updateMcpAuthConfig } from "./registry.ts";
import { OAuthTokenEvidence } from "./token-response-evidence.ts";

const CLIENT_NAME = "subkit-mcp-client";

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
  local_mcp?: LocalMcpScope;
}

export class McpDbOAuthClientProvider implements OAuthClientProvider {
  private readonly credentialSnapshots = new Map<string, CredentialUseSnapshot | null>();
  private snapshotCapacityReached = false;
  private readonly tokenEvidence: OAuthTokenEvidence;
  private readonly responseCredentials = new Map<
    string,
    { generation: number | undefined; credential_id: string | undefined } | null
  >();
  private responseCredentialCapacityReached = false;
  private clientRegistered = false;
  private supportedAuthMethods: readonly string[] | undefined;

  get registrationMethod(): RegistrationAuthMethod {
    return registrationAuthMethod(this.supportedAuthMethods);
  }

  get registeredClient(): boolean {
    return this.clientRegistered;
  }

  readonly fetch = async (
    target: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const generation = observedMcpCredentialGeneration(this.connector_id);
    const credentialId = observedMcpCredentialId(this.connector_id);
    const tokenRequest = this.tokenEvidence.isTokenRequest(target, init);
    const response = await guardedFetch(
      {
        tenant_id: this.tenant_id,
        exec: this.db,
        ...(this.local_mcp ? { local_mcp: this.local_mcp } : {}),
      },
      getDriverFetch(),
    )(target, init);
    if (tokenRequest && response.ok) {
      const readJson = response.json.bind(response);
      response.json = async () => {
        const body: unknown = await readJson();
        if (
          body &&
          typeof body === "object" &&
          "access_token" in body &&
          typeof body.access_token === "string" &&
          body.access_token
        ) {
          this.captureResponseCredential(body.access_token, generation, credentialId);
        }
        return body;
      };
    }
    await this.observeTokenResponse(target, init, response, generation);
    return response;
  };

  private captureResponseCredential(
    token: string,
    generation: number | undefined,
    credential_id: string | undefined,
  ): void {
    if (this.responseCredentialCapacityReached) return;
    const key = createHash("sha256").update(token).digest("hex");
    if (this.responseCredentials.has(key)) {
      if (
        this.responseCredentials.get(key)?.generation !== generation ||
        this.responseCredentials.get(key)?.credential_id !== credential_id
      )
        this.responseCredentials.set(key, null);
    } else if (this.responseCredentials.size >= 32) {
      this.responseCredentialCapacityReached = true;
      this.responseCredentials.clear();
    } else this.responseCredentials.set(key, { generation, credential_id });
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.supportedAuthMethods =
      state.authorizationServerMetadata?.token_endpoint_auth_methods_supported;
    this.tokenEvidence.saveDiscoveryState(state);
  }

  observeTokenResponse(
    target: Parameters<typeof fetch>[0],
    init: RequestInit | undefined,
    response: Response,
    generation: number | undefined,
  ): Promise<void> {
    return this.tokenEvidence.observeResponse(target, init, response, generation);
  }

  private tokenIdentity(tokens: OAuthTokens): VerifiedProviderIdentity | null {
    return this.tokenEvidence.identity(
      tokens.access_token,
      observedMcpCredentialGeneration(this.connector_id),
    );
  }

  credentialSnapshot(token: string): CredentialUseSnapshot | null {
    if (this.snapshotCapacityReached) return null;
    return this.credentialSnapshots.get(createHash("sha256").update(token).digest("hex")) ?? null;
  }

  private readonly db: Db;
  private readonly tenant_id: string;
  private readonly connector_id: string;
  private readonly environment: "dev" | "prod";
  private readonly redirect_uri: string;
  private readonly _state: string;
  private readonly auth: McpAuthConfig;
  private readonly interactive: boolean;
  private readonly request_source: RequestSource;
  private readonly local_mcp: LocalMcpScope | undefined;

  constructor(input: McpDbOAuthClientProviderInput) {
    this.local_mcp = input.local_mcp;
    this.tokenEvidence = new OAuthTokenEvidence(input.auth.issuer);
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
      token_endpoint_auth_method: this.registrationMethod,
    };
    if (this.auth.scope !== undefined) metadata.scope = this.auth.scope;
    return metadata;
  }

  state(): string {
    return this._state;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const cred = await getOAuth2ClientCredential(
      this.tenant_id,
      this.connector_id,
      this.environment,
      this.db,
    );
    if (cred) {
      if (!cred.issuer) return undefined;
      const info: OAuthClientInformation = { client_id: cred.client_id, issuer: cred.issuer };
      if (cred.client_secret !== undefined) info.client_secret = cred.client_secret;
      return info;
    }
    if (this.auth.client_id && this.auth.issuer) {
      return this.auth.token_endpoint_auth_method
        ? {
            client_id: this.auth.client_id,
            issuer: this.auth.issuer,
            redirect_uris: [this.redirect_uri],
            token_endpoint_auth_method: this.auth.token_endpoint_auth_method,
          }
        : { client_id: this.auth.client_id, issuer: this.auth.issuer };
    }
    return undefined;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    if (!info.issuer) throw new Error("OAuth client issuer binding is required");
    const registered = "redirect_uris" in info;
    const method =
      "token_endpoint_auth_method" in info && info.token_endpoint_auth_method
        ? info.token_endpoint_auth_method
        : registered
          ? this.registrationMethod
          : undefined;
    const client_secret = method === "none" ? undefined : info.client_secret;
    await upsertCredential(
      {
        tenant_id: this.tenant_id,
        connector_id: this.connector_id,
        environment: this.environment,
        mode: "oauth2_client",
        value: {
          mode: "oauth2_client",
          issuer: info.issuer,
          client_id: info.client_id,
          ...(client_secret !== undefined ? { client_secret } : {}),
        },
        actor_id: null,
        source: "oauth_callback",
      },
      this.db,
    );
    const next: McpAuthConfig = {
      ...this.auth,
      kind: "oauth2",
      client_id: info.client_id,
      redirect_uri: this.redirect_uri,
    };
    await updateMcpAuthConfig(this.db, this.tenant_id, this.connector_id, next, {
      actor_id: null,
      request_source: this.request_source,
    });
    this.clientRegistered = registered;
    logger.info({
      module: "mcp_oauth",
      action: "client.registered",
      msg: "persisted dynamically-registered OAuth client for external MCP server",
      tenant_id: this.tenant_id,
      connector_id: this.connector_id,
      state_prefix: this._state.slice(0, 8),
      token_endpoint_auth_method: method ?? null,
      has_secret: client_secret !== undefined,
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
    if (!v.access_token || !v.issuer) return undefined;
    captureMcpCredentialGeneration(
      this.connector_id,
      resolved.row.credential_generation,
      resolved.row.id,
    );
    const expiresAt = resolved.row.oauth2_expires_at ?? null;
    const expired = expiresAt ? expiresAt.getTime() <= now() : false;
    if (expired && !v.refresh_token) return undefined;
    const out: OAuthTokens = {
      issuer: v.issuer,
      access_token: v.access_token,
      token_type: v.token_type || "Bearer",
    };
    if (v.scope !== undefined) out.scope = v.scope;
    if (v.refresh_token) out.refresh_token = v.refresh_token;
    if (expiresAt) {
      const secs = Math.floor((expiresAt.getTime() - now()) / 1000);
      out.expires_in = secs > 0 ? secs : 0;
    }
    const key = createHash("sha256").update(v.access_token).digest("hex");
    const snapshot = resolved.credential_snapshot ?? {
      connector_id: this.connector_id,
      environment: this.environment,
      credential_id: resolved.row.id,
      credential_generation: resolved.row.credential_generation,
      connection_id: null,
      access_token_version: null,
      identity: resolved.row.verified_identity,
    };
    if (!this.snapshotCapacityReached) {
      if (
        this.credentialSnapshots.has(key) &&
        JSON.stringify(this.credentialSnapshots.get(key)) !== JSON.stringify(snapshot)
      ) {
        this.credentialSnapshots.set(key, null);
      } else if (!this.credentialSnapshots.has(key)) {
        if (this.credentialSnapshots.size >= 32) {
          this.snapshotCapacityReached = true;
          this.credentialSnapshots.clear();
        } else this.credentialSnapshots.set(key, snapshot);
      }
    }
    return out;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    if (!tokens.issuer) throw new Error("OAuth token issuer binding is required");
    const responseCredential = this.responseCredentialCapacityReached
      ? null
      : this.responseCredentials.get(
          createHash("sha256").update(tokens.access_token).digest("hex"),
        );
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
    if (
      !refresh &&
      prior?.value.mode === "oauth2" &&
      prior.value.issuer &&
      new URL(prior.value.issuer).href === new URL(tokens.issuer).href
    )
      refresh = prior.value.refresh_token;
    const expiresAt =
      typeof tokens.expires_in === "number" ? new Date(now() + tokens.expires_in * 1000) : null;
    if (!this.interactive) {
      if (prior?.value.mode !== "oauth2" || !prior.value.issuer || prior.row.connection_id) {
        throw new Error("interactive authorization required before tokens can be saved");
      }
      if (
        typeof responseCredential?.generation !== "number" ||
        !responseCredential.credential_id ||
        responseCredential.credential_id !== prior.row.id
      )
        throw Object.assign(
          new Error("The refresh response has no unambiguous credential binding."),
          { code: "credential_generation_changed" },
        );
      await rotateOAuth2Tokens(
        {
          tenant_id: this.tenant_id,
          credential_id: responseCredential.credential_id,
          expected_generation: responseCredential.generation,
          issuer: tokens.issuer,
          access_token: tokens.access_token,
          verified_identity: this.tokenIdentity(tokens),
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
          verified_identity: this.tokenIdentity(tokens),
          mode: "oauth2",
          value: {
            mode: "oauth2",
            issuer: tokens.issuer,
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
      state_prefix: this._state.slice(0, 8),
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
        const row_id = resolved.row.id;
        await withTenantScope(this.db, this.tenant_id, (tx) =>
          tx
            .delete(vaultItems)
            .where(and(eq(vaultItems.tenant_id, this.tenant_id), eq(vaultItems.id, row_id))),
        );
      }
    }
    if (scope === "client" || scope === "all") {
      await withTenantScope(this.db, this.tenant_id, (tx) =>
        tx
          .delete(vaultItems)
          .where(
            and(
              eq(vaultItems.tenant_id, this.tenant_id),
              eq(vaultItems.connector_id, this.connector_id),
              eq(vaultItems.environment, this.environment),
              eq(vaultItems.mode, "oauth2_client"),
            ),
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
