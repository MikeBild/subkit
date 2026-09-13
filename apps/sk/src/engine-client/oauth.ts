// OAuth bootstrap methods used by `sk login`. Sensitive request and response
// bodies deliberately bypass the normal verbose transport debug payloads: an
// authorization code, OAuth token, or newly issued API key must never enter the
// CLI debug log.

import { EngineError, TransportError } from "@cli-core/errors.ts";

import type { EngineClient } from "../engine-client.ts";
import { parseResponseBody } from "./http.ts";

export interface OAuthProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
}

export interface OAuthAuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  scopes_supported: string[];
}

export interface OAuthClientRegistration {
  client_id: string;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method: string;
  scope: string;
}

export interface OAuthTokenPair {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

export interface CliSessionCredential {
  api_key: string;
  principal_id: string;
  context_id: string;
  email: string;
}

async function sensitiveRequest<T>(
  client: EngineClient,
  path: string,
  init: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await client.fetchImpl(`${client.base}${path}`, init);
  } catch (cause) {
    throw new TransportError(cause);
  }
  const text = await response.text();
  const parsed = parseResponseBody(text);
  if (!response.ok) throw new EngineError(response.status, parsed);
  return parsed as T;
}

const jsonHeaders = {
  accept: "application/json",
  "content-type": "application/json",
  "user-agent": "sk-cli/0.0.1",
};

const formHeaders = {
  accept: "application/json",
  "content-type": "application/x-www-form-urlencoded",
  "user-agent": "sk-cli/0.0.1",
};

export const oauthMethods = {
  oauthCliProtectedResource(this: EngineClient): Promise<OAuthProtectedResourceMetadata> {
    return sensitiveRequest(this, "/.well-known/oauth-protected-resource/v1/identity/cli-session", {
      method: "GET",
      headers: jsonHeaders,
    });
  },

  oauthAuthorizationServer(this: EngineClient): Promise<OAuthAuthorizationServerMetadata> {
    return sensitiveRequest(this, "/.well-known/oauth-authorization-server", {
      method: "GET",
      headers: jsonHeaders,
    });
  },

  registerOAuthClient(
    this: EngineClient,
    body: {
      redirect_uris: string[];
      client_name: string;
      grant_types: string[];
      token_endpoint_auth_method: "none";
      scope: string;
      software_id: string;
    },
  ): Promise<OAuthClientRegistration> {
    return sensitiveRequest(this, "/v1/oauth/register", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(body),
    });
  },

  exchangeOAuthAuthorizationCode(
    this: EngineClient,
    input: { code: string; code_verifier: string; redirect_uri: string; client_id: string },
  ): Promise<OAuthTokenPair> {
    return sensitiveRequest(this, "/v1/oauth/token", {
      method: "POST",
      headers: formHeaders,
      body: new URLSearchParams({ grant_type: "authorization_code", ...input }).toString(),
    });
  },

  exchangeCliSession(this: EngineClient, accessToken: string): Promise<CliSessionCredential> {
    return sensitiveRequest(this, "/v1/identity/cli-session", {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "sk-cli/0.0.1",
      },
    });
  },

  async revokeOAuthToken(this: EngineClient, token: string): Promise<void> {
    await sensitiveRequest<unknown>(this, "/v1/oauth/revoke", {
      method: "POST",
      headers: formHeaders,
      body: new URLSearchParams({ token }).toString(),
    });
  },
};
