// Process-local cache of draft-time credentials.
//
// `probe_connector_draft` runs before the connector exists in the
// `connectors` table — its synthetic id (`draft-<conversation_id>`)
// does not match the UUID-typed `connector_credentials.connector_id`,
// so the standard `getCredentialForConnector` lookup short-circuits to
// null and the probe goes out unauthenticated. That is what produces
// the "401 / Last used: Never" symptom users see when authoring a
// connector with bearer/basic/header/query auth.
//
// We keep the credential in memory only — never persisted, never
// echoed in `draft.session`/`draft.connector` (those are written to
// the conversation row), never serialized to SSE replay, never
// returned from any tool result. The cache is keyed by
// `conversation_id` and survives across turns within the same engine
// process (a 30-min TTL covers a reasonable authoring session).
//
// Lifecycle:
//   - populated by `respondElicitation` when an `ask_user_form`
//     submission contains credential-shaped fields for the active
//     draft's `auth_type`.
//   - read by `probe_connector_draft` and converted to a
//     `DecryptedCredential` override fed straight into the HTTP driver.
//   - cleared by `saveConnectorAtomic` after the credential has been
//     written to the encrypted `connector_credentials` table, by the
//     conversation-deletion path, and on TTL expiry.
//
// Trade-off: the cache lives in process memory only. A multi-instance
// engine deployment serving turns of the same conversation across
// pods would lose the credential between turns. subkit is not yet
// multi-instance, and the user explicitly chose this shape over a
// schema migration.

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

/** Translate the persistence-shape credential into the HTTP driver's
 *  decrypted shape so it can be passed as a `credential_override` to
 *  `buildRequestPlan` without round-tripping through the credentials
 *  service. The two shapes diverge for `header`/`query` modes — those
 *  unwrap a single name/value pair into a record.
 *
 *  Pure for the four classic modes (`bearer`/`basic`/`header`/`query`)
 *  + `aws_sigv4` — caller can use the sync overload below.
 *  `cognito_user_password` requires a network exchange; use
 *  `toDecryptedCredentialAsync` for that case. */
export function toDecryptedCredential(input: AtomicCredentialInput): DecryptedCredential {
  switch (input.mode) {
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
      // OAuth2 seed updates `connector.config.oauth` so a subsequent
      // `authenticate_oauth` call can run the dance — it never produces
      // a credential row directly. There is no decrypted-credential
      // shape to return here.
      throw new Error(
        "oauth2 seed updates config.oauth only — no DecryptedCredential is available until authenticate_oauth completes the dance",
      );
  }
}

/** Async variant — handles `cognito_user_password` by minting an
 *  IdToken via Cognito InitiateAuth before returning the oauth2
 *  decrypted credential. The caller passes a connector context (region
 *  + client_id) which can be overridden by the credential itself.
 *  Other modes round-trip through the sync `toDecryptedCredential`. */
export async function toDecryptedCredentialAsync(
  input: AtomicCredentialInput,
  ctx: { aws_region?: string | null; client_id?: string | null },
): Promise<DecryptedCredential> {
  if (input.mode !== "cognito_user_password") return toDecryptedCredential(input);
  const region = input.aws_region ?? ctx.aws_region ?? null;
  const client_id = input.client_id ?? ctx.client_id ?? null;
  if (!region || !client_id) {
    // Surface which input slot is missing so the operator-facing
    // error envelope can suggest the right next action: missing
    // region → `update_connector_draft({config: {aws_region}})`,
    // missing client_id → set `oauth.client_id` on the draft.
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
  const bundle = await runCognitoUserPasswordGrant(params);
  return {
    mode: "oauth2",
    access_token: bundle.access_token,
    token_type: bundle.token_type, // "none" — applyAuthMaterial emits raw JWT
    refresh_token: bundle.refresh_token,
    expires_at: bundle.expires_at,
    ...(bundle.scope ? { scope: bundle.scope } : {}),
  };
}

/** Mint a bearer for a machine-to-machine OAuth2 draft (grant_type
 *  `client_credentials_json`) from the cached client_id/client_secret
 *  pair + the draft's `config.oauth` block. No browser dance — the
 *  exchange POSTs JSON to the configured token endpoint (the Xray
 *  Cloud pattern). Throws on a missing endpoint or a failed exchange;
 *  the probe maps that to a structured `token_exchange_failed`
 *  envelope. */
export async function mintM2mDraftCredential(
  input: Extract<AtomicCredentialInput, { mode: "oauth2" }>,
  oauth: Record<string, unknown>,
): Promise<DecryptedCredential> {
  const token_endpoint =
    input.token_endpoint ??
    (typeof oauth.token_endpoint === "string" ? oauth.token_endpoint : null);
  if (!token_endpoint) {
    throw new Error(
      "client_credentials_json draft is missing oauth.token_endpoint — set it via update_connector_draft({ config: { oauth: { token_endpoint: '<url>' } } })",
    );
  }
  const bundle = await runClientCredentialsJsonGrant({
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
  });
  return {
    mode: "oauth2",
    access_token: bundle.access_token,
    token_type: bundle.token_type,
    refresh_token: bundle.refresh_token,
    expires_at: bundle.expires_at,
    ...(bundle.scope ? { scope: bundle.scope } : {}),
  };
}
