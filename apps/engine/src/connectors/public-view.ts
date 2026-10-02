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
// stored", so the round trip cannot replace a secret with its own mask — and
// keeps it only while the secret still goes where it was stored for.

import { UnprocessableEntityError } from "../http/errors.ts";
import {
  DEFAULT_REDACTED,
  isAlreadyRedacted,
  isLogSensitiveKey,
} from "../logging/scrub-secrets.ts";

/** What a secret reads as in every public connector representation. */
export const CONNECTOR_SECRET_MASK = DEFAULT_REDACTED;

// How the keys of an object are read while walking a config.
//
//   structure — keys are field names the schema defines. Only an exact secret
//               name masks (`client_secret`, `password`, `private_key`, …), so
//               `token_endpoint` and `authorization_endpoint` stay readable.
//   names     — keys are header or query-parameter NAMES the author chose
//               (`Authorization`, `X-Session-Id`, `sig`). There is no schema
//               to be exact against and no list of the names a vendor may
//               pick for a credential, so every value masks except under the
//               few names that plainly carry none.
//   values    — every string is material sent to a token endpoint.
type KeyMode = "structure" | "names" | "values";

const NAME_KEYED_MAPS: ReadonlySet<string> = new Set([
  "static_headers",
  "static_query",
  "default_headers",
  "extra_token_headers",
]);
// `headers` is a field name in many places; under these it is a name-keyed map.
const HEADER_MAP_PARENTS: ReadonlySet<string> = new Set(["probe_endpoint"]);
const SECRET_VALUED_MAPS: ReadonlySet<string> = new Set(["token_request_body_mapping"]);

// Header and query-parameter names whose value is content negotiation, a
// locale or an API version — readable, because an author edits them and
// nothing authenticates with them. A name not listed is read as a credential.
const PLAIN_REQUEST_NAMES: ReadonlySet<string> = new Set([
  "accept",
  "accept-charset",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "content-language",
  "content-type",
  "format",
  "lang",
  "locale",
  "prefer",
  "user-agent",
  "v",
]);
const VERSION_NAME_PATTERN = /(?:^|[-_.])version$/i;

/**
 * Whether a header or query-parameter name plainly carries no credential.
 * One answer to two questions: may the value stored under this name be
 * shown, and may a caller's own value under it be taken as not
 * authenticating the call.
 */
export function isPlainRequestName(name: string): boolean {
  return PLAIN_REQUEST_NAMES.has(name.toLowerCase()) || VERSION_NAME_PATTERN.test(name);
}

function modeForChild(key: string, parent: string | null): KeyMode {
  if (NAME_KEYED_MAPS.has(key)) return "names";
  if (key === "headers" && parent !== null && HEADER_MAP_PARENTS.has(parent)) return "names";
  if (SECRET_VALUED_MAPS.has(key)) return "values";
  return "structure";
}

function isSecretBearing(key: string, mode: KeyMode): boolean {
  if (mode === "values") return true;
  if (mode === "names") return !isPlainRequestName(key);
  return isLogSensitiveKey(key);
}

function maskConfigValue(value: unknown, mode: KeyMode, parent: string | null): unknown {
  if (Array.isArray(value)) return value.map((item) => maskConfigValue(item, mode, parent));
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") {
      // An empty string holds no secret; masking it would report one.
      out[key] = child.length > 0 && isSecretBearing(key, mode) ? CONNECTOR_SECRET_MASK : child;
    } else {
      out[key] = maskConfigValue(child, modeForChild(key, parent), key);
    }
  }
  return out;
}

function descend(value: unknown, segment: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[segment];
}

function valueAt(root: unknown, ...path: string[]): unknown {
  return path.reduce<unknown>(descend, root);
}

/**
 * Whether the value at `path` in a connector config is, or contains, a secret
 * the public projection hides. Asked by whatever would otherwise read a config
 * value on a caller's behalf. The projection itself answers, so there is one
 * definition of "secret-bearing" and a subtree is covered along with a leaf.
 */
export function connectorConfigPathCarriesSecret(
  config: unknown,
  path: readonly string[],
): boolean {
  const stored = valueAt(config ?? {}, ...path);
  const shown = valueAt(maskConfigValue(config ?? {}, "structure", null), ...path);
  return JSON.stringify(stored) !== JSON.stringify(shown);
}

// The places a URL or connection string carries a secret: the password in the
// userinfo, a `password` / `sslpassword` parameter of a connection string
// (query or keyword form), and — in an endpoint URL — every query parameter
// not plainly free of one. Only the secret is touched: scheme, user, host,
// path and parameter names stay as written, because callers read them.
const USERINFO_PASSWORD = /^([a-z][a-z0-9+.-]*:\/\/[^/?#@:]*:)([^/?#]*)(?=@)/i;
const DSN_PASSWORD_PARAMETER =
  /((?:^|[?&\s])((?:ssl)?password)\s*=\s*)('(?:[^'\\]|\\.)*'|[^&#\s]*)/gi;
const URL_QUERY_PARAMETER = /([?&])([^=&#]+)=([^&#]*)/g;
// The userinfo slot wherever it appears inside free text.
const USERINFO_PASSWORD_IN_TEXT = /([a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*:)([^\s/?#@]+)(?=@)/gi;

type SecretRewrite = (slot: string, secret: string) => string;

function rewriteDsnSecrets(dsn: string, rewrite: SecretRewrite): string {
  return dsn
    .replace(
      USERINFO_PASSWORD,
      (_match, prefix: string, secret: string) => `${prefix}${rewrite("userinfo", secret)}`,
    )
    .replace(
      DSN_PASSWORD_PARAMETER,
      (_match, prefix: string, name: string, secret: string) =>
        `${prefix}${rewrite(name.toLowerCase(), secret)}`,
    );
}

function rewriteUrlSecrets(url: string, rewrite: SecretRewrite): string {
  const queryAt = url.indexOf("?");
  const head = (queryAt === -1 ? url : url.slice(0, queryAt)).replace(
    USERINFO_PASSWORD,
    (_match, prefix: string, secret: string) => `${prefix}${rewrite("userinfo", secret)}`,
  );
  if (queryAt === -1) return head;
  const query = url
    .slice(queryAt)
    .replace(URL_QUERY_PARAMETER, (match, separator: string, name: string, secret: string) =>
      isPlainRequestName(name) ? match : `${separator}${name}=${rewrite(`query:${name}`, secret)}`,
    );
  return `${head}${query}`;
}

const maskSecret: SecretRewrite = (_slot, secret) =>
  secret.length > 0 ? CONNECTOR_SECRET_MASK : secret;

/** A status text as it may be shown: a connection string a driver quoted in
 *  its error keeps its host and loses its password. */
function maskStatusText(text: string): string {
  return text
    .replace(
      USERINFO_PASSWORD_IN_TEXT,
      (_match, prefix: string) => `${prefix}${CONNECTOR_SECRET_MASK}`,
    )
    .replace(
      DSN_PASSWORD_PARAMETER,
      (_match, prefix: string, _name: string, secret: string) =>
        `${prefix}${maskSecret("", secret)}`,
    );
}

const STATUS_TEXT_FIELDS = ["last_error", "health_reason", "auth_failed_reason"] as const;

/** What the projection reads. The status texts are optional because a stored
 *  row and a view do not carry the same set of them. */
type ProjectableConnector = {
  config: unknown;
  dsn: string | null;
  base_url: string | null;
} & Partial<Record<(typeof STATUS_TEXT_FIELDS)[number], string | null>>;

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
export function toPublicConnector<T extends ProjectableConnector>(connector: T): T {
  const out: ProjectableConnector = {
    ...connector,
    base_url:
      connector.base_url === null ? null : rewriteUrlSecrets(connector.base_url, maskSecret),
    dsn: connector.dsn === null ? null : rewriteDsnSecrets(connector.dsn, maskSecret),
    config: maskConfigValue(connector.config ?? {}, "structure", null),
  };
  for (const name of STATUS_TEXT_FIELDS) {
    const text = connector[name];
    if (typeof text === "string") out[name] = maskStatusText(text);
  }
  return out as T;
}

// The mask anywhere in a value. The projection only ever replaces a WHOLE
// value (or one slot of a URL), so a value that merely contains the mask —
// `Bearer ***redacted***` — was assembled by a caller. It is not a credential
// and there is nothing stored it could stand for.
const MASK_INSIDE = /\*\*\*redacted(?::[a-z_]+)?\*\*\*/i;

function maskNotRestorable(field: string): UnprocessableEntityError {
  return new UnprocessableEntityError(
    `${field} carries the redaction mask but no stored value exists to keep — send the real value or omit the field`,
    { field },
  );
}

function maskInsideValue(field: string): UnprocessableEntityError {
  return new UnprocessableEntityError(
    `${field} contains the redaction mask inside a longer value — the mask stands for one whole stored secret; send the real value`,
    { field },
  );
}

function destinationChanged(field: string, what: string): UnprocessableEntityError {
  return new UnprocessableEntityError(
    `${field} carries the redaction mask, but ${what} changed — a kept secret is only sent where it was stored for; send the real value`,
    { field },
  );
}

/** Whether a kept config secret would still go where it was stored for:
 *  null when it would, else what moved. */
type DestinationCheck = (path: string) => string | null;

function restoreConfigValue(
  incoming: unknown,
  stored: unknown,
  path: string,
  moved: DestinationCheck,
): unknown {
  if (typeof incoming === "string") {
    if (!MASK_INSIDE.test(incoming)) return incoming;
    if (!isAlreadyRedacted(incoming)) throw maskInsideValue(path);
    if (typeof stored !== "string" || MASK_INSIDE.test(stored)) throw maskNotRestorable(path);
    const what = moved(path);
    if (what !== null) throw destinationChanged(path, what);
    return stored;
  }
  if (Array.isArray(incoming)) {
    const storedItems = Array.isArray(stored) ? stored : [];
    return incoming.map((item, i) =>
      restoreConfigValue(item, storedItems[i], `${path}[${i}]`, moved),
    );
  }
  if (typeof incoming !== "object" || incoming === null) return incoming;
  const storedFields =
    typeof stored === "object" && stored !== null && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(incoming)) {
    out[key] = restoreConfigValue(child, storedFields[key], `${path}.${key}`, moved);
  }
  return out;
}

/**
 * Put the stored secrets back into the masked slots of a URL or connection
 * string. A slot's mask is honoured only when everything around the slots is
 * what is stored: the same string with another host is another destination,
 * and the stored password is not sent there.
 */
function restoreSlots(
  field: string,
  incoming: string,
  stored: string | null,
  rewriteSecrets: (value: string, rewrite: SecretRewrite) => string,
): string {
  const kept = new Map<string, string>();
  const storedAround =
    stored === null
      ? null
      : rewriteSecrets(stored, (slot, secret) => {
          kept.set(slot, secret);
          return "";
        });
  let keptAny = false;
  const restored = rewriteSecrets(incoming, (slot, secret) => {
    if (!MASK_INSIDE.test(secret)) return secret;
    if (!isAlreadyRedacted(secret)) throw maskInsideValue(field);
    const value = kept.get(slot);
    if (value === undefined || value.length === 0 || MASK_INSIDE.test(value)) {
      throw maskNotRestorable(field);
    }
    keptAny = true;
    return value;
  });
  const around = rewriteSecrets(incoming, () => "");
  // A mask outside every secret slot stands for nothing stored.
  if (MASK_INSIDE.test(around)) throw maskInsideValue(field);
  if (keptAny && around !== storedAround) throw destinationChanged(field, "the rest of it");
  return restored;
}

/** Origin and path of an endpoint — the part that decides where a request
 *  goes. A templated or relative value is compared as written. */
function endpointOf(url: string | null | undefined): string | null {
  if (url === null || url === undefined) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

/** The secret-bearing fields of a connector write, as far as the caller sent them. */
export interface ConnectorSecretFields {
  base_url?: string | null | undefined;
  config?: Record<string, unknown> | undefined;
  dsn?: string | undefined;
}

/** What is stored for the connector the write lands on. */
export interface StoredConnectorSecrets {
  base_url: string | null;
  config: unknown;
  dsn: string | null;
}

export interface RestoreMaskedSecretsOptions {
  /** The write also binds the connector to another template, which can move
   *  the OAuth endpoints without `config.oauth` naming them. */
  template_rebound?: boolean;
}

/**
 * Resolve the mask in an incoming write against what is stored.
 *
 * A mask at a path that holds a stored secret means "keep it" and is replaced
 * by that secret — as long as the secret still goes where it was stored for.
 * Whoever read the masked connector never saw the secret; a write that keeps
 * it while pointing the connector somewhere else would hand it to whoever
 * runs that endpoint. So a kept secret requires its destination unchanged:
 *
 *   - `dsn`, `base_url`: everything outside the secret slots equals the
 *     stored string.
 *   - `config.oauth.*`: `token_endpoint` and `issuer_url` equal the stored
 *     ones, and the connector stays bound to the same template.
 *   - every other config path (header and query maps): the effective
 *     `base_url` (origin + path) and `config.endpoint` equal the stored ones.
 *
 * A mask with nothing behind it — a fresh create, or a path the stored
 * connector does not have — and a value that merely contains the mask are
 * refused rather than stored: the mask is never a credential, and saving it
 * would produce a connector that fails at call time with an error pointing at
 * the upstream.
 *
 * Fields the caller did not send are not added.
 */
export function restoreMaskedConnectorSecrets<T extends ConnectorSecretFields>(
  incoming: T,
  stored: StoredConnectorSecrets | null,
  options: RestoreMaskedSecretsOptions = {},
): T {
  const out = { ...incoming };
  if (typeof incoming.base_url === "string") {
    out.base_url = restoreSlots(
      "base_url",
      incoming.base_url,
      stored?.base_url ?? null,
      rewriteUrlSecrets,
    );
  }
  if (incoming.config !== undefined) {
    const config = incoming.config;
    const effectiveBaseUrl = out.base_url === undefined ? stored?.base_url : out.base_url;
    const moved: DestinationCheck = (path) => {
      if (path.startsWith("config.oauth.")) {
        if (options.template_rebound) return "the connector's template";
        for (const key of ["token_endpoint", "issuer_url"]) {
          if (valueAt(config, "oauth", key) !== valueAt(stored?.config, "oauth", key)) {
            return `config.oauth.${key}`;
          }
        }
        return null;
      }
      if (endpointOf(effectiveBaseUrl) !== endpointOf(stored?.base_url)) return "base_url";
      if (valueAt(config, "endpoint") !== valueAt(stored?.config, "endpoint")) {
        return "config.endpoint";
      }
      return null;
    };
    out.config = restoreConfigValue(config, stored?.config, "config", moved) as Record<
      string,
      unknown
    >;
  }
  if (incoming.dsn !== undefined) {
    out.dsn = restoreSlots("dsn", incoming.dsn, stored?.dsn ?? null, rewriteDsnSecrets);
  }
  return out;
}
