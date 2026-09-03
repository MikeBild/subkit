// Outbound connections — the shapes shared by discovery, the flow and the routes.

import { z } from "zod";

/** RFC 8414 authorization-server metadata, the fields this client uses. */
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

/**
 * `/.well-known/service-descriptor.json` — optional, product-agnostic. Only a
 * display name, a description and a version are read; anything else the
 * server publishes is ignored rather than trusted.
 */
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
  /** Null when the server publishes no authorization-server metadata. */
  authorization: AuthorizationServerMetadata | null;
  descriptor: ServiceDescriptor | null;
}

/** RFC 7591 registration response, the fields this client uses. */
export const RegistrationResponseSchema = z
  .object({
    client_id: z.string().min(1),
    client_secret: z.string().optional(),
  })
  .passthrough();

/** RFC 6749 §5.1 token response. */
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

/**
 * The four words the Cockpit shows (§2/§11), decided from the row:
 *   valid      the grant is usable and renews itself
 *   expiring   the grant is usable, has no refresh token, and ends at `expires_at`
 *   expired    the last refresh failed, or it ended and cannot renew itself
 *   unreadable the stored token does not decrypt under the running MASTER_KEY
 */
export type ConnectionState = "valid" | "expiring" | "expired" | "unreadable";

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
  /** True when a refresh token is stored — the engine renews before expiry. */
  auto_renew: boolean;
  expires_at: string | null;
  last_used_at: string | null;
  last_refreshed_at: string | null;
  refresh_failed_at: string | null;
  last_error: string | null;
  /** Connector credentials that point at this connection. */
  used_by_connectors: number;
  created_at: string;
}

/** Failures the routes turn into a status and the Cockpit into a sentence. */
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
