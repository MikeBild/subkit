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
import type { OAuth2ClientConfig, OAuth2TokenBundle } from "./types.ts";

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

export interface StartAuthCodeResult {
  authorization_url: string;
  state: string;
  code_verifier: string;
}

/**
 * Build a hosted auth-code URL with PKCE. The caller is responsible for
 * persisting `code_verifier` + `state` until the callback arrives.
 */
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

// ---------------------------------------------------------------------------
// JWT Bearer grant (RFC 7523)
//
// One IdP, two flavours:
//
//   * GCP service accounts: sign a JWT with the service-account private
//     key (RS256), POST to `https://oauth2.googleapis.com/token` with
//     `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`. The
//     authorization server validates the signature against the
//     publicly-known service account public key, returns an OAuth2
//     access token.
//
//   * Salesforce Connected Apps with JWT bearer flow: sign a JWT with
//     the connected-app private key, POST to
//     `<instance>/services/oauth2/token`, same grant_type URN.
//
// Caller pre-signs the assertion (we provide the helper) and hands it
// to `runJwtBearerGrant`. The grant has no refresh_token — every call
// re-signs and re-exchanges. Cheap because RS256 sign is sub-millisecond
// and tokens cache for ~1h.
// ---------------------------------------------------------------------------

export interface JwtAssertionClaims {
  /** Issuer — service account email (GCP) or connected-app client_id (Salesforce). */
  iss: string;
  /** Subject — user email being impersonated, or service-account email. */
  sub: string;
  /** Audience — the token endpoint URL. */
  aud: string;
  /** OAuth scopes (space-delimited). GCP uses `scope`, Salesforce ignores. */
  scope?: string;
  /** Expiration — seconds since epoch. Defaults to now + 60s. */
  exp?: number;
  /** Issued-at. Defaults to now. */
  iat?: number;
  /** Extra provider-specific claims (Atlassian needs `qsh`, etc.). */
  [key: string]: unknown;
}

export interface SignAssertionParams {
  /** PEM-encoded private key. RS256 requires PKCS#8 RSA; ES256 requires
   *  EC P-256. */
  private_key_pem: string;
  algorithm?: "RS256" | "ES256";
  claims: JwtAssertionClaims;
  /** Optional `kid` header — required by some IdPs (Atlassian, AzureAD with cert). */
  key_id?: string;
}

function base64UrlEncode(buf: ArrayBuffer | Uint8Array | Buffer): string {
  const b = Buffer.isBuffer(buf)
    ? buf
    : buf instanceof Uint8Array
      ? Buffer.from(buf)
      : Buffer.from(new Uint8Array(buf));
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Sign an assertion JWT for the JWT-Bearer grant. Pure function — no
 *  network. The result is the compact-JWT string (`<header>.<payload>.<sig>`). */
export async function signServiceAccountAssertion(p: SignAssertionParams): Promise<string> {
  const algorithm = p.algorithm ?? "RS256";
  const now = Math.floor(Date.now() / 1000);
  const claims: JwtAssertionClaims = {
    iat: now,
    exp: now + 60,
    ...p.claims,
  };
  const header: Record<string, unknown> = { alg: algorithm, typ: "JWT" };
  if (p.key_id) header.kid = p.key_id;
  const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const subtle = crypto.subtle;
  const keyAlgo =
    algorithm === "RS256"
      ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
      : { name: "ECDSA", namedCurve: "P-256" };
  const key = await subtle.importKey("pkcs8", pemToDer(p.private_key_pem), keyAlgo, false, [
    "sign",
  ]);
  const signParams =
    algorithm === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" };
  const sig = await subtle.sign(signParams, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  return Buffer.from(body, "base64").buffer as ArrayBuffer;
}

/**
 * Exchange a pre-signed JWT assertion for an access token at an OAuth2
 * token endpoint that supports the JWT Bearer grant (`urn:ietf:params:
 * oauth:grant-type:jwt-bearer`).
 */
export async function runJwtBearerGrant(p: {
  token_endpoint: string;
  assertion: string;
  scope?: string | undefined;
  /** Some token endpoints (Salesforce sandbox) require an extra
   *  `client_id` form field alongside the assertion. Optional. */
  client_id?: string | undefined;
}): Promise<OAuth2TokenBundle> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: p.assertion,
  });
  if (p.scope) body.set("scope", p.scope);
  if (p.client_id) body.set("client_id", p.client_id);
  const res = await fetch(p.token_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`jwt-bearer token exchange failed (${res.status}): ${text}`);
  }
  const parsed = JSON.parse(text) as {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
    refresh_token?: string;
  };
  if (!parsed.access_token) {
    throw new Error(`jwt-bearer response missing access_token: ${text}`);
  }
  const expires_at =
    typeof parsed.expires_in === "number"
      ? new Date(Date.now() + Math.max(0, parsed.expires_in) * 1000)
      : null;
  return {
    access_token: parsed.access_token,
    token_type: parsed.token_type ?? "Bearer",
    expires_at,
    refresh_token: parsed.refresh_token ?? null,
    scope: parsed.scope ?? null,
  };
}

// ---------------------------------------------------------------------------
// Device Authorization Grant (RFC 8628)
//
// The "headless flow": the engine asks the IdP for a `device_code` and a
// short `user_code`. Operator visits `verification_uri` on a phone /
// laptop, enters the user_code, completes login. Engine polls the token
// endpoint at `interval` seconds until the IdP returns a token (or
// `expires_in` elapses).
//
// Used by: GitHub CLI, Auth0 device login, AzureAD device, Zoom device,
// any other "device with limited input" pattern.
// ---------------------------------------------------------------------------

export interface DeviceFlowInitResult {
  device_code: string;
  user_code: string;
  verification_uri: string;
  /** Some IdPs (Auth0) provide `verification_uri_complete` with the
   *  user_code pre-filled — show this to operators when present. */
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

/**
 * Step 1: ask the IdP for a device_code + user_code. The engine then
 * shows `verification_uri` + `user_code` to the operator and starts
 * polling.
 */
export async function initiateDeviceFlow(p: {
  device_authorization_endpoint: string;
  client_id: string;
  scope?: string | undefined;
  audience?: string | undefined;
}): Promise<DeviceFlowInitResult> {
  const body = new URLSearchParams({ client_id: p.client_id });
  if (p.scope) body.set("scope", p.scope);
  if (p.audience) body.set("audience", p.audience);
  const res = await fetch(p.device_authorization_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`device flow init failed (${res.status}): ${text}`);
  }
  const parsed = JSON.parse(text) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
  };
  if (!parsed.device_code || !parsed.user_code || !parsed.verification_uri) {
    throw new Error(`device flow init missing required fields: ${text}`);
  }
  const result: DeviceFlowInitResult = {
    device_code: parsed.device_code,
    user_code: parsed.user_code,
    verification_uri: parsed.verification_uri,
    expires_in: parsed.expires_in ?? 600,
    interval: parsed.interval ?? 5,
  };
  if (parsed.verification_uri_complete) {
    result.verification_uri_complete = parsed.verification_uri_complete;
  }
  return result;
}

/**
 * Step 2: poll the token endpoint with the device_code until the IdP
 * returns a token. RFC 8628 specifies retry semantics:
 *
 *   * `authorization_pending` — keep polling
 *   * `slow_down` — increase polling interval by 5s
 *   * `expired_token` — the device_code expired (give up)
 *   * `access_denied` — user rejected (give up)
 *
 * The caller hands us an AbortSignal so a UI cancel propagates cleanly.
 */
export async function pollDeviceFlow(p: {
  token_endpoint: string;
  client_id: string;
  device_code: string;
  interval: number;
  expires_in: number;
  signal?: AbortSignal | undefined;
}): Promise<OAuth2TokenBundle> {
  const startedAt = Date.now();
  const deadline = startedAt + p.expires_in * 1000;
  let interval = p.interval * 1000;
  while (Date.now() < deadline) {
    if (p.signal?.aborted) throw new Error("device flow aborted");
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, interval);
      const onAbort = () => {
        clearTimeout(t);
        reject(new Error("device flow aborted"));
      };
      p.signal?.addEventListener("abort", onAbort, { once: true });
    });
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: p.client_id,
      device_code: p.device_code,
    });
    const res = await fetch(p.token_endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
    });
    const text = await res.text();
    const parsed = JSON.parse(text) as {
      error?: string;
      error_description?: string;
      access_token?: string;
      refresh_token?: string;
      token_type?: string;
      expires_in?: number;
      scope?: string;
    };
    if (parsed.access_token) {
      const expires_at =
        typeof parsed.expires_in === "number"
          ? new Date(Date.now() + Math.max(0, parsed.expires_in) * 1000)
          : null;
      return {
        access_token: parsed.access_token,
        token_type: parsed.token_type ?? "Bearer",
        expires_at,
        refresh_token: parsed.refresh_token ?? null,
        scope: parsed.scope ?? null,
      };
    }
    if (parsed.error === "authorization_pending") continue;
    if (parsed.error === "slow_down") {
      interval += 5_000;
      continue;
    }
    // Any other error is terminal.
    throw new Error(`device flow failed: ${parsed.error ?? "unknown"} (${text})`);
  }
  throw new Error("device flow timed out");
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
