// OAuth2 client wrappers over `openid-client` v6. Each grant helper
// returns a uniform `OAuth2TokenBundle` regardless of the underlying
// grant type, so the caller (refresh worker, oauth callback route,
// client-credentials startup) doesn't need to know which specific
// openid-client function to call.
//
// openid-client v6 is the functional shape — `discovery()`,
// `authorizationCodeGrant()`, `refreshTokenGrant()`,
// `clientCredentialsGrant()`, `buildAuthorizationUrl()`,
// `randomPKCECodeVerifier()`, `calculatePKCECodeChallenge()`.

import * as oauth from "openid-client";
import { logger } from "../../logging/logger.ts";
import {
  type OAuth2ClientConfig,
  type OAuth2TokenBundle,
  type RFC7591ClientMetadata,
  RFC7591ClientMetadataSchema,
  RFC7591ClientRegistrationResponseSchema,
} from "./types.ts";

const configCache = new Map<string, oauth.Configuration>();

function cacheKey(cfg: OAuth2ClientConfig): string {
  return `${cfg.issuer_url}|${cfg.client_id}|${cfg.token_auth_method ?? "body"}`;
}

function resolveClientAuth(cfg: OAuth2ClientConfig): oauth.ClientAuth | undefined {
  if (!cfg.client_secret) return undefined;
  if (cfg.token_auth_method === "basic_auth") {
    return oauth.ClientSecretBasic(cfg.client_secret);
  }
  // Default: "body" — post client_id/client_secret in the request body.
  return oauth.ClientSecretPost(cfg.client_secret);
}

async function getConfig(cfg: OAuth2ClientConfig): Promise<oauth.Configuration> {
  const key = cacheKey(cfg);
  const existing = configCache.get(key);
  if (existing) return existing;
  const server = new URL(cfg.issuer_url);
  const clientAuth = resolveClientAuth(cfg);

  // If the caller hands us explicit authorization_endpoint + token_endpoint,
  // we skip the discovery round-trip. That keeps templates that don't
  // publish /.well-known (Trello, Asana, early-access APIs) functional.
  let configuration: oauth.Configuration;
  if (cfg.authorization_endpoint && cfg.token_endpoint) {
    configuration = new oauth.Configuration(
      {
        issuer: cfg.issuer_url,
        authorization_endpoint: cfg.authorization_endpoint,
        token_endpoint: cfg.token_endpoint,
      },
      cfg.client_id,
      cfg.client_secret,
      clientAuth,
    );
  } else {
    const discoveryOptions: oauth.DiscoveryRequestOptions =
      server.protocol === "http:" ? { execute: [oauth.allowInsecureRequests] } : {};
    configuration = await oauth.discovery(
      server,
      cfg.client_id,
      cfg.client_secret,
      clientAuth,
      discoveryOptions,
    );
  }
  if (server.protocol === "http:") {
    oauth.allowInsecureRequests(configuration);
  }
  configCache.set(key, configuration);
  return configuration;
}

export function __resetOAuth2CacheForTests(): void {
  configCache.clear();
}

function toBundle(
  res: oauth.TokenEndpointResponse & oauth.TokenEndpointResponseHelpers,
): OAuth2TokenBundle {
  const expires_in = res.expiresIn();
  const expires_at =
    typeof expires_in === "number" ? new Date(Date.now() + Math.max(0, expires_in) * 1000) : null;
  return {
    access_token: res.access_token ?? "",
    token_type: (res.token_type as string | undefined) ?? "Bearer",
    expires_at,
    refresh_token: (res.refresh_token as string | undefined) ?? null,
    scope: (res.scope as string | undefined) ?? null,
  };
}

/**
 * Pre-expiry check. Returns `true` if the token is missing, has no expiry, or
 * is within `bufferMs` of expiry. Callers should treat `true` as "refresh
 * before use" to avoid mid-request 401 retries.
 *
 * Default buffer: 5 minutes. The reference impl ships the same value.
 */
export function isTokenExpired(
  bundle: { expires_at?: Date | string | null } | null | undefined,
  bufferMs = 5 * 60_000,
): boolean {
  if (!bundle?.expires_at) return true;
  const expiresAt =
    typeof bundle.expires_at === "string" ? new Date(bundle.expires_at) : bundle.expires_at;
  if (Number.isNaN(expiresAt.getTime())) return true;
  return expiresAt.getTime() - Date.now() <= bufferMs;
}

export interface StartAuthCodeResult {
  authorization_url: string;
  state: string;
  code_verifier: string;
}

/**
 * Build a hosted auth-code URL with PKCE. The caller is responsible for
 * persisting `code_verifier` + `state` until the callback arrives.
 */
/** Detect Google's OAuth issuer family. Matches `accounts.google.com`
 *  + every Google Workspace-suffixed variant used by their consumer
 *  + enterprise SSO endpoints. Used to add `access_type=offline` +
 *  `prompt=consent` so the authorize-code grant returns a
 *  refresh_token (without these two params Google issues a 1-hour
 *  access_token and nothing more). */
function isGoogleIssuer(issuer: string | undefined): boolean {
  if (!issuer) return false;
  try {
    const host = new URL(issuer).host.toLowerCase();
    return (
      host === "accounts.google.com" ||
      host === "oauth2.googleapis.com" ||
      host.endsWith(".accounts.google.com")
    );
  } catch {
    return false;
  }
}

export async function startAuthorizationCode(
  cfg: OAuth2ClientConfig,
): Promise<StartAuthCodeResult> {
  if (!cfg.redirect_uri) {
    throw new Error("startAuthorizationCode requires config.redirect_uri");
  }
  const configuration = await getConfig(cfg);
  const usePkce = cfg.use_pkce !== false; // default true
  const code_verifier = usePkce ? oauth.randomPKCECodeVerifier() : "";
  const state = oauth.randomState();
  const params: Record<string, string> = {
    redirect_uri: cfg.redirect_uri,
    scope: cfg.scope ?? "openid",
    state,
  };
  if (usePkce) {
    const code_challenge = await oauth.calculatePKCECodeChallenge(code_verifier);
    params.code_challenge = code_challenge;
    params.code_challenge_method = "S256";
  }
  if (cfg.audience) params.audience = cfg.audience;
  // Google-specific: without `access_type=offline` + `prompt=consent`,
  // Google's authorization endpoint issues an access_token but NO
  // refresh_token. The token expires in 1 hour and the engine can no
  // longer call the API — operator has to re-authenticate from
  // scratch. Both params are documented at
  // https://developers.google.com/identity/protocols/oauth2/web-server#offline
  // and are no-ops on other providers.
  if (isGoogleIssuer(cfg.issuer_url)) {
    params.access_type = "offline";
    params.prompt = "consent";
  }
  const url = oauth.buildAuthorizationUrl(configuration, params);
  return {
    authorization_url: url.toString(),
    state,
    code_verifier,
  };
}

export interface CompleteAuthCodeParams {
  cfg: OAuth2ClientConfig;
  current_url: URL;
  code_verifier: string;
  state: string;
}

export async function completeAuthorizationCode(
  p: CompleteAuthCodeParams,
): Promise<OAuth2TokenBundle> {
  const configuration = await getConfig(p.cfg);
  const grantOpts: Parameters<typeof oauth.authorizationCodeGrant>[2] = {
    expectedState: p.state,
  };
  if (p.cfg.use_pkce !== false && p.code_verifier) {
    grantOpts.pkceCodeVerifier = p.code_verifier;
  }
  const res = await oauth.authorizationCodeGrant(configuration, p.current_url, grantOpts);
  return toBundle(res);
}

export async function runClientCredentialsGrant(
  cfg: OAuth2ClientConfig,
): Promise<OAuth2TokenBundle> {
  const configuration = await getConfig(cfg);
  const params: Record<string, string> = {};
  if (cfg.scope) params.scope = cfg.scope;
  if (cfg.audience) params.audience = cfg.audience;
  const res = await oauth.clientCredentialsGrant(configuration, params);
  return toBundle(res);
}

/**
 * Resource Owner Password Credentials grant (RFC 6749 §4.3). Auth0,
 * Keycloak, Okta, Cognito Hosted UI all support this — it's the
 * simplest "exchange username+password for an access_token" flow when
 * the upstream IdP is OAuth2-spec-compliant. Cognito's *native* IDP
 * (`InitiateAuth`) is NOT spec-compliant; that case lives in
 * `runCognitoUserPasswordGrant` below.
 */
export async function runPasswordGrant(
  cfg: OAuth2ClientConfig,
  username: string,
  password: string,
): Promise<OAuth2TokenBundle> {
  const configuration = await getConfig(cfg);
  const params: URLSearchParams = new URLSearchParams({
    grant_type: "password",
    username,
    password,
  });
  if (cfg.scope) params.set("scope", cfg.scope);
  if (cfg.audience) params.set("audience", cfg.audience);
  const res = await oauth.genericGrantRequest(configuration, "password", params);
  return toBundle(res);
}

/**
 * AWS Cognito InitiateAuth — `USER_PASSWORD_AUTH` flow. Body shape is
 * proprietary AWS JSON (`{AuthFlow, ClientId, AuthParameters}`) sent
 * directly to `https://cognito-idp.<region>.amazonaws.com/`, with
 * `X-Amz-Target` header. Returns AWS-shaped `AuthenticationResult`
 * (IdToken / AccessToken / RefreshToken / ExpiresIn / TokenType).
 *
 * The wrapper normalises the result into the same `OAuth2TokenBundle`
 * shape every other grant produces. Two notable choices:
 *
 *   1. We persist `IdToken` as `access_token`. Cognito User-Pool /
 *      AppSync auth wants the IdToken in the `Authorization` header,
 *      not the AccessToken. Operators that want AccessToken-on-the-
 *      wire instead can flip `cognito_id_token_priority: false` on the
 *      connector config.
 *   2. We set `token_type: "none"` so `applyAuthMaterial` emits the
 *      raw JWT (no scheme prefix) — AppSync expects exactly that.
 */
export interface CognitoUserPasswordParams {
  region: string;
  client_id: string;
  username: string;
  password: string;
  /** Optional client secret. When set, a SECRET_HASH is computed and
   *  added to AuthParameters. Required for app clients with a secret. */
  client_secret?: string | undefined;
  /** Map AccessToken (default: false → IdToken) into the persisted
   *  access_token slot. AppSync wants IdToken; resource APIs typically
   *  want AccessToken. */
  use_access_token?: boolean | undefined;
}

interface CognitoTokenPayload {
  AuthenticationResult?: {
    IdToken?: string;
    AccessToken?: string;
    RefreshToken?: string;
    ExpiresIn?: number;
    TokenType?: string;
  };
  message?: string;
  __type?: string;
}

function cognitoEndpoint(region: string): string {
  return `https://cognito-idp.${region}.amazonaws.com/`;
}

async function postCognito<T>(
  region: string,
  target: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(cognitoEndpoint(region), {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`cognito ${target} returned ${res.status}: ${text}`);
  }
  return JSON.parse(text) as T;
}

function bundleFromCognito(
  payload: CognitoTokenPayload,
  useAccessToken: boolean,
  prevRefreshToken?: string | null,
): OAuth2TokenBundle {
  const r = payload.AuthenticationResult;
  if (!r || (!r.IdToken && !r.AccessToken)) {
    throw new Error(
      `cognito InitiateAuth returned no tokens: ${payload.message ?? payload.__type ?? "unknown"}`,
    );
  }
  const access = useAccessToken ? r.AccessToken : r.IdToken;
  if (!access) {
    throw new Error(
      `cognito InitiateAuth missing ${useAccessToken ? "AccessToken" : "IdToken"} in result`,
    );
  }
  const expires_at =
    typeof r.ExpiresIn === "number" ? new Date(Date.now() + Math.max(0, r.ExpiresIn) * 1000) : null;
  // `none` so applyAuthMaterial emits the raw JWT — AppSync rejects
  // anything with a `Bearer ` prefix.
  return {
    access_token: access,
    token_type: "none",
    expires_at,
    refresh_token: r.RefreshToken ?? prevRefreshToken ?? null,
    scope: null,
  };
}

export async function runCognitoUserPasswordGrant(
  p: CognitoUserPasswordParams,
): Promise<OAuth2TokenBundle> {
  const params: Record<string, string> = {
    USERNAME: p.username,
    PASSWORD: p.password,
  };
  if (p.client_secret) {
    params.SECRET_HASH = await computeCognitoSecretHash(p.username, p.client_id, p.client_secret);
  }
  const payload = await postCognito<CognitoTokenPayload>(p.region, "InitiateAuth", {
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: p.client_id,
    AuthParameters: params,
  });
  return bundleFromCognito(payload, p.use_access_token === true);
}

export async function runCognitoRefreshTokenGrant(
  p: CognitoUserPasswordParams & { refresh_token: string },
): Promise<OAuth2TokenBundle> {
  const params: Record<string, string> = { REFRESH_TOKEN: p.refresh_token };
  if (p.client_secret) {
    // `username` is required for SECRET_HASH but not used by the
    // refresh path — Cognito ignores it. Caller passes the original
    // login email through.
    params.SECRET_HASH = await computeCognitoSecretHash(p.username, p.client_id, p.client_secret);
  }
  const payload = await postCognito<CognitoTokenPayload>(p.region, "InitiateAuth", {
    AuthFlow: "REFRESH_TOKEN_AUTH",
    ClientId: p.client_id,
    AuthParameters: params,
  });
  return bundleFromCognito(payload, p.use_access_token === true, p.refresh_token);
}

/** HMAC-SHA256(client_secret, username + client_id), base64. Required
 *  by Cognito app clients with a secret. */
async function computeCognitoSecretHash(
  username: string,
  client_id: string,
  client_secret: string,
): Promise<string> {
  const key = new TextEncoder().encode(client_secret);
  const data = new TextEncoder().encode(`${username}${client_id}`);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, data);
  return Buffer.from(sig).toString("base64");
}

export class DynamicRegistrationError extends Error {
  constructor(
    message: string,
    public readonly error_code: string,
  ) {
    super(message);
    this.name = "DynamicRegistrationError";
  }
}

export interface DynamicRegistrationArgs {
  issuerUrl: string;
  clientMetadata: RFC7591ClientMetadata;
  allowInsecureRequests?: boolean;
}

export interface DynamicRegistrationResult {
  clientId: string;
  clientSecret: string | undefined;
  registrationEndpoint: string;
}

export async function dynamicallyRegisterClient(
  args: DynamicRegistrationArgs,
): Promise<DynamicRegistrationResult> {
  RFC7591ClientMetadataSchema.parse(args.clientMetadata);

  const server = new URL(args.issuerUrl);
  const isHttp = server.protocol === "http:";
  const discoveryOptions: oauth.DiscoveryRequestOptions =
    isHttp || args.allowInsecureRequests ? { execute: [oauth.allowInsecureRequests] } : {};

  let configuration: oauth.Configuration;
  try {
    // The `client_id` argument is a placeholder — discovery only needs it
    // to construct a Configuration, and we are about to dynamically issue
    // the real client_id via /register. openid-client v6 has no
    // "discovery-without-client" mode.
    configuration = await oauth.discovery(
      server,
      "dynamic-registration-probe",
      undefined,
      undefined,
      discoveryOptions,
    );
  } catch (err) {
    throw new DynamicRegistrationError(
      `OAuth discovery failed for ${args.issuerUrl}: ${err instanceof Error ? err.message : String(err)}`,
      "discovery_failed",
    );
  }

  const serverMeta = configuration.serverMetadata() as Record<string, unknown>;
  const registrationEndpoint = serverMeta.registration_endpoint as string | undefined;
  if (!registrationEndpoint) {
    throw new DynamicRegistrationError(
      `OAuth server at ${args.issuerUrl} does not advertise a registration_endpoint`,
      "no_registration_endpoint",
    );
  }

  const fetchOpts: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(args.clientMetadata),
  };

  let res: Response;
  try {
    res = await fetch(registrationEndpoint, fetchOpts);
  } catch (err) {
    throw new DynamicRegistrationError(
      `Registration POST to ${registrationEndpoint} failed: ${err instanceof Error ? err.message : String(err)}`,
      "registration_request_failed",
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new DynamicRegistrationError(
      `Registration endpoint returned ${res.status}: ${body}`,
      `registration_http_${res.status}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new DynamicRegistrationError(
      "Registration endpoint returned non-JSON response",
      "registration_response_invalid",
    );
  }

  const registration = RFC7591ClientRegistrationResponseSchema.safeParse(parsed);
  if (!registration.success) {
    throw new DynamicRegistrationError(
      `Registration response failed schema validation: ${registration.error.message}`,
      "registration_response_invalid",
    );
  }

  logger.info({
    module: "oauth2",
    action: "oauth2.dynamic_registration.succeeded",
    msg: "dynamic client registration succeeded",
    issuer_url_host: server.host,
    registration_endpoint_host: new URL(registrationEndpoint).host,
  });

  return {
    clientId: registration.data.client_id,
    clientSecret: registration.data.client_secret,
    registrationEndpoint,
  };
}

export async function runRefreshTokenGrant(
  cfg: OAuth2ClientConfig,
  refresh_token: string,
): Promise<OAuth2TokenBundle> {
  const configuration = await getConfig(cfg);
  const params: Record<string, string> = {};
  if (cfg.scope) params.scope = cfg.scope;
  try {
    const res = await oauth.refreshTokenGrant(configuration, refresh_token, params);
    return toBundle(res);
  } catch (err) {
    logger.warn({
      module: "oauth2",
      action: "oauth2.refresh_failed",
      msg: "refresh token grant failed",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
