import { z } from "zod";

export const AuthorizationServerMetadataSchema = z
  .object({
    issuer: z.string().url(),
    authorization_endpoint: z.string().url(),
    token_endpoint: z.string().url(),
    registration_endpoint: z.string().url().optional(),
    scopes_supported: z.array(z.string()).optional(),
    code_challenge_methods_supported: z.array(z.string()).optional(),
    grant_types_supported: z.array(z.string()).optional(),
  })
  .passthrough();
export type AuthorizationServerMetadata = z.infer<typeof AuthorizationServerMetadataSchema>;

export const ServiceDescriptorSchema = z
  .object({
    name: z.string().optional(),
    service: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    version: z.string().optional(),
  })
  .passthrough();

export interface ServiceDescriptor {
  name: string | null;
  description: string | null;
  version: string | null;
}

export interface DiscoveryResult {
  base_url: string;
  authorization: AuthorizationServerMetadata | null;
  descriptor: ServiceDescriptor | null;
}

export const RegistrationResponseSchema = z
  .object({
    client_id: z.string().min(1),
    client_secret: z.string().optional(),
  })
  .passthrough();

export const TokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.string().default("Bearer"),
    expires_in: z.number().int().nonnegative().optional(),
    refresh_token: z.string().optional(),
    scope: z.string().optional(),
  })
  .passthrough();
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

export type ConnectionState = "valid" | "expiring" | "expired" | "unreadable";

export type ConnectionStateReason =
  | "refresh_refused"
  | "refresh_failed"
  | "expired_no_refresh"
  | "secret_unreadable";

export interface ConnectionUser {
  connector_id: string;
  slug: string;
  display_name: string;
  workflow_count: number;
}

export interface ConnectionSummary {
  id: string;
  name: string;
  state: ConnectionState;
}

export interface ConnectionView {
  id: string;
  name: string;
  base_url: string;
  issuer: string;
  service_name: string | null;
  service_description: string | null;
  scopes: string[];
  granted_scopes: string[] | null;
  state: ConnectionState;
  state_reason: ConnectionStateReason | null;
  auto_renew: boolean;
  expires_at: string | null;
  last_used_at: string | null;
  last_refreshed_at: string | null;
  refresh_failed_at: string | null;
  last_error: string | null;
  used_by: ConnectionUser[];
  created_at: string;
}

export type ConnectionFailureCode =
  | "base_url_invalid"
  | "discovery_failed"
  | "discovery_missing"
  | "pkce_unsupported"
  | "registration_missing"
  | "registration_failed"
  | "name_invalid"
  | "name_taken"
  | "scopes_missing"
  | "state_invalid"
  | "denied"
  | "token_exchange_failed"
  | "refresh_failed"
  | "not_found";

export class ConnectionError extends Error {
  constructor(
    public readonly code: ConnectionFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "ConnectionError";
  }
}
