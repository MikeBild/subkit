import * as oauth from "openid-client";
import type { EgressGuardContext } from "../../connectors/index.ts";
import { logger } from "../../logging/index.ts";
import { identityFromTokenResponse, VerifiedProviderIdentitySchema } from "../provider-identity.ts";
import { CredentialRequestError, credentialOperation, fetchCredentialRequest } from "../request.ts";
import {
  type OAuth2ClientConfig,
  type OAuth2TokenBundle,
  type RFC7591ClientMetadata,
  RFC7591ClientMetadataSchema,
  RFC7591ClientRegistrationResponseSchema,
} from "./types.ts";

const configCache = new Map<string, oauth.Configuration>();

const executors = new WeakMap<object, number>();
let executorSequence = 0;

function oauthFetchFor(context: EgressGuardContext): oauth.CustomFetch {
  return (url, options) =>
    fetchCredentialRequest(context, url, {
      method: options.method,
      headers: options.headers,
      redirect: options.redirect,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.body === undefined ? {} : { body: options.body as BodyInit | null }),
    });
}

export function oauthConfigCacheKey(
  cfg: OAuth2ClientConfig,
  tenantId: string | null,
  mode: string | null,
  executorId: number,
): string {
  return JSON.stringify([cfg, tenantId, mode, executorId]);
}

function cacheKey(cfg: OAuth2ClientConfig, context: EgressGuardContext): string {
  let executorId = 0;
  if (context.exec) {
    executorId = executors.get(context.exec) ?? ++executorSequence;
    executors.set(context.exec, executorId);
  }
  return oauthConfigCacheKey(cfg, context.tenant_id ?? null, context.mode ?? null, executorId);
}

function resolveClientAuth(cfg: OAuth2ClientConfig): oauth.ClientAuth | undefined {
  if (!cfg.client_secret) return undefined;
  if (cfg.token_auth_method === "basic_auth") {
    return oauth.ClientSecretBasic(cfg.client_secret);
  }
  return oauth.ClientSecretPost(cfg.client_secret);
}

async function getConfig(
  cfg: OAuth2ClientConfig,
  context: EgressGuardContext,
): Promise<oauth.Configuration> {
  const key = cacheKey(cfg, context);
  const oauthFetch = oauthFetchFor(context);
  const existing = configCache.get(key);
  if (existing) return existing;
  const server = new URL(cfg.issuer_url);
  const clientAuth = resolveClientAuth(cfg);

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
      server.protocol === "http:"
        ? { execute: [oauth.allowInsecureRequests], [oauth.customFetch]: oauthFetch }
        : { [oauth.customFetch]: oauthFetch };
    configuration = await credentialOperation(() =>
      oauth.discovery(server, cfg.client_id, cfg.client_secret, clientAuth, discoveryOptions),
    );
  }
  if (server.protocol === "http:") {
    oauth.allowInsecureRequests(configuration);
  }
  configuration[oauth.customFetch] = oauthFetch;
  if (configCache.size >= 512) configCache.clear();
  configCache.set(key, configuration);
  return configuration;
}

export function __resetOAuth2CacheForTests(): void {
  configCache.clear();
}

function toBundle(
  res: oauth.TokenEndpointResponse & oauth.TokenEndpointResponseHelpers,
  issuer: string,
): OAuth2TokenBundle {
  const claims = res.claims();
  const verified = claims
    ? VerifiedProviderIdentitySchema.safeParse({
        issuer,
        subject: claims.sub,
        source: "openid_claims",
      })
    : null;
  const verified_identity = verified?.success
    ? verified.data
    : identityFromTokenResponse(issuer, res);
  const expires_in = res.expiresIn();
  const expires_at =
    typeof expires_in === "number" ? new Date(Date.now() + Math.max(0, expires_in) * 1000) : null;
  return {
    verified_identity,
    access_token: res.access_token ?? "",
    token_type: (res.token_type as string | undefined) ?? "Bearer",
    expires_at,
    refresh_token: (res.refresh_token as string | undefined) ?? null,
    scope: (res.scope as string | undefined) ?? null,
  };
}

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

interface StartAuthCodeResult {
  authorization_url: string;
  state: string;
  code_verifier: string;
}

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
  context: EgressGuardContext,
): Promise<StartAuthCodeResult> {
  if (!cfg.redirect_uri) {
    throw new Error("startAuthorizationCode requires config.redirect_uri");
  }
  const configuration = await getConfig(cfg, context);
  const usePkce = cfg.use_pkce !== false;
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

interface CompleteAuthCodeParams {
  cfg: OAuth2ClientConfig;
  current_url: URL;
  code_verifier: string;
  state: string;
}

export async function completeAuthorizationCode(
  p: CompleteAuthCodeParams,
  context: EgressGuardContext,
): Promise<OAuth2TokenBundle> {
  const configuration = await getConfig(p.cfg, context);
  const grantOpts: Parameters<typeof oauth.authorizationCodeGrant>[2] = {
    expectedState: p.state,
  };
  if (p.cfg.use_pkce !== false && p.code_verifier) {
    grantOpts.pkceCodeVerifier = p.code_verifier;
  }
  const res = await credentialOperation(
    () => oauth.authorizationCodeGrant(configuration, p.current_url, grantOpts),
    [p.current_url.searchParams.get("code"), p.code_verifier, p.cfg.client_secret],
  );
  return credentialOperation(() => toBundle(res, p.cfg.issuer_url));
}

export async function runClientCredentialsGrant(
  cfg: OAuth2ClientConfig,
  context: EgressGuardContext,
): Promise<OAuth2TokenBundle> {
  const configuration = await getConfig(cfg, context);
  const params: Record<string, string> = {};
  if (cfg.scope) params.scope = cfg.scope;
  if (cfg.audience) params.audience = cfg.audience;
  const res = await credentialOperation(
    () => oauth.clientCredentialsGrant(configuration, params),
    [cfg.client_secret],
  );
  return credentialOperation(() => toBundle(res, cfg.issuer_url));
}

export async function runPasswordGrant(
  cfg: OAuth2ClientConfig,
  username: string,
  password: string,
  context: EgressGuardContext,
): Promise<OAuth2TokenBundle> {
  const configuration = await getConfig(cfg, context);
  const params: URLSearchParams = new URLSearchParams({
    grant_type: "password",
    username,
    password,
  });
  if (cfg.scope) params.set("scope", cfg.scope);
  if (cfg.audience) params.set("audience", cfg.audience);
  const res = await credentialOperation(
    () => oauth.genericGrantRequest(configuration, "password", params),
    [password, cfg.client_secret],
  );
  return credentialOperation(() => toBundle(res, cfg.issuer_url));
}

interface CognitoUserPasswordParams {
  region: string;
  client_id: string;
  username: string;
  password: string;
  client_secret?: string | undefined;
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
  context: EgressGuardContext,
): Promise<T> {
  const res = await fetchCredentialRequest(context, cognitoEndpoint(region), {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
  });
  const text = await credentialOperation(() => res.text());
  if (!res.ok) {
    throw new CredentialRequestError("credential_response_rejected", res.status);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CredentialRequestError("credential_response_invalid");
  }
}

function bundleFromCognito(
  payload: CognitoTokenPayload,
  useAccessToken: boolean,
  prevRefreshToken?: string | null,
): OAuth2TokenBundle {
  const r = payload.AuthenticationResult;
  if (!r || (!r.IdToken && !r.AccessToken)) {
    throw new CredentialRequestError("credential_response_invalid");
  }
  const access = useAccessToken ? r.AccessToken : r.IdToken;
  if (!access) {
    throw new CredentialRequestError("credential_response_invalid");
  }
  const expires_at =
    typeof r.ExpiresIn === "number" ? new Date(Date.now() + Math.max(0, r.ExpiresIn) * 1000) : null;
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
  context: EgressGuardContext,
): Promise<OAuth2TokenBundle> {
  const params: Record<string, string> = {
    USERNAME: p.username,
    PASSWORD: p.password,
  };
  if (p.client_secret) {
    params.SECRET_HASH = await computeCognitoSecretHash(p.username, p.client_id, p.client_secret);
  }
  const payload = await postCognito<CognitoTokenPayload>(
    p.region,
    "InitiateAuth",
    {
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: p.client_id,
      AuthParameters: params,
    },
    context,
  );
  return bundleFromCognito(payload, p.use_access_token === true);
}

export async function runCognitoRefreshTokenGrant(
  p: CognitoUserPasswordParams & { refresh_token: string },
  context: EgressGuardContext,
): Promise<OAuth2TokenBundle> {
  const params: Record<string, string> = { REFRESH_TOKEN: p.refresh_token };
  if (p.client_secret) {
    params.SECRET_HASH = await computeCognitoSecretHash(p.username, p.client_id, p.client_secret);
  }
  const payload = await postCognito<CognitoTokenPayload>(
    p.region,
    "InitiateAuth",
    {
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: p.client_id,
      AuthParameters: params,
    },
    context,
  );
  return bundleFromCognito(payload, p.use_access_token === true, p.refresh_token);
}

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

interface DynamicRegistrationArgs {
  issuerUrl: string;
  clientMetadata: RFC7591ClientMetadata;
  allowInsecureRequests?: boolean;
}

interface DynamicRegistrationResult {
  clientId: string;
  clientSecret: string | undefined;
  registrationEndpoint: string;
}

export async function dynamicallyRegisterClient(
  args: DynamicRegistrationArgs,
  context: EgressGuardContext,
): Promise<DynamicRegistrationResult> {
  RFC7591ClientMetadataSchema.parse(args.clientMetadata);

  const oauthFetch = oauthFetchFor(context);
  const server = new URL(args.issuerUrl);
  const isHttp = server.protocol === "http:";
  const discoveryOptions: oauth.DiscoveryRequestOptions =
    isHttp || args.allowInsecureRequests
      ? { execute: [oauth.allowInsecureRequests], [oauth.customFetch]: oauthFetch }
      : { [oauth.customFetch]: oauthFetch };

  let configuration: oauth.Configuration;
  try {
    configuration = await credentialOperation(() =>
      oauth.discovery(server, "dynamic-registration-probe", undefined, undefined, discoveryOptions),
    );
  } catch {
    throw new DynamicRegistrationError("oauth_discovery_failed", "discovery_failed");
  }

  const serverMeta = configuration.serverMetadata() as Record<string, unknown>;
  const registrationEndpoint = serverMeta.registration_endpoint as string | undefined;
  if (!registrationEndpoint) {
    throw new DynamicRegistrationError(
      "oauth_registration_endpoint_missing",
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
    res = await fetchCredentialRequest(context, registrationEndpoint, fetchOpts);
  } catch {
    throw new DynamicRegistrationError(
      "oauth_registration_request_failed",
      "registration_request_failed",
    );
  }

  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new DynamicRegistrationError(
      `oauth_registration_rejected: http_${res.status}`,
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
      "oauth_registration_response_invalid",
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

interface ClientCredentialsJsonParams {
  token_endpoint: string;
  body_mapping: Record<string, string>;
  response_format: "raw" | "json";
  token_response_ttl_ms: number;
  extra_token_headers?: Record<string, string> | undefined;
}

export async function runClientCredentialsJsonGrant(
  p: ClientCredentialsJsonParams,
  context: EgressGuardContext,
): Promise<OAuth2TokenBundle> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/plain, */*",
    ...(p.extra_token_headers ?? {}),
  };

  const res = await fetchCredentialRequest(context, p.token_endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(p.body_mapping),
  });

  const text = await credentialOperation(() => res.text());
  if (!res.ok) {
    throw new CredentialRequestError("credential_response_rejected", res.status);
  }

  if (p.response_format === "raw") {
    const token = text.trim().replace(/^"|"$/g, "");
    if (!token) {
      throw new Error("client_credentials_json raw response was empty after stripping quotes");
    }
    return {
      access_token: token,
      token_type: "Bearer",
      expires_at: new Date(Date.now() + p.token_response_ttl_ms),
      refresh_token: null,
      scope: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CredentialRequestError("credential_response_invalid");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new CredentialRequestError("credential_response_invalid");
  const envelope = parsed as Record<string, unknown>;
  const access_token = typeof envelope.access_token === "string" ? envelope.access_token : null;
  if (!access_token) {
    throw new CredentialRequestError("credential_response_invalid");
  }
  const expires_in = typeof envelope.expires_in === "number" ? envelope.expires_in : null;
  const expires_at =
    expires_in !== null
      ? new Date(Date.now() + Math.max(0, expires_in) * 1000)
      : new Date(Date.now() + p.token_response_ttl_ms);
  const token_type = typeof envelope.token_type === "string" ? envelope.token_type : "Bearer";
  const scope = typeof envelope.scope === "string" ? envelope.scope : null;
  return {
    access_token,
    token_type,
    expires_at,
    refresh_token: null,
    scope,
  };
}

export async function runRefreshTokenGrant(
  cfg: OAuth2ClientConfig,
  refresh_token: string,
  context: EgressGuardContext,
): Promise<OAuth2TokenBundle> {
  const configuration = await getConfig(cfg, context);
  const params: Record<string, string> = {};
  if (cfg.scope) params.scope = cfg.scope;
  try {
    const res = await credentialOperation(
      () => oauth.refreshTokenGrant(configuration, refresh_token, params),
      [refresh_token, cfg.client_secret],
    );
    return credentialOperation(() => toBundle(res, cfg.issuer_url));
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

export function isOAuthProviderError(err: unknown): boolean {
  return (
    err instanceof CredentialRequestError ||
    err instanceof oauth.ClientError ||
    err instanceof oauth.ResponseBodyError ||
    err instanceof oauth.AuthorizationResponseError ||
    err instanceof oauth.WWWAuthenticateChallengeError ||
    err instanceof DynamicRegistrationError
  );
}
