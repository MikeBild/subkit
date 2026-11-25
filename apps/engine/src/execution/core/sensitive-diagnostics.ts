export const STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx", "network", "timeout"] as const;
export type StatusClass = (typeof STATUS_CLASSES)[number];

export const BODY_SIZE_BUCKETS = ["<1KB", "<10KB", "<100KB", "<1MB", ">=1MB"] as const;
export type BodySizeBucket = (typeof BODY_SIZE_BUCKETS)[number];

export const PLACEHOLDER_TYPES = [
  "string",
  "number",
  "boolean",
  "null",
  "array",
  "object",
  "unresolved",
] as const;
export type PlaceholderType = (typeof PLACEHOLDER_TYPES)[number];

const MAX_PLACEHOLDER_TYPES = 32;
const PLACEHOLDER_TYPE_SET: ReadonlySet<unknown> = new Set(PLACEHOLDER_TYPES);
const BODY_SIZE_BUCKET_SET: ReadonlySet<unknown> = new Set(BODY_SIZE_BUCKETS);
const PLACEHOLDER_NAME = /^[A-Za-z0-9_.[\]-]{1,128}$/;
const HIDDEN_PLACEHOLDER_KINDS = new Set(["cred", "secret"]);

const CODE_CLASSES: Readonly<Record<string, StatusClass>> = {
  http_4xx: "4xx",
  http_429: "4xx",
  upstream_rate_limited: "4xx",
  http_5xx: "5xx",
  graphql_5xx: "5xx",
  connection: "network",
  timeout: "timeout",
  step_timeout: "timeout",
};

const STATUS_CLASS_SET: ReadonlySet<string> = new Set(STATUS_CLASSES);

export function isStatusClass(value: unknown): value is StatusClass {
  return typeof value === "string" && STATUS_CLASS_SET.has(value);
}

export function statusClass(signal: number | string | null | undefined): StatusClass | null {
  if (typeof signal === "number") {
    if (!Number.isInteger(signal) || signal < 200 || signal > 599) return null;
    return `${Math.floor(signal / 100)}xx` as StatusClass;
  }
  if (!signal) return null;
  if (isStatusClass(signal)) return signal;
  return CODE_CLASSES[signal] ?? null;
}

function fieldOf(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

export function failureStatusClass(error: unknown, status?: unknown): StatusClass | null {
  if (!error || typeof error !== "object") return null;
  const recorded = fieldOf(error, "status_class");
  if (isStatusClass(recorded)) return recorded;
  const upstream = fieldOf(error, "upstream_status");
  const code = fieldOf(error, "code");
  return (
    statusClass(typeof upstream === "number" ? upstream : null) ??
    statusClass(typeof status === "number" ? status : null) ??
    statusClass(typeof code === "string" ? code : null)
  );
}

const BUCKET_LIMITS: ReadonlyArray<readonly [number, BodySizeBucket]> = [
  [1024, "<1KB"],
  [10 * 1024, "<10KB"],
  [100 * 1024, "<100KB"],
  [1024 * 1024, "<1MB"],
];

export function bodySizeBucket(bytes: number | null | undefined): BodySizeBucket | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
  return BUCKET_LIMITS.find(([limit]) => bytes < limit)?.[1] ?? ">=1MB";
}

export function isBodySizeBucket(value: unknown): value is BodySizeBucket {
  return BODY_SIZE_BUCKET_SET.has(value);
}

export function bodyByteLength(body: unknown): number | null {
  if (body === null || body === undefined) return null;
  return new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body))
    .byteLength;
}

function jsonTypeOf(value: unknown): PlaceholderType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const kind = typeof value;
  return kind === "string" || kind === "number" || kind === "boolean" || kind === "object"
    ? kind
    : "unresolved";
}

function childOf(resolved: unknown, key: string | number): unknown {
  if (resolved === null || typeof resolved !== "object") return undefined;
  return (resolved as Record<string | number, unknown>)[key];
}

const PLACEHOLDER_TOKEN = /(?<!\$)\$\{([^{}]*)\}/g;

function stringPlaceholderTypes(
  template: string,
  resolved: unknown,
): Array<readonly [string, PlaceholderType]> {
  const trimmed = template.trim();
  const tokens = [...trimmed.matchAll(PLACEHOLDER_TOKEN)];
  const whole = tokens.length === 1 && tokens[0]?.[0] === trimmed;
  const unresolved = resolved === undefined || resolved === template;
  return tokens
    .map((token) => (token[1] ?? "").trim())
    .filter((name) => !HIDDEN_PLACEHOLDER_KINDS.has(name.split(".")[0] ?? ""))
    .map((name) => [name, unresolved ? "unresolved" : whole ? jsonTypeOf(resolved) : "string"]);
}

function collectPlaceholderTypes(
  template: unknown,
  resolved: unknown,
): Array<readonly [string, PlaceholderType]> {
  if (typeof template === "string") return stringPlaceholderTypes(template, resolved);
  if (Array.isArray(template))
    return template.flatMap((entry, index) =>
      collectPlaceholderTypes(entry, childOf(resolved, index)),
    );
  if (template && typeof template === "object")
    return Object.entries(template).flatMap(([key, entry]) =>
      collectPlaceholderTypes(entry, childOf(resolved, key)),
    );
  return [];
}

export function placeholderTypes(
  template: unknown,
  resolved: unknown,
): Record<string, PlaceholderType> {
  return (
    recordedPlaceholderTypes(Object.fromEntries(collectPlaceholderTypes(template, resolved))) ?? {}
  );
}

export function recordedPlaceholderTypes(value: unknown): Record<string, PlaceholderType> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value)
    .filter(
      (entry): entry is [string, PlaceholderType] =>
        PLACEHOLDER_NAME.test(entry[0]) && PLACEHOLDER_TYPE_SET.has(entry[1]),
    )
    .slice(0, MAX_PLACEHOLDER_TYPES);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}
