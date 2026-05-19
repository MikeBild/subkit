// Shared OAuth2 helper types. Grant kinds are a small discriminated
// union so callers (routes, workers, drivers) can pick the right wrapper
// without knowing openid-client v6 internals.

import { z } from "zod";

export const RFC7591ClientMetadataSchema = z.object({
  redirect_uris: z.array(z.string().url()).min(1),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  scope: z.string().optional(),
  client_name: z.string().optional(),
  software_id: z.string().optional(),
  software_version: z.string().optional(),
});
export type RFC7591ClientMetadata = z.infer<typeof RFC7591ClientMetadataSchema>;

export const RFC7591ClientRegistrationResponseSchema = z.object({
  client_id: z.string(),
  client_secret: z.string().optional(),
  client_id_issued_at: z.number().optional(),
  client_secret_expires_at: z.number().optional(),
  registration_access_token: z.string().optional(),
  registration_client_uri: z.string().optional(),
});
export type RFC7591ClientRegistrationResponse = z.infer<
  typeof RFC7591ClientRegistrationResponseSchema
>;

export type OAuth2GrantKind =
  | "authorization_code"
  | "client_credentials"
  | "password"
  | "cognito_user_password";

export interface OAuth2ClientConfig {
  issuer_url: string;
  authorization_endpoint?: string | undefined;
  token_endpoint?: string | undefined;
  client_id: string;
  client_secret?: string | undefined;
  scope?: string | undefined;
  redirect_uri?: string | undefined;
  audience?: string | undefined;
  token_auth_method?: "body" | "basic_auth" | undefined;
  token_content_type?: "form" | "json" | undefined;
  use_pkce?: boolean | undefined;
  /** Extra headers to ride on the OAuth2 token POST. Used by IdPs
   *  whose token endpoint demands non-spec headers (Atlassian Connect's
   *  `qsh`, vendor-bespoke API keys, etc.). Plumbed through every
   *  grant flow that does a POST to the token endpoint. */
  extra_token_headers?: Record<string, string> | undefined;
  grant_type?: OAuth2GrantKind | undefined;
  /** How many milliseconds before `expires_at` to consider the token
   *  stale and trigger a refresh. Defaults to 300_000 (5 minutes). A
   *  tenant whose IdP issues 60-second tokens (rare, but Atlassian
   *  test keys do this) can shrink it; one with 24h tokens can leave
   *  the default. */
  refresh_buffer_ms?: number | undefined;
}

export interface OAuth2TokenBundle {
  access_token: string;
  token_type: string;
  expires_at: Date | null;
  refresh_token: string | null;
  scope: string | null;
}
