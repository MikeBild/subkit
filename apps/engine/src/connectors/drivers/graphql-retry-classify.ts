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
    e.errorType !== undefined ||
    ext?.classification !== undefined ||
    httpExt !== null;

  if (hasStructured) {
    if (containsClass(ext?.code as string | undefined)) return true;
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

export interface GraphqlSchemaErrorVerdict {
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
