import { z } from "zod";
import type { VerifiedProviderIdentity } from "../provider-identity.ts";

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
  extra_token_headers?: Record<string, string> | undefined;
  grant_type?: OAuth2GrantKind | undefined;
  refresh_buffer_ms?: number | undefined;
  token_request_body_mapping?: Record<string, string> | undefined;
  token_response_format?: "raw" | "json" | undefined;
  token_response_ttl_ms?: number | undefined;
}

export interface OAuth2TokenBundle {
  verified_identity?: VerifiedProviderIdentity | null;
  access_token: string;
  token_type: string;
  expires_at: Date | null;
  refresh_token: string | null;
  scope: string | null;
}
