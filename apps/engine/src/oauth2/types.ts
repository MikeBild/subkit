// Shared OAuth2 helper types. Grant kinds are a small discriminated
// union so callers (routes, workers, drivers) can pick the right wrapper
// without knowing openid-client v6 internals.

export type OAuth2GrantKind = "authorization_code" | "client_credentials" | "device_code";

export interface OAuth2ClientConfig {
  issuer_url: string;
  client_id: string;
  client_secret?: string | undefined;
  scope?: string | undefined;
  redirect_uri?: string | undefined;
  audience?: string | undefined;
}

export interface OAuth2TokenBundle {
  access_token: string;
  token_type: string;
  expires_at: Date | null;
  refresh_token: string | null;
  scope: string | null;
}
