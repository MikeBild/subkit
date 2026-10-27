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
    links: z
      .array(z.object({ rel: z.string().max(80), href: z.string().max(2048) }).passthrough())
      .optional(),
  })
  .passthrough();

const PackageArtifactSchema = z.object({
  href: z.string().min(1).max(2048),
  format: z.string().max(120).optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  connectorBinding: z.literal("connector_id").optional(),
  prefixDefault: z.string().max(120).optional(),
});

export const ServicePackageEnrollmentSchema = z.object({
  type: z.literal("enrollment"),
  endpoint: z.string().min(1).max(2048),
  acknowledgement: z.string().min(1).max(2048),
  revocation: z.string().min(1).max(2048).optional(),
  request: z.object({
    body: z.record(z.string().max(80), z.unknown()),
  }),
  credential: z.object({
    header: z.string().min(1).max(128),
    prefix: z.string().min(1).max(64),
    responseField: z.string().min(1).max(80),
    recoverableUntilAcknowledged: z.boolean(),
  }),
  recovery: z.object({
    idempotencyHeader: z.string().min(1).max(128),
    proofHeader: z.string().min(1).max(128),
    acknowledgeAfterEncryptedStorage: z.literal(true),
  }),
});
export type ServicePackageEnrollment = z.infer<typeof ServicePackageEnrollmentSchema>;

export const ServicePackageSchema = z.object({
  format: z.literal("subkit.package/v1"),
  id: z.string().min(1).max(160),
  version: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  api: z.object({ openapi: z.string().max(2048) }).optional(),
  artifacts: z.record(z.string().max(80), PackageArtifactSchema).optional(),
  authentication: ServicePackageEnrollmentSchema.optional(),
  permissions: z.array(z.string().max(120)).max(100).optional(),
});
export type ServicePackage = z.infer<typeof ServicePackageSchema>;

export interface ServiceDescriptor {
  name: string | null;
  description: string | null;
  version: string | null;
  package_url: string | null;
}

export interface DiscoveryResult {
  base_url: string;
  authorization: AuthorizationServerMetadata | null;
  descriptor: ServiceDescriptor | null;
  package: ServicePackage | null;
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
