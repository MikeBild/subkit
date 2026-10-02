// The connector as it leaves the engine, and the way back in.
//
// `ConnectorView` is the server-side shape: `config.oauth.client_secret` and
// the password inside `dsn` are in it because the OAuth client and the
// postgres driver read them there. Every representation handed to a caller —
// HTTP, the chat/MCP tool palette, the CLI and the cockpit behind them — goes
// through `toPublicConnector` first, so the secret stays on the server while
// everything around it stays readable.
//
// The mask is BY KEY NAME, never by value shape. A connector config is
// structure the author reads back and edits (endpoints, scopes, header names,
// credential hints); a value-shape net would rewrite whatever happens to look
// like a token and hand back a config that no longer says what is stored.
//
// A masked value is also a valid thing to send back: a client that reads a
// connector, edits one field and writes `config` again returns the mask where
// the secret was. `restoreMaskedConnectorSecrets` reads that as "keep what is
// stored", so the round trip cannot replace a secret with its own mask.

import { UnprocessableEntityError } from "../http/errors.ts";
import {
  DEFAULT_REDACTED,
  isAlreadyRedacted,
  isLogSensitiveKey,
  SENSITIVE_KEY_PATTERN,
} from "../logging/scrub-secrets.ts";

/** What a secret reads as in every public connector representation. */
export const CONNECTOR_SECRET_MASK = DEFAULT_REDACTED;

// How the keys of an object are read while walking a config.
//
//   structure — keys are field names the schema defines. Only an exact secret
//               name masks (`client_secret`, `password`, `private_key`, …), so
//               `token_endpoint` and `authorization_endpoint` stay readable.
//   names     — keys are header or query-parameter NAMES the author chose
//               (`Authorization`, `X-Api-Key`, `key`). There is no schema to be
//               exact against, so a name that mentions a credential masks.
//   values    — every string is material sent to a token endpoint.
type KeyMode = "structure" | "names" | "values";

const NAME_KEYED_MAPS: ReadonlySet<string> = new Set([
  "static_headers",
  "static_query",
  "default_headers",
  "extra_token_headers",
]);
const SECRET_VALUED_MAPS: ReadonlySet<string> = new Set(["token_request_body_mapping"]);
const CREDENTIAL_NAME_PATTERN = /cookie|key/i;

function modeForChild(key: string): KeyMode {
  if (NAME_KEYED_MAPS.has(key)) return "names";
  if (SECRET_VALUED_MAPS.has(key)) return "values";
  return "structure";
}

function isSecretBearing(key: string, mode: KeyMode): boolean {
  if (mode === "values") return true;
  if (mode === "names") {
    return SENSITIVE_KEY_PATTERN.test(key) || CREDENTIAL_NAME_PATTERN.test(key);
  }
  return isLogSensitiveKey(key);
}

function maskConfigValue(value: unknown, mode: KeyMode): unknown {
  if (Array.isArray(value)) return value.map((item) => maskConfigValue(item, mode));
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") {
      // An empty string holds no secret; masking it would report one.
      out[key] = child.length > 0 && isSecretBearing(key, mode) ? CONNECTOR_SECRET_MASK : child;
    } else {
      out[key] = maskConfigValue(child, modeForChild(key));
    }
  }
  return out;
}

// The places a connection string carries a password: the userinfo of a URL,
// a `password` / `sslpassword` query parameter, and the same two words in the
// keyword form (`host=… password=…`). Only the password is touched — scheme,
// user, host and database stay as written, because callers read them.
const DSN_USERINFO_PASSWORD = /^([a-z][a-z0-9+.-]*:\/\/[^/?#@:]*:)([^/?#]*)(?=@)/i;
const DSN_PASSWORD_PARAMETER =
  /((?:^|[?&\s])((?:ssl)?password)\s*=\s*)('(?:[^'\\]|\\.)*'|[^&#\s]*)/gi;

function rewriteDsnSecrets(dsn: string, rewrite: (slot: string, secret: string) => string): string {
  return dsn
    .replace(
      DSN_USERINFO_PASSWORD,
      (_match, prefix: string, secret: string) => `${prefix}${rewrite("userinfo", secret)}`,
    )
    .replace(
      DSN_PASSWORD_PARAMETER,
      (_match, prefix: string, name: string, secret: string) =>
        `${prefix}${rewrite(name.toLowerCase(), secret)}`,
    );
}

function maskDsn(dsn: string): string {
  return rewriteDsnSecrets(dsn, (_slot, secret) =>
    secret.length > 0 ? CONNECTOR_SECRET_MASK : secret,
  );
}

/**
 * The connector with every secret it carries replaced by the mask.
 *
 * Same shape as it was given — a view or a stored row — so a serializer keeps
 * its own field selection and merely reads from the projection, and the audit
 * snapshot of a row is still that row. `template_snapshot` is passed through: it
 * is a copy of catalog content the template routes already publish, the
 * template schema has no secret field (a template's OAuth client lives in the
 * credential store), and its recipes are workflow definitions whose `password`
 * and `Authorization` keys hold `${…}` references — masking those would
 * corrupt the definition and protect nothing.
 */
export function toPublicConnector<T extends { config: unknown; dsn: string | null }>(
  connector: T,
): T {
  return {
    ...connector,
    dsn: connector.dsn === null ? null : maskDsn(connector.dsn),
    config: maskConfigValue(connector.config ?? {}, "structure"),
  };
}

function maskNotRestorable(field: string): UnprocessableEntityError {
  return new UnprocessableEntityError(
    `${field} carries the redaction mask but no stored value exists to keep — send the real value or omit the field`,
    { field },
  );
}

function restoreConfigValue(incoming: unknown, stored: unknown, path: string): unknown {
  if (typeof incoming === "string") {
    if (!isAlreadyRedacted(incoming)) return incoming;
    if (typeof stored !== "string" || isAlreadyRedacted(stored)) throw maskNotRestorable(path);
    return stored;
  }
  if (Array.isArray(incoming)) {
    const storedItems = Array.isArray(stored) ? stored : [];
    return incoming.map((item, i) => restoreConfigValue(item, storedItems[i], `${path}[${i}]`));
  }
  if (typeof incoming !== "object" || incoming === null) return incoming;
  const storedFields =
    typeof stored === "object" && stored !== null && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(incoming)) {
    out[key] = restoreConfigValue(child, storedFields[key], `${path}.${key}`);
  }
  return out;
}

function restoreDsn(incoming: string, stored: string | null): string {
  const storedSecrets = new Map<string, string>();
  if (stored !== null) {
    rewriteDsnSecrets(stored, (slot, secret) => {
      storedSecrets.set(slot, secret);
      return secret;
    });
  }
  return rewriteDsnSecrets(incoming, (slot, secret) => {
    if (!isAlreadyRedacted(secret)) return secret;
    const kept = storedSecrets.get(slot);
    if (kept === undefined || kept.length === 0 || isAlreadyRedacted(kept)) {
      throw maskNotRestorable("dsn");
    }
    return kept;
  });
}

/** The secret-bearing fields of a connector write, as far as the caller sent them. */
export interface ConnectorSecretFields {
  config?: Record<string, unknown> | undefined;
  dsn?: string | undefined;
}

/**
 * Resolve the mask in an incoming write against what is stored.
 *
 * A mask at a path that holds a stored secret means "keep it" and is replaced
 * by that secret. A mask with nothing behind it — a fresh create, or a path
 * the stored connector does not have — is refused rather than stored: the
 * mask is never a credential, and saving it would produce a connector that
 * fails at call time with an error pointing at the upstream.
 *
 * Fields the caller did not send are not added.
 */
export function restoreMaskedConnectorSecrets<T extends ConnectorSecretFields>(
  incoming: T,
  stored: { config: unknown; dsn: string | null } | null,
): T {
  const out = { ...incoming };
  if (incoming.config !== undefined) {
    out.config = restoreConfigValue(incoming.config, stored?.config, "config") as Record<
      string,
      unknown
    >;
  }
  if (incoming.dsn !== undefined) {
    out.dsn = restoreDsn(incoming.dsn, stored?.dsn ?? null);
  }
  return out;
}
