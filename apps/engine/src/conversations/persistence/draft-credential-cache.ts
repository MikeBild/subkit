import type { EgressGuardContext } from "../../connectors/index.ts";
import {
  runClientCredentialsJsonGrant,
  runCognitoUserPasswordGrant,
} from "../../credentials/oauth2/client.ts";
import type { DecryptedCredential } from "../../credentials/types.ts";
import type { AtomicCredentialInput } from "./save-connector.ts";

const TTL_MS = 30 * 60 * 1000;

interface Entry {
  credential: AtomicCredentialInput;
  expires_at: number;
}

const cache = new Map<string, Entry>();

function purgeExpired(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expires_at <= now) cache.delete(key);
  }
}

export function setDraftCredential(
  conversation_id: string,
  credential: AtomicCredentialInput,
): void {
  const now = Date.now();
  purgeExpired(now);
  cache.set(conversation_id, { credential, expires_at: now + TTL_MS });
}

export function getDraftCredential(conversation_id: string): AtomicCredentialInput | null {
  const now = Date.now();
  const entry = cache.get(conversation_id);
  if (!entry) {
    purgeExpired(now);
    return null;
  }
  if (entry.expires_at <= now) {
    cache.delete(conversation_id);
    return null;
  }
  return entry.credential;
}

export function clearDraftCredential(conversation_id: string): void {
  cache.delete(conversation_id);
}

export function _resetDraftCredentialCacheForTests(): void {
  cache.clear();
}

export function toDecryptedCredential(input: AtomicCredentialInput): DecryptedCredential {
  switch (input.mode) {
    case "signed_jwt":
      return { mode: "signed_jwt", private_key: input.private_key };
    case "bearer":
      return { mode: "bearer", token: input.token };
    case "basic":
      return { mode: "basic", username: input.username, password: input.password };
    case "header":
      return {
        mode: "header",
        headers: { [input.header_name]: input.header_value },
      };
    case "query":
      return { mode: "query", query: { [input.param]: input.value } };
    case "aws_sigv4":
      return {
        mode: "aws_sigv4",
        access_key_id: input.access_key_id,
        secret_access_key: input.secret_access_key,
        ...(input.session_token ? { session_token: input.session_token } : {}),
      };
    case "cognito_user_password":
      throw new Error(
        "cognito_user_password requires a network token exchange — use toDecryptedCredentialAsync(input, ctx) instead",
      );
    case "oauth2":
      throw new Error(
        "oauth2 seed updates config.oauth only — no DecryptedCredential is available until authenticate_oauth completes the dance",
      );
  }
}

export async function toDecryptedCredentialAsync(
  input: AtomicCredentialInput,
  ctx: { aws_region?: string | null; client_id?: string | null },
  context: EgressGuardContext,
): Promise<DecryptedCredential> {
  if (input.mode !== "cognito_user_password") return toDecryptedCredential(input);
  const region = input.aws_region ?? ctx.aws_region ?? null;
  const client_id = input.client_id ?? ctx.client_id ?? null;
  if (!region || !client_id) {
    const missing: string[] = [];
    if (!region) missing.push("aws_region (set config.aws_region or config.oauth.aws_region)");
    if (!client_id) missing.push("client_id (set config.oauth.client_id)");
    throw new Error(
      `cognito_user_password connector is missing config: ${missing.join(", ")}. ` +
        `Call update_connector_draft({ config: { aws_region: '<region>', oauth: { client_id: '<client_id>' } } }) — the credential itself is fine.`,
    );
  }
  const params: Parameters<typeof runCognitoUserPasswordGrant>[0] = {
    region,
    client_id,
    username: input.username,
    password: input.password,
    use_access_token: input.use_access_token === true,
  };
  if (input.client_secret) params.client_secret = input.client_secret;
  const bundle = await runCognitoUserPasswordGrant(params, context);
  return {
    mode: "oauth2",
    access_token: bundle.access_token,
    token_type: bundle.token_type,
    refresh_token: bundle.refresh_token,
    expires_at: bundle.expires_at,
    ...(bundle.scope ? { scope: bundle.scope } : {}),
  };
}

export async function mintM2mDraftCredential(
  input: Extract<AtomicCredentialInput, { mode: "oauth2" }>,
  oauth: Record<string, unknown>,
  context: EgressGuardContext,
): Promise<DecryptedCredential> {
  const token_endpoint =
    input.token_endpoint ??
    (typeof oauth.token_endpoint === "string" ? oauth.token_endpoint : null);
  if (!token_endpoint) {
    throw new Error(
      "client_credentials_json draft is missing oauth.token_endpoint — set it via update_connector_draft({ config: { oauth: { token_endpoint: '<url>' } } })",
    );
  }
  const bundle = await runClientCredentialsJsonGrant(
    {
      token_endpoint,
      body_mapping: {
        client_id: input.client_id,
        ...(input.client_secret ? { client_secret: input.client_secret } : {}),
      },
      response_format: oauth.token_response_format === "json" ? "json" : "raw",
      token_response_ttl_ms:
        typeof oauth.token_response_ttl_ms === "number" ? oauth.token_response_ttl_ms : 86_400_000,
      extra_token_headers:
        oauth.extra_headers && typeof oauth.extra_headers === "object"
          ? (oauth.extra_headers as Record<string, string>)
          : undefined,
    },
    context,
  );
  return {
    mode: "oauth2",
    access_token: bundle.access_token,
    token_type: bundle.token_type,
    refresh_token: bundle.refresh_token,
    expires_at: bundle.expires_at,
    ...(bundle.scope ? { scope: bundle.scope } : {}),
  };
}
