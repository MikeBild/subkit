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
 *  unwrap a single name/value pair into a record. */
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
  }
}
