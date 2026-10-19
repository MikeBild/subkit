import { z } from "zod";

export const CredentialMode = z.enum([
  "none",
  "header",
  "query",
  "bearer",
  "basic",
  "oauth2",
  "aws_sigv4",
  "token_mint",
  "oauth2_client",
  "oauth2_private_key",
  "signed_jwt",
]);
export type CredentialMode = z.infer<typeof CredentialMode>;

const SECRET_MODES = new Set(["header", "query", "bearer", "basic", "aws_sigv4", "signed_jwt"]);
const TOKEN_AUTH_TYPES = new Set(["oauth2", "oauth2_client", "oauth2_private_key"]);

export function credentialServesAuthType(auth_type: string, mode: string): boolean {
  if (auth_type === "none") return false;
  if (auth_type === "signed_jwt") return mode === "signed_jwt";
  if (SECRET_MODES.has(mode)) return mode === auth_type;
  if (mode === "oauth2" || mode === "connection") return TOKEN_AUTH_TYPES.has(auth_type);
  return true;
}

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
  issuer: z.string().url().optional(),
  access_token: z.string(),
  token_type: z.string().default("Bearer"),
  scope: z.string().optional(),
});
export type OAuth2CredentialValue = z.infer<typeof OAuth2CredentialValue>;

export const TokenMintShape = z.enum(["json", "form", "aws_initiate_auth"]);
export type TokenMintShape = z.infer<typeof TokenMintShape>;

export const TokenMintCredentialValue = z.object({
  shape: TokenMintShape,
  mint_endpoint: z.string().url(),
  credentials: z.object({
    username: z.string().min(1),
    password: z.string().min(1),
    client_id: z.string().optional(),
    client_secret: z.string().optional(),
    audience: z.string().optional(),
    scope: z.string().optional(),
  }),
  token_path: z.string().min(1),
  refresh_token_path: z.string().optional(),
  expires_in_path: z.string().optional(),
  expires_at_path: z.string().optional(),
  header_template: z.string().optional(),
});
export type TokenMintCredentialValue = z.infer<typeof TokenMintCredentialValue>;

export const AwsSigV4CredentialValue = z.object({
  access_key_id: z.string().min(1),
  secret_access_key: z.string().min(1),
  session_token: z.string().optional(),
});
export type AwsSigV4CredentialValue = z.infer<typeof AwsSigV4CredentialValue>;

export const OAuth2ClientCredentialValue = z.object({
  issuer: z.string().url().optional(),
  client_id: z.string(),
  client_secret: z.string().optional(),
});
export type OAuth2ClientCredentialValue = z.infer<typeof OAuth2ClientCredentialValue>;

export const OAuth2PrivateKeyCredentialValue = z.object({
  client_id: z.string(),
  private_key: z.string().min(1),
  algorithm: z.string().min(1),
});
export type OAuth2PrivateKeyCredentialValue = z.infer<typeof OAuth2PrivateKeyCredentialValue>;

export const SignedJwtCredentialValue = z.object({
  private_key: z.string().min(1),
});
export type SignedJwtCredentialValue = z.infer<typeof SignedJwtCredentialValue>;

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
      access_token: string;
      refresh_token: string | null;
      expires_at: Date | null;
    } & TokenMintCredentialValue)
  | ({ mode: "oauth2_client" } & OAuth2ClientCredentialValue)
  | ({ mode: "oauth2_private_key" } & OAuth2PrivateKeyCredentialValue)
  | ({ mode: "signed_jwt" } & SignedJwtCredentialValue);
