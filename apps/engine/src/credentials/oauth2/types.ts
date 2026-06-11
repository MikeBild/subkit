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
  | "cognito_user_password"
  | "client_credentials_json";

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
  // ── client_credentials_json extension ──────────────────────────────
  // Used when `grant_type === "client_credentials_json"`: the token
  // endpoint accepts a JSON body (not OAuth2 form-encoded) and the
  // response is either a bare token string ("raw") or a standard JSON
  // envelope ("json").
  /** Flat mapping of JSON body field names to the stored credential
   *  field values. E.g. `{ client_id: "<client_id>", client_secret:
   *  "<client_secret>" }` — the right-hand values are the actual
   *  secret strings to send, not path pointers. The refresh worker
   *  populates this from the credential row at refresh time. */
  token_request_body_mapping?: Record<string, string> | undefined;
  /** How to parse the token from the response body.
   *  - "raw": entire response body is the token (strip surrounding
   *    quotes + whitespace, as e.g. Xray Cloud returns).
   *  - "json": standard JSON envelope; read `access_token` key. */
  token_response_format?: "raw" | "json" | undefined;
  /** Fallback TTL in milliseconds when the response carries no
   *  expiry information (no `expires_in` for "json", no header for
   *  "raw"). Must be >0. E.g. 86_400_000 for 24 hours. */
  token_response_ttl_ms?: number | undefined;
}

export interface OAuth2TokenBundle {
  access_token: string;
  token_type: string;
  expires_at: Date | null;
  refresh_token: string | null;
  scope: string | null;
}
