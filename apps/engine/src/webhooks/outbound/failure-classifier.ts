// Failure classification for outbound webhook delivery attempts.
//
// The retry ladder already decides *when* to try again; the classifier
// decides *how* the failure should be categorised for dashboards, alerts,
// and replay UX.
//
// Categories:
//   - transient_network: fetch threw (DNS, TCP reset, TLS handshake, …).
//   - transient_5xx   : 500-599 response. Server-side, may recover.
//   - rate_limited    : 429.
//   - auth_failure    : 401 or 403. Usually requires credential rotation.
//   - permanent_4xx   : any other 4xx. Retrying does not help; terminal.
//   - unknown         : fell through every rule (e.g. status 0 but no
//                       error message). Treated as transient.
//
// The classifier is pure and side-effect-free so it can be unit-tested
// without a running webhook server.

export type FailureClass =
  | "transient_network"
  | "transient_5xx"
  | "rate_limited"
  | "auth_failure"
  | "permanent_4xx"
  | "unknown";

export interface ClassifyFailureInput {
  /** HTTP status code. 0 when the request never completed. */
  status: number;
  /** Error string captured by the fetch wrapper. */
  error: string | null;
}

export function classifyFailure(input: ClassifyFailureInput): FailureClass {
  const { status, error } = input;
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth_failure";
  if (status >= 500 && status <= 599) return "transient_5xx";
  if (status >= 400 && status <= 499) return "permanent_4xx";
  // status === 0 (or outside 100-599) means fetch never got a response.
  if (!status && error) return "transient_network";
  return "unknown";
}

/**
 * Permanent failures terminate the retry loop early regardless of
 * attempt count — there's no point re-posting to a 404 endpoint. Auth
 * failures *are* permanent for the automated retry, but we still want
 * them to surface clearly so credential rotation triggers fast.
 */
export function isPermanentFailure(cls: FailureClass): boolean {
  return cls === "permanent_4xx" || cls === "auth_failure";
}
