import { z } from "@hono/zod-openapi";

const ProbeErrorCodeEnum = z
  .enum([
    "credential_missing",
    "credential_invalid",
    "credential_expired",
    "credential_unverified",
    "scope_insufficient",
    "remote_api_disabled",
    "remote_resource_not_found",
    "connector_disabled",
    "unknown_upstream_error",
  ])
  .openapi("ProbeErrorCode");

export const ProbeResultSchema = z
  .object({
    ok: z.boolean(),
    latency_ms: z.number(),
    status: z.number().optional(),
    detail: z.string().optional(),
    error_code: ProbeErrorCodeEnum.optional(),
    provider_action_url: z.string().optional(),
    warning_only: z.boolean().optional(),
    warnings: z.array(z.object({ code: z.string(), message: z.string() })).optional(),
    partial_grant: z.union([z.boolean(), z.literal("unknown")]).optional(),
    granted_scopes: z.array(z.string()).optional(),
    expected_scopes: z.array(z.string()).optional(),
    missing_scopes: z.array(z.string()).optional(),
    partial_grant_note: z.string().optional(),
  })
  .openapi("ConnectorProbeResult");

export const CredentialBody = z
  .object({
    mode: z.enum([
      "none",
      "header",
      "query",
      "bearer",
      "basic",
      "aws_sigv4",
      "signed_jwt",
      "connection",
    ]),
    connection_id: z.string().uuid().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    query: z.record(z.string(), z.string()).optional(),
    token: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    access_key_id: z.string().optional(),
    secret_access_key: z.string().optional(),
    session_token: z.string().optional(),
    private_key: z
      .string()
      .min(1)
      .max(16384)
      .optional()
      .describe("PKCS#8 PEM private key for signed_jwt. Secret; never returned."),
  })
  .openapi("CredentialBody");

export const OAuthStartResponse = z
  .object({
    authorization_url: z.string(),
    state: z.string(),
  })
  .openapi("OAuthStartResponse");

export const OAuthCallbackQuery = z
  .object({
    state: z.string(),
    code: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  })
  .openapi("OAuthCallbackQuery");
