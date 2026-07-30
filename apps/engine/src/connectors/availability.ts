// Is this failure the REMOTE's fault or the CALLER's?
//
// The circuit breaker exists to stop hammering a remote that cannot serve
// us. Every failure it counts must therefore be evidence about the remote,
// not about the request we sent. Without that distinction a typo'd SQL
// query, a GraphQL field that does not exist, or an S3 key that was never
// written would each open a breaker and take a healthy connector offline
// for the whole reset window — the connector would be punished for the
// author's mistake, and the author would see "circuit open" instead of
// their syntax error.
//
// The HTTP path gets this right only incidentally: its failure recording
// sits after a retry loop that already gave up. Every other driver returns
// its failure directly, so the distinction has to be explicit.
//
// Keyed on transport-level and status-level evidence only. NEVER on
// vendor keywords or provider names — the same reasoning as
// packages/shared/src/side-effects.ts.

/** The evidence a caller can offer about one failed connector call. */
export interface AvailabilityFailureInput {
  /** HTTP-ish status when the protocol has one. */
  status?: number | undefined;
  /** Machine error code — a node `errno`, a postgres SQLSTATE, an S3
   *  error name. */
  code?: string | undefined;
  /** Raw failure text. Matched only for transport shapes that carry no
   *  code, which is most of what `fetch` throws. */
  message?: string | undefined;
}

// Node/undici transport failures: the request never reached an
// application. Every one of these is evidence about reachability.
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

// Postgres SQLSTATE classes that mean "the server could not serve this",
// as opposed to class 42 (syntax / undefined object) and class 23
// (integrity violation), which mean "the statement was wrong".
//   08 — connection exception
//   53 — insufficient resources
//   57 — operator intervention (shutdown, admin termination)
//   58 — system error
const PG_UNAVAILABLE_CLASSES = new Set(["08", "53", "57", "58"]);

const TRANSPORT_TEXT_RE =
  /\bfetch failed\b|\bsocket hang up\b|\bnetwork\b.*\b(error|failure)\b|\bconnect(ion)? (refused|reset|timed? ?out)\b|\btimed? ?out\b|\bECONN|\bENOTFOUND\b|\bEAI_AGAIN\b|\bTLS\b.*\bhandshake\b/i;

/**
 * True when the failure is evidence that the remote is unavailable, and
 * the circuit breaker should count it.
 *
 * Conservative in the direction that matters: an unrecognised failure is
 * NOT counted. A breaker that stays closed one failure too long costs one
 * more request; a breaker opened by the caller's own bad query takes a
 * working connector offline for the whole reset window.
 */
export function isAvailabilityFailure(input: AvailabilityFailureInput): boolean {
  // 5xx and 429 are the remote telling us it could not serve the request.
  // Every other 4xx is the request's fault and must not count.
  if (typeof input.status === "number") {
    if (input.status >= 500) return true;
    if (input.status === 429) return true;
    if (input.status >= 400) return false;
  }

  const code = input.code;
  if (code) {
    const upper = code.toUpperCase();
    if (TRANSPORT_CODES.has(upper)) return true;
    // A five-character SQLSTATE — classify by its two-character class.
    if (/^[0-9A-Z]{5}$/.test(upper)) return PG_UNAVAILABLE_CLASSES.has(upper.slice(0, 2));
  }

  const message = input.message;
  if (message && TRANSPORT_TEXT_RE.test(message)) return true;

  return false;
}

/** Convenience wrapper for a caught value, for the common case where the
 *  only evidence is the thrown error itself. */
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
  // `fetch` wraps the real errno in `cause`; the outer message is the
  // useless "fetch failed" that would otherwise be the only evidence.
  if (e.cause && typeof e.cause === "object") return isAvailabilityFailureFromError(e.cause);
  return false;
}
