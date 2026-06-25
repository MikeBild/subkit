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
  // Generalised non-OAuth2 username+password→JWT flows: Cognito
  // InitiateAuth, Firebase Auth REST signInWithPassword, generic POST
  // /login. Persists like oauth2 (cached access_token + optional
  // refresh_token + expires_at) but mints via a per-shape JSON / form /
  // AWS-target POST. See `TokenMintCredentialValue`.
  "token_mint",
  // Dynamically-registered OAuth2 client identity (RFC 7591). Stores
  // the issued client_id + encrypted client_secret so the oauth start
  // handler can read them back without touching connectors.config JSONB.
  "oauth2_client",
  // Private key (PEM or JWK) for machine-to-machine OAuth2 flows using
  // the private_key_jwt client authentication method (RFC 7523). Stores
  // client_id + private_key + algorithm so the MCP client pool can
  // construct a PrivateKeyJwtProvider without interactive consent.
  "oauth2_private_key",
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

// Token-mint credential. Generalises Cognito InitiateAuth,
// Firebase Auth REST signInWithPassword, and generic POST /login flows
// into a single shape with three request envelopes:
//
//   - "json"             POST <mint_endpoint> with JSON body
//                        { username, password, client_id?, client_secret? }
//   - "form"             POST <mint_endpoint> with x-www-form-urlencoded
//                        body of the same fields
//   - "aws_initiate_auth" POST <mint_endpoint> with x-amz-target +
//                        application/x-amz-json-1.1, body shape
//                        { AuthFlow:"USER_PASSWORD_AUTH", ClientId,
//                        AuthParameters: { USERNAME, PASSWORD,
//                        SECRET_HASH? } }
//
// `token_path` and friends are dot-notation pointers into the response
// envelope. `header_template` defaults to `Bearer ${token}`.
export const TokenMintShape = z.enum(["json", "form", "aws_initiate_auth"]);
export type TokenMintShape = z.infer<typeof TokenMintShape>;

export const TokenMintCredentialValue = z.object({
  shape: TokenMintShape,
  mint_endpoint: z.string().url(),
  /** Static credentials sent on every mint call. Encrypted at rest with
   *  the rest of the credential payload. */
  credentials: z.object({
    username: z.string().min(1),
    password: z.string().min(1),
    client_id: z.string().optional(),
    client_secret: z.string().optional(),
    audience: z.string().optional(),
    scope: z.string().optional(),
  }),
  /** Dot-path into the mint response. e.g. "AuthenticationResult.IdToken"
   *  for Cognito; "id_token" for Firebase; "access_token" for generic
   *  OAuth2-style. */
  token_path: z.string().min(1),
  refresh_token_path: z.string().optional(),
  /** Seconds-from-now path (preferred) or ISO timestamp path (fallback).
   *  When neither is present the access token is treated as fresh forever
   *  (the operator must rotate manually). */
  expires_in_path: z.string().optional(),
  expires_at_path: z.string().optional(),
  /** Header template applied to outgoing requests. `${token}` is the
   *  only substitution. Default: `Bearer ${token}`. */
  header_template: z.string().optional(),
});
export type TokenMintCredentialValue = z.infer<typeof TokenMintCredentialValue>;

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

export const OAuth2ClientCredentialValue = z.object({
  client_id: z.string(),
  client_secret: z.string().optional(),
});
export type OAuth2ClientCredentialValue = z.infer<typeof OAuth2ClientCredentialValue>;

// Private key credential for machine-to-machine OAuth2 private_key_jwt
// authentication (RFC 7523). Stores the client_id, the PEM or
// JWK-serialized private key, and the signing algorithm so the MCP
// client pool can construct a PrivateKeyJwtProvider non-interactively.
// The private key is encrypted at rest exactly like any other secret.
export const OAuth2PrivateKeyCredentialValue = z.object({
  client_id: z.string(),
  private_key: z.string().min(1),
  algorithm: z.string().min(1),
});
export type OAuth2PrivateKeyCredentialValue = z.infer<typeof OAuth2PrivateKeyCredentialValue>;

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
  | ({ mode: "aws_sigv4" } & AwsSigV4CredentialValue)
  | ({
      mode: "token_mint";
      /** Cached access token from the most recent mint. May be empty
       *  string until the first mint runs. */
      access_token: string;
      refresh_token: string | null;
      expires_at: Date | null;
    } & TokenMintCredentialValue)
  | ({ mode: "oauth2_client" } & OAuth2ClientCredentialValue)
  | ({ mode: "oauth2_private_key" } & OAuth2PrivateKeyCredentialValue);
