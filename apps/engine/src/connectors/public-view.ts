import { UnprocessableEntityError } from "../http/errors.ts";
import {
  DEFAULT_REDACTED,
  isAlreadyRedacted,
  isLogSensitiveKey,
} from "../logging/scrub-secrets.ts";

export const CONNECTOR_SECRET_MASK = DEFAULT_REDACTED;

type KeyMode = "structure" | "names" | "values";

const NAME_KEYED_MAPS: ReadonlySet<string> = new Set([
  "static_headers",
  "static_query",
  "default_headers",
  "extra_token_headers",
]);
const HEADER_MAP_PARENTS: ReadonlySet<string> = new Set(["probe_endpoint"]);
const SECRET_VALUED_MAPS: ReadonlySet<string> = new Set(["token_request_body_mapping"]);

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

export function connectorConfigPathCarriesSecret(
  config: unknown,
  path: readonly string[],
): boolean {
  const stored = valueAt(config ?? {}, ...path);
  const shown = valueAt(maskConfigValue(config ?? {}, "structure", null), ...path);
  return JSON.stringify(stored) !== JSON.stringify(shown);
}

const USERINFO_PASSWORD = /^([a-z][a-z0-9+.-]*:\/\/[^/?#@:]*:)([^/?#]*)(?=@)/i;
const DSN_PASSWORD_PARAMETER =
  /((?:^|[?&\s])((?:ssl)?password)\s*=\s*)('(?:[^'\\]|\\.)*'|[^&#\s]*)/gi;
const URL_QUERY_PARAMETER = /([?&])([^=&#]+)=([^&#]*)/g;
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

export function baseUrlCarriesSecret(base_url: string): boolean {
  return rewriteUrlSecrets(base_url, maskSecret) !== base_url;
}

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

type ProjectableConnector = {
  config: unknown;
  dsn: string | null;
  base_url: string | null;
} & Partial<Record<(typeof STATUS_TEXT_FIELDS)[number], string | null>>;

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
  if (MASK_INSIDE.test(around)) throw maskInsideValue(field);
  if (keptAny && around !== storedAround) throw destinationChanged(field, "the rest of it");
  return restored;
}

function endpointOf(url: string | null | undefined): string | null {
  if (url === null || url === undefined) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

interface ConnectorSecretFields {
  base_url?: string | null | undefined;
  config?: Record<string, unknown> | undefined;
  dsn?: string | undefined;
}

export interface StoredConnectorSecrets {
  base_url: string | null;
  config: unknown;
  dsn: string | null;
}

interface RestoreMaskedSecretsOptions {
  template_rebound?: boolean;
}

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
