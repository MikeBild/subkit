const TRANSIENT_CLASSES = [
  "THROTTL",
  "RATE_LIMIT",
  "RATELIMIT",
  "TOO_MANY_REQUESTS",
  "TIMEOUT",
  "UNAVAILABLE",
  "SERVICE_UNAVAILABLE",
  "TRY_AGAIN",
  "TRYAGAIN",
  "INTERNAL",
] as const;

function containsClass(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const upper = value.toUpperCase();
  return TRANSIENT_CLASSES.some((cls) => upper.includes(cls));
}

function entryIsRetryable(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  const ext =
    e.extensions && typeof e.extensions === "object"
      ? (e.extensions as Record<string, unknown>)
      : null;

  const httpExt =
    ext?.http && typeof ext.http === "object" ? (ext.http as Record<string, unknown>) : null;
  const hasStructured =
    ext?.code !== undefined ||
    e.type !== undefined ||
    e.errorType !== undefined ||
    ext?.classification !== undefined ||
    httpExt !== null;

  if (hasStructured) {
    if (containsClass(ext?.code as string | undefined)) return true;
    if (containsClass(e.type as string | undefined)) return true;
    if (containsClass(e.errorType as string | undefined)) return true;
    if (containsClass(ext?.classification as string | undefined)) return true;
    const httpStatus = httpExt?.status;
    if (typeof httpStatus === "number" && (httpStatus === 429 || httpStatus >= 500)) return true;
    return false;
  }

  return containsClass(e.message as string | undefined);
}

export function isGraphqlRetryable(status: number, body: unknown): boolean {
  if (status === 501) return false;
  if (status === 429 || status >= 500) return true;

  const errors = (body as { errors?: unknown } | null | undefined)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return false;

  return errors.some(entryIsRetryable);
}

const RATE_LIMIT_MESSAGE = /\brate limit\b/i;

function errorEntries(body: unknown): Record<string, unknown>[] {
  const errors = (body as { errors?: unknown } | null | undefined)?.errors;
  return Array.isArray(errors)
    ? errors.filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
    : [];
}

function entryIsRateLimited(entry: Record<string, unknown>): boolean {
  const ext =
    entry.extensions && typeof entry.extensions === "object"
      ? (entry.extensions as Record<string, unknown>)
      : null;
  return [entry.type, ext?.code, entry.errorType].some(
    (field) =>
      typeof field === "string" && /RATE_?LIMIT|THROTTL|TOO_MANY/.test(field.toUpperCase()),
  );
}

export function graphqlRateLimited(
  status: number,
  headers: Readonly<Record<string, string>>,
  body: unknown,
): boolean {
  if (status === 429) return true;
  if (status !== 200 && status !== 403) return false;
  const entries = errorEntries(body);
  if (entries.some(entryIsRateLimited)) return true;
  const failed = status === 403 || entries.length > 0;
  if (!failed) return false;
  if (headers["x-ratelimit-remaining"] === "0") return true;
  if (status === 403 && headers["retry-after"] !== undefined) return true;
  const message = (body as { message?: unknown } | null | undefined)?.message;
  return [message, ...entries.map((entry) => entry.message)].some(
    (text) => typeof text === "string" && RATE_LIMIT_MESSAGE.test(text),
  );
}

const SCHEMA_ERROR_CLASSES = [
  "VALIDATION",
  "FIELDUNDEFINED",
  "FIELD_UNDEFINED",
  "NOT_IMPLEMENTED",
  "UNKNOWN_FIELD",
] as const;

const SCHEMA_ERROR_MESSAGE_PHRASES = [
  "fieldundefined",
  "cannot query field",
  "no resolver",
  "not_implemented",
  "not found in type",
  "is undefined",
] as const;

function containsSchemaClass(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const upper = value.toUpperCase();
  return SCHEMA_ERROR_CLASSES.some((cls) => upper.includes(cls));
}

function rootFieldFromMessage(message: string): string | null {
  const qualified = message.match(/\b(?:Query|Mutation|Subscription)\.([A-Za-z_][A-Za-z0-9_]*)/);
  if (qualified?.[1]) return qualified[1];
  const singleQuoted = message.match(/[Ff]ield '([A-Za-z_][A-Za-z0-9_]*)'/);
  if (singleQuoted?.[1]) return singleQuoted[1];
  const doubleQuoted = message.match(/[Cc]annot query field "([A-Za-z_][A-Za-z0-9_]*)"/);
  if (doubleQuoted?.[1]) return doubleQuoted[1];
  return null;
}

interface GraphqlSchemaErrorVerdict {
  schema_shaped: boolean;
  root_field: string | null;
}

export function classifyGraphqlSchemaError(body: unknown): GraphqlSchemaErrorVerdict {
  const errors = (body as { errors?: unknown } | null | undefined)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) {
    return { schema_shaped: false, root_field: null };
  }
  let schemaShaped = false;
  let rootField: string | null = null;
  for (const entry of errors) {
    if (!entry || typeof entry !== "object") continue;
    if (entryIsRetryable(entry)) continue;
    const e = entry as Record<string, unknown>;
    const ext =
      e.extensions && typeof e.extensions === "object"
        ? (e.extensions as Record<string, unknown>)
        : null;
    const message = typeof e.message === "string" ? e.message : "";
    const structuredHit =
      containsSchemaClass(ext?.code as string | undefined) ||
      containsSchemaClass(e.errorType as string | undefined) ||
      containsSchemaClass(ext?.classification as string | undefined);
    const messageHit =
      !structuredHit && SCHEMA_ERROR_MESSAGE_PHRASES.some((p) => message.toLowerCase().includes(p));
    if (structuredHit || messageHit) {
      schemaShaped = true;
      rootField ??= rootFieldFromMessage(message);
    }
  }
  return { schema_shaped: schemaShaped, root_field: rootField };
}
