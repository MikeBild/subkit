// Credential value shape — after decryption. The ciphertext form lives
// only at the db layer (`credentials.ciphertext` + `iv` + `auth_tag`).
//
// `mode` mirrors the connector's auth_type and tells the HTTP driver how
// to apply the secret to an outgoing request.
//
// For `header`, `query`, `basic`, `bearer` the plaintext is a JSON
// string; the driver parses it. For `oauth2` the plaintext is the
// current access token, and the refresh token + expiry live in the
// sibling `oauth2_refresh_*` columns.

import { z } from "zod";

export const CredentialMode = z.enum([
  "none",
  "header",
  "query",
  "bearer",
  "basic",
  "oauth2",
  "aws_sigv4",
]);
export type CredentialMode = z.infer<typeof CredentialMode>;

// Header + query credentials store a flat string->string map.
export const HeaderCredentialValue = z.object({
  headers: z.record(z.string(), z.string()),
});
export type HeaderCredentialValue = z.infer<typeof HeaderCredentialValue>;

export const QueryCredentialValue = z.object({
  query: z.record(z.string(), z.string()),
});
export type QueryCredentialValue = z.infer<typeof QueryCredentialValue>;

export const BearerCredentialValue = z.object({
  token: z.string().min(1),
});
export type BearerCredentialValue = z.infer<typeof BearerCredentialValue>;

export const BasicCredentialValue = z.object({
  username: z.string().min(1),
  password: z.string(),
});
export type BasicCredentialValue = z.infer<typeof BasicCredentialValue>;

export const OAuth2CredentialValue = z.object({
  access_token: z.string(),
  token_type: z.string().default("Bearer"),
  scope: z.string().optional(),
});
export type OAuth2CredentialValue = z.infer<typeof OAuth2CredentialValue>;

// AWS SigV4 — sign every outbound request with these credentials. Used
// by AppSync IAM mode, DynamoDB, API Gateway IAM auth, every other
// AWS service that doesn't have a first-class auth mode.
//
// `region` and `service` come from the connector config (not the
// credential) since they vary per endpoint, not per identity. The
// credential carries only the identity material.
export const AwsSigV4CredentialValue = z.object({
  access_key_id: z.string().min(1),
  secret_access_key: z.string().min(1),
  /** Optional STS session token — present for AssumeRole / IAM Identity
   *  Center / EC2 instance-profile credentials, absent for static IAM
   *  user keys. */
  session_token: z.string().optional(),
});
export type AwsSigV4CredentialValue = z.infer<typeof AwsSigV4CredentialValue>;

export type DecryptedCredential =
  | { mode: "none" }
  | ({ mode: "header" } & HeaderCredentialValue)
  | ({ mode: "query" } & QueryCredentialValue)
  | ({ mode: "bearer" } & BearerCredentialValue)
  | ({ mode: "basic" } & BasicCredentialValue)
  | ({
      mode: "oauth2";
      refresh_token: string | null;
      expires_at: Date | null;
    } & OAuth2CredentialValue)
  | ({ mode: "aws_sigv4" } & AwsSigV4CredentialValue);
