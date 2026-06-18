// Token-mint client. One function: `runTokenMintGrant` — issues a
// shape-specific POST to the mint endpoint and normalises the response
// into an `OAuth2TokenBundle`-compatible record so the rest of the
// credential lifecycle (refreshIfStale, applyAuthMaterial, audit) can
// reuse the same persistence + retry plumbing as `oauth2`.
//
// Three request shapes:
//   - json             { "username": ..., "password": ..., ... }
//   - form             username=...&password=... (x-www-form-urlencoded)
//   - aws_initiate_auth { AuthFlow, ClientId, AuthParameters: {USERNAME,
//                       PASSWORD, SECRET_HASH?} } with x-amz-target.
//
// SECRET_HASH (Cognito-only) is computed when `client_secret` is set on
// the credential. The same helper that powers the legacy
// `cognito_user_password` client is reused.

import { createHmac } from "node:crypto";
import { getDriverFetch } from "../../connectors/drivers/fetch-seam.ts";
import type { TokenMintCredentialValue } from "../types.ts";

export interface TokenMintBundle {
  access_token: string;
  refresh_token: string | null;
  expires_at: Date | null;
}

function dotPath(payload: unknown, path: string): unknown {
  let cur: unknown = payload;
  for (const segment of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

function cognitoSecretHash(username: string, client_id: string, client_secret: string): string {
  return createHmac("sha256", client_secret).update(`${username}${client_id}`).digest("base64");
}

export async function runTokenMintGrant(cred: TokenMintCredentialValue): Promise<TokenMintBundle> {
  const { shape, mint_endpoint, credentials } = cred;
  let body: string;
  const headers: Record<string, string> = {};
  if (shape === "json") {
    headers["content-type"] = "application/json";
    body = JSON.stringify({
      username: credentials.username,
      password: credentials.password,
      ...(credentials.client_id ? { client_id: credentials.client_id } : {}),
      ...(credentials.client_secret ? { client_secret: credentials.client_secret } : {}),
      ...(credentials.audience ? { audience: credentials.audience } : {}),
      ...(credentials.scope ? { scope: credentials.scope } : {}),
      returnSecureToken: true, // Firebase shape — harmless for other JSON providers
    });
  } else if (shape === "form") {
    headers["content-type"] = "application/x-www-form-urlencoded";
    const form = new URLSearchParams();
    form.set("username", credentials.username);
    form.set("password", credentials.password);
    if (credentials.client_id) form.set("client_id", credentials.client_id);
    if (credentials.client_secret) form.set("client_secret", credentials.client_secret);
    if (credentials.audience) form.set("audience", credentials.audience);
    if (credentials.scope) form.set("scope", credentials.scope);
    body = form.toString();
  } else {
    // aws_initiate_auth
    if (!credentials.client_id) {
      throw new Error("token_mint shape=aws_initiate_auth requires credentials.client_id");
    }
    headers["content-type"] = "application/x-amz-json-1.1";
    headers["x-amz-target"] = "AWSCognitoIdentityProviderService.InitiateAuth";
    const authParams: Record<string, string> = {
      USERNAME: credentials.username,
      PASSWORD: credentials.password,
    };
    if (credentials.client_secret) {
      authParams.SECRET_HASH = cognitoSecretHash(
        credentials.username,
        credentials.client_id,
        credentials.client_secret,
      );
    }
    body = JSON.stringify({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: credentials.client_id,
      AuthParameters: authParams,
    });
  }

  const res = await getDriverFetch()(mint_endpoint, { method: "POST", headers, body });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`token_mint POST ${mint_endpoint} returned ${res.status}: ${text}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`token_mint response is not JSON: ${text}`);
  }

  const access_token = dotPath(payload, cred.token_path);
  if (typeof access_token !== "string" || access_token.length === 0) {
    throw new Error(`token_mint response missing token at path '${cred.token_path}'`);
  }

  let refresh_token: string | null = null;
  if (cred.refresh_token_path) {
    const rt = dotPath(payload, cred.refresh_token_path);
    if (typeof rt === "string") refresh_token = rt;
  }

  let expires_at: Date | null = null;
  if (cred.expires_in_path) {
    const ein = dotPath(payload, cred.expires_in_path);
    // Cognito returns ExpiresIn as a number; some providers stringify
    // (Firebase: `expiresIn: "3600"`). Coerce to number when possible.
    const seconds = typeof ein === "number" ? ein : typeof ein === "string" ? Number(ein) : NaN;
    if (Number.isFinite(seconds) && seconds > 0) {
      expires_at = new Date(Date.now() + Math.floor(seconds) * 1000);
    }
  }
  if (!expires_at && cred.expires_at_path) {
    const eat = dotPath(payload, cred.expires_at_path);
    if (typeof eat === "string") {
      const parsed = new Date(eat);
      if (!Number.isNaN(parsed.getTime())) expires_at = parsed;
    }
  }

  return { access_token, refresh_token, expires_at };
}
