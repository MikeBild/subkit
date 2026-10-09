import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  ClientCredentialsProvider,
  PrivateKeyJwtProvider,
} from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import { getDriverFetch } from "../../connectors/index.ts";
import type { CredentialUseSnapshot } from "../../credentials/index.ts";
import { recordCredentialProviderIdentity } from "../../credentials/index.ts";
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
import { OAuthTokenEvidence } from "./token-response-evidence.ts";

const m2mCredentialBindings = new WeakMap<
  OAuthClientProvider,
  { snapshot: CredentialUseSnapshot; evidence: OAuthTokenEvidence }
>();

function bindM2mCredential(
  provider: OAuthClientProvider,
  snapshot: CredentialUseSnapshot,
  issuer: string | undefined,
  db: Db,
  tenant_id: string,
  requestSource: RequestSource,
): OAuthClientProvider {
  const evidence = new OAuthTokenEvidence(issuer);
  const captured = structuredClone({ ...snapshot, identity: null });
  m2mCredentialBindings.set(provider, { snapshot: captured, evidence });
  provider.saveDiscoveryState = (state) => evidence.saveDiscoveryState(state);
  const saveTokens = provider.saveTokens.bind(provider);
  provider.saveTokens = async (tokens) => {
    await saveTokens(tokens);
    await recordCredentialProviderIdentity(
      {
        tenant_id,
        snapshot: captured,
        identity: evidence.identity(
          tokens.access_token,
          captured.credential_generation ?? undefined,
        ),
        request_source: requestSource,
      },
      db,
    );
  };
  return provider;
}

export async function mcpOAuthCredentialSnapshot(
  provider: OAuthClientProvider,
  token: string,
): Promise<CredentialUseSnapshot | null> {
  if (provider instanceof McpDbOAuthClientProvider) return provider.credentialSnapshot(token);
  const binding = m2mCredentialBindings.get(provider);
  if (!binding || !token || (await provider.tokens())?.access_token !== token) return null;
  return {
    ...binding.snapshot,
    identity: binding.evidence.identity(token, binding.snapshot.credential_generation ?? undefined),
  };
}

export async function fetchWithMcpOAuth(
  provider: OAuthClientProvider,
  target: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  if (provider instanceof McpDbOAuthClientProvider) return provider.fetch(target, init);
  const binding = m2mCredentialBindings.get(provider);
  const generation = binding?.snapshot.credential_generation ?? undefined;
  const response = await getDriverFetch()(target, init);
  await binding?.evidence.observeResponse(target, init, response, generation);
  return response;
}

export async function resolveAuthHeaders(
  db: Db,
  tenant_id: string,
  connector_id: string,
  auth: McpAuthConfig,
  environment: "dev" | "prod",
): Promise<Record<string, string>> {
  return (await resolveAuthMaterial(db, tenant_id, connector_id, auth, environment)).headers;
}

export async function resolveAuthMaterial(
  db: Db,
  tenant_id: string,
  connector_id: string,
  auth: McpAuthConfig,
  environment: "dev" | "prod",
): Promise<{ headers: Record<string, string>; snapshot: CredentialUseSnapshot | null }> {
  if (auth.kind === "none") return { headers: {}, snapshot: null };
  if (
    auth.kind === "oauth2" ||
    auth.kind === "oauth2_client_credentials" ||
    auth.kind === "oauth2_private_key_jwt"
  )
    return { headers: {}, snapshot: null };

  const resolved = await getCredentialForConnector(tenant_id, connector_id, environment, db);
  if (!resolved) {
    throw new McpPreflightError(
      "credential_missing",
      `mcp.auth.kind '${auth.kind}' references a credential that does not exist for this connector`,
    );
  }
  return {
    headers: resolveStaticAuthHeaders(auth, resolved.value),
    snapshot: resolved.credential_snapshot ?? {
      connector_id,
      environment,
      credential_id: resolved.row.id,
      credential_generation: resolved.row.credential_generation,
      connection_id: null,
      access_token_version: null,
      identity: resolved.row.verified_identity,
    },
  };
}

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
      assertHeaderSafe(value.token, "bearer token");
      return { Authorization: `Bearer ${value.token}` };
    }
    case "basic": {
      if (value.mode !== "basic") {
        throw new McpPreflightError(
          "credential_invalid",
          `expected basic credential for server, got mode '${value.mode}'`,
        );
      }
      assertHeaderSafe(value.username, "basic username");
      assertHeaderSafe(value.password, "basic password");
      const pair = Buffer.from(`${value.username}:${value.password}`, "utf8").toString("base64");
      return { Authorization: `Basic ${pair}` };
    }
    case "header": {
      if (value.mode !== "header") {
        throw new McpPreflightError(
          "credential_invalid",
          `expected header credential for server, got mode '${value.mode}'`,
        );
      }
      const names = Object.keys(value.headers);
      if (names.length === 0) {
        throw new McpPreflightError(
          "credential_invalid",
          "header credential for server carries no header",
        );
      }
      for (const name of names) {
        if (!HTTP_TOKEN_RE.test(name) || TRANSPORT_OWNED_HEADERS.has(name.toLowerCase())) {
          throw new McpPreflightError(
            "credential_invalid",
            `header '${name}' cannot carry a credential to an MCP server`,
          );
        }
        assertHeaderSafe(value.headers[name] ?? "", `value of header '${name}'`);
      }
      return { ...value.headers };
    }
  }
}

function assertHeaderSafe(value: string, part: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new McpPreflightError(
      "credential_invalid",
      `the ${part} contains a line break or NUL character; re-enter the credential without it`,
    );
  }
}

const HTTP_TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const TRANSPORT_OWNED_HEADERS = new Set([
  "accept",
  "content-type",
  "content-length",
  "host",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
]);

export function oauthRedirectUriFor(): string {
  const canonical = buildMcpOAuthRedirectUri();
  if (canonical) return canonical;
  throw new McpPreflightError(
    "config_incomplete",
    "no canonical OAuth redirect URI — set server.public_base_url",
  );
}

export function isUnauthorized(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true;
  if (err instanceof Error) {
    if (err.name === "UnauthorizedError") return true;
    if (/\b401\b|\bunauthorized\b/i.test(err.message)) return true;
  }
  return false;
}

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
        redirect_uri: oauthRedirectUriFor(),
        state: "",
        auth,
        interactive: false,
        request_source: requestSource,
      });

    case "oauth2_client_credentials": {
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
      return bindM2mCredential(
        new ClientCredentialsProvider({
          clientId: cred.client_id,
          clientSecret: cred.client_secret,
          ...(auth.scope ? { scope: auth.scope } : {}),
        }),
        cred.credential_snapshot,
        auth.issuer,
        db,
        tenant_id,
        requestSource,
      );
    }

    case "oauth2_private_key_jwt": {
      const cred = await getOAuth2PrivateKeyCredential(tenant_id, row.id, environment, db);
      if (cred == null) {
        throw new McpPreflightError(
          "credential_missing",
          "oauth2_private_key_jwt server has no private key credential — register the client_id, private_key, and algorithm first",
        );
      }
      return bindM2mCredential(
        new PrivateKeyJwtProvider({
          clientId: cred.client_id,
          privateKey: cred.private_key,
          algorithm: cred.algorithm,
          ...(auth.scope ? { scope: auth.scope } : {}),
        }),
        cred.credential_snapshot,
        auth.issuer,
        db,
        tenant_id,
        requestSource,
      );
    }

    default:
      return undefined;
  }
}
