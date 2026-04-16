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
import { logger } from "../logging/logger.ts";
import type { OAuth2ClientConfig, OAuth2TokenBundle } from "./types.ts";

const configCache = new Map<string, oauth.Configuration>();

function cacheKey(cfg: OAuth2ClientConfig): string {
  return `${cfg.issuer_url}|${cfg.client_id}`;
}

async function getConfig(cfg: OAuth2ClientConfig): Promise<oauth.Configuration> {
  const key = cacheKey(cfg);
  const existing = configCache.get(key);
  if (existing) return existing;
  const server = new URL(cfg.issuer_url);
  // Allow plaintext HTTP for local mock servers (tests). Discovery
  // itself also has to run over http:// so we pass `execute` at call
  // time rather than waiting to call allowInsecureRequests on the
  // finished Configuration.
  const discoveryOptions: oauth.DiscoveryRequestOptions =
    server.protocol === "http:" ? { execute: [oauth.allowInsecureRequests] } : {};
  const configuration = await oauth.discovery(
    server,
    cfg.client_id,
    cfg.client_secret,
    undefined,
    discoveryOptions,
  );
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
  const code_verifier = oauth.randomPKCECodeVerifier();
  const code_challenge = await oauth.calculatePKCECodeChallenge(code_verifier);
  const state = oauth.randomState();
  const params: Record<string, string> = {
    redirect_uri: cfg.redirect_uri,
    scope: cfg.scope ?? "openid",
    code_challenge,
    code_challenge_method: "S256",
    state,
  };
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
  const res = await oauth.authorizationCodeGrant(configuration, p.current_url, {
    pkceCodeVerifier: p.code_verifier,
    expectedState: p.state,
  });
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
