import { storedScopes } from "./authority-scopes.ts";
import type {
  AwsSigV4CredentialValue,
  BasicCredentialValue,
  BearerCredentialValue,
  CredentialMode,
  DecryptedCredential,
  HeaderCredentialValue,
  OAuth2ClientCredentialValue,
  OAuth2CredentialValue,
  OAuth2PrivateKeyCredentialValue,
  QueryCredentialValue,
  SignedJwtCredentialValue,
  TokenMintCredentialValue,
  TokenMintShape,
} from "./types.ts";

export type CredentialPlaintext =
  | { mode: "none" }
  | ({ mode: "header" } & HeaderCredentialValue)
  | ({ mode: "query" } & QueryCredentialValue)
  | ({ mode: "bearer" } & BearerCredentialValue)
  | ({ mode: "basic" } & BasicCredentialValue)
  | ({
      mode: "oauth2";
      refresh_token?: string | null;
      expires_at?: Date | null;
    } & OAuth2CredentialValue)
  | ({ mode: "aws_sigv4" } & AwsSigV4CredentialValue)
  | {
      mode: "token_mint";
      access_token: string;
      refresh_token?: string | null;
      expires_at?: Date | null;
      shape: TokenMintShape;
      mint_endpoint: string;
      credentials: TokenMintCredentialValue["credentials"];
      token_path: string;
      refresh_token_path?: string;
      expires_in_path?: string;
      expires_at_path?: string;
      header_template?: string;
    }
  | ({ mode: "oauth2_client" } & OAuth2ClientCredentialValue)
  | ({ mode: "oauth2_private_key" } & OAuth2PrivateKeyCredentialValue)
  | ({ mode: "signed_jwt" } & SignedJwtCredentialValue);

export function serializePlain(value: CredentialPlaintext): string {
  switch (value.mode) {
    case "none":
      return "";
    case "header":
      return JSON.stringify({ headers: value.headers });
    case "query":
      return JSON.stringify({ query: value.query });
    case "bearer":
      return JSON.stringify({ token: value.token });
    case "basic":
      return JSON.stringify({ username: value.username, password: value.password });
    case "oauth2":
      return JSON.stringify({
        issuer: value.issuer,
        access_token: value.access_token,
        token_type: value.token_type ?? "Bearer",
        scope: value.scope === undefined ? undefined : storedScopes(value.scope),
      });
    case "aws_sigv4":
      return JSON.stringify({
        access_key_id: value.access_key_id,
        secret_access_key: value.secret_access_key,
        ...(value.session_token ? { session_token: value.session_token } : {}),
      });
    case "token_mint":
      return JSON.stringify({
        access_token: value.access_token,
        shape: value.shape,
        mint_endpoint: value.mint_endpoint,
        credentials: value.credentials,
        token_path: value.token_path,
        ...(value.refresh_token_path ? { refresh_token_path: value.refresh_token_path } : {}),
        ...(value.expires_in_path ? { expires_in_path: value.expires_in_path } : {}),
        ...(value.expires_at_path ? { expires_at_path: value.expires_at_path } : {}),
        ...(value.header_template ? { header_template: value.header_template } : {}),
      });
    case "oauth2_client":
      return JSON.stringify({
        issuer: value.issuer,
        client_id: value.client_id,
        ...(value.client_secret ? { client_secret: value.client_secret } : {}),
      });
    case "oauth2_private_key":
      return JSON.stringify({
        client_id: value.client_id,
        private_key: value.private_key,
        algorithm: value.algorithm,
      });
    case "signed_jwt":
      return JSON.stringify({ private_key: value.private_key });
  }
}

export function deserializePlain(mode: CredentialMode, raw: string): DecryptedCredential {
  if (mode === "none") return { mode: "none" };
  const parsed = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
  switch (mode) {
    case "header":
      return { mode: "header", headers: (parsed.headers as Record<string, string>) ?? {} };
    case "query":
      return { mode: "query", query: (parsed.query as Record<string, string>) ?? {} };
    case "bearer":
      return { mode: "bearer", token: String(parsed.token ?? "") };
    case "basic":
      return {
        mode: "basic",
        username: String(parsed.username ?? ""),
        password: String(parsed.password ?? ""),
      };
    case "oauth2":
      return {
        mode: "oauth2",
        ...(typeof parsed.issuer === "string" ? { issuer: parsed.issuer } : {}),
        access_token: String(parsed.access_token ?? ""),
        token_type: String(parsed.token_type ?? "Bearer"),
        scope: parsed.scope as string | undefined,
        refresh_token: null,
        expires_at: null,
      };
    case "aws_sigv4":
      return {
        mode: "aws_sigv4",
        access_key_id: String(parsed.access_key_id ?? ""),
        secret_access_key: String(parsed.secret_access_key ?? ""),
        ...(typeof parsed.session_token === "string"
          ? { session_token: parsed.session_token }
          : {}),
      };
    case "token_mint":
      return {
        mode: "token_mint",
        access_token: String(parsed.access_token ?? ""),
        refresh_token: null,
        expires_at: null,
        shape: (parsed.shape as TokenMintShape) ?? "json",
        mint_endpoint: String(parsed.mint_endpoint ?? ""),
        credentials: (parsed.credentials as TokenMintCredentialValue["credentials"]) ?? {
          username: "",
          password: "",
        },
        token_path: String(parsed.token_path ?? ""),
        ...(typeof parsed.refresh_token_path === "string"
          ? { refresh_token_path: parsed.refresh_token_path }
          : {}),
        ...(typeof parsed.expires_in_path === "string"
          ? { expires_in_path: parsed.expires_in_path }
          : {}),
        ...(typeof parsed.expires_at_path === "string"
          ? { expires_at_path: parsed.expires_at_path }
          : {}),
        ...(typeof parsed.header_template === "string"
          ? { header_template: parsed.header_template }
          : {}),
      };
    case "oauth2_client":
      return {
        mode: "oauth2_client",
        ...(typeof parsed.issuer === "string" ? { issuer: parsed.issuer } : {}),
        client_id: String(parsed.client_id ?? ""),
        ...(typeof parsed.client_secret === "string"
          ? { client_secret: parsed.client_secret }
          : {}),
      };
    case "oauth2_private_key":
      return {
        mode: "oauth2_private_key",
        client_id: String(parsed.client_id ?? ""),
        private_key: String(parsed.private_key ?? ""),
        algorithm: String(parsed.algorithm ?? ""),
      };
    case "signed_jwt":
      return { mode: "signed_jwt", private_key: String(parsed.private_key ?? "") };
    default: {
      const exhaustive: never = mode;
      void exhaustive;
      throw new Error(`unknown credential mode: ${mode}`);
    }
  }
}
