export interface AvailabilityFailureInput {
  status?: number | undefined;
  code?: string | undefined;
  message?: string | undefined;
}

const TRANSPORT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ETIMEDOUT",
  "EPROTO",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
]);

const PG_UNAVAILABLE_CLASSES = new Set(["08", "53", "57", "58"]);

const TRANSPORT_TEXT_RE =
  /\bfetch failed\b|\bsocket hang up\b|\bnetwork\b.*\b(error|failure)\b|\bconnect(ion)? (refused|reset|timed? ?out)\b|\btimed? ?out\b|\bECONN|\bENOTFOUND\b|\bEAI_AGAIN\b|\bTLS\b.*\bhandshake\b/i;

export function isAvailabilityFailure(input: AvailabilityFailureInput): boolean {
  if (typeof input.status === "number") {
    if (input.status >= 500) return true;
    if (input.status === 429) return true;
    if (input.status >= 400) return false;
  }

  const code = input.code;
  if (code) {
    const upper = code.toUpperCase();
    if (TRANSPORT_CODES.has(upper)) return true;
    if (/^[0-9A-Z]{5}$/.test(upper)) return PG_UNAVAILABLE_CLASSES.has(upper.slice(0, 2));
  }

  const message = input.message;
  if (message && TRANSPORT_TEXT_RE.test(message)) return true;

  return false;
}

export function isAvailabilityFailureFromError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return isAvailabilityFailure({ message: typeof err === "string" ? err : undefined });
  }
  const e = err as { code?: unknown; status?: unknown; message?: unknown; cause?: unknown };
  const direct = isAvailabilityFailure({
    ...(typeof e.status === "number" ? { status: e.status } : {}),
    ...(typeof e.code === "string" ? { code: e.code } : {}),
    ...(typeof e.message === "string" ? { message: e.message } : {}),
  });
  if (direct) return true;
  if (e.cause && typeof e.cause === "object") return isAvailabilityFailureFromError(e.cause);
  return false;
}
