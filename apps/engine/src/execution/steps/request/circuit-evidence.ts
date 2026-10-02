// What one connector call PROVED about the remote, for the circuit breaker.
//
// `connectors/availability.ts` answers a two-valued question: is this failure
// the remote's fault? The breaker asks a three-valued one, because it does two
// things — it counts failures AND it closes on recovery — and "not the
// remote's fault" is the wrong answer for both:
//
//   answered    — the remote replied, whatever it said. A 404 from a store, a
//                 GraphQL `errors` array and an MCP `isError` result are all
//                 proof that the remote is serving, so each closes a half-open
//                 breaker and clears a partial failure count.
//   unavailable — the failure is evidence about reachability. Counts toward the
//                 threshold.
//   none        — nothing was observed about the remote: the request was
//                 rejected before it left, or the run was cancelled. Neither
//                 counted nor credited, because claiming reachability we never
//                 observed would close a breaker on no evidence at all.
//
// It is an AVAILABILITY breaker, not an error-rate breaker. Nothing here
// counts how often calls fail; it counts how often the remote could not be
// reached. A connector that answers "no" to every request keeps its breaker
// closed on purpose — refusing every request is a working service, and
// tripping on it would take the author's own bug out on the connector.
//
// This module exists because the drivers each disagreed about the second and
// third answers: the HTTP path counted every failure that got past its retry
// loop, a rejected credential included, the s3 branch credited
// reachability for any response INCLUDING a 5xx, while the graphql branch
// credited it for none at all and never handed the endpoint's status to the
// availability predicate — so a GraphQL 502 read as "not the remote's fault"
// and a stored 500 read as "the store is healthy". Both are now one rule.

import {
  isAvailabilityFailure,
  isAvailabilityFailureFromError,
} from "../../../connectors/availability.ts";
import type { StepResult } from "../../types.ts";
import { RequestError } from "./errors.ts";

export type ConnectorEvidence = "answered" | "unavailable" | "none";

/**
 * Evidence from a protocol that reported a status code. 5xx and 429 are the
 * remote telling us it could not serve the request; every other status is an
 * answer, and an answer is proof of reachability however unwelcome it is.
 */
export function evidenceFromStatus(status: number): ConnectorEvidence {
  return isAvailabilityFailure({ status }) ? "unavailable" : "answered";
}

/**
 * Evidence from a caught driver error.
 *
 * Deliberately never `answered`: an exception is not a reply. A driver that
 * throws may have been refused by the remote or may never have reached it —
 * a malformed request, a credential the driver would not send, a query the
 * client rejected locally — and the branch that caught it cannot tell those
 * apart without per-driver error archaeology. So a throw that the
 * availability predicate recognises counts, and every other throw is treated
 * as having observed nothing.
 */
export function evidenceFromThrow(err: unknown): ConnectorEvidence {
  return isAvailabilityFailureFromError(err) ? "unavailable" : "none";
}

/**
 * Evidence from a failed HTTP request step, read off what the retry loop gave
 * up with.
 *
 * The HTTP path used to count every failure that reached its outer handler,
 * on the reasoning that the retry loop had already tried. But the loop gives
 * up at once on a 401, a 404 or a request that never left, and none of those
 * is the remote failing to serve: a rejected credential opened the breaker,
 * and the reader was told the connector was unreachable when it had answered
 * every call. A rejected credential is the re-auth flag's to report.
 *
 * `step_timed_out` is the caller's knowledge that the abort came from the
 * step's own timer rather than from a cancelled run — the first is a remote
 * that did not answer in time, the second is nothing about the remote at all.
 */
export function requestFailureEvidence(err: unknown, step_timed_out: boolean): ConnectorEvidence {
  if (!(err instanceof RequestError)) return evidenceFromThrow(err);
  if (typeof err.status === "number") return evidenceFromStatus(err.status);
  // No status: the retry loop already named what it gave up on, which says
  // more than the error text — a transport failure is rethrown under whatever
  // message the runtime chose for it.
  switch (err.cause_kind) {
    case "http_5xx":
    case "http_429":
    case "connection":
    case "timeout":
      return "unavailable";
    case "http_4xx":
    // The response arrived and one of the author's filters rejected it.
    case "filter_fail":
      return "answered";
    case "abort":
      return step_timed_out ? "unavailable" : "none";
    // Refused before it left: governance, or a request that was malformed.
    case "authority_invalid":
    case "request_invalid":
      return "none";
  }
}

/**
 * Evidence from a GraphQL step result.
 *
 * `runGraphqlWithRetry` returns a failed result for two different reasons and
 * they are distinguishable: when a response arrived it stamps the endpoint's
 * HTTP status onto `request_meta`, and when the attempt threw before one
 * arrived it returns no `request_meta` at all. Reading the status is what
 * makes an exhausted 5xx retry loop count toward the breaker — passing only
 * the error detail threw the status away, and the predicate then had nothing
 * but the message "graphql endpoint returned 502" to go on.
 */
export function graphqlEvidence(
  result: Pick<StepResult, "status" | "request_meta" | "error">,
): ConnectorEvidence {
  if (result.status === "succeeded") return "answered";
  const meta = result.request_meta;
  if (meta && meta.driver === "graphql") return evidenceFromStatus(meta.status);
  return evidenceFromThrow(result.error);
}

/**
 * Evidence from an MCP step result, read off the error code the retry loop
 * chose. That code is already the layer verdict (`mcp-retry.ts` derives it
 * from the pool's `failure` field), so re-deriving it here would be a second
 * opinion about the same fact.
 *
 * Anything other than the three known codes falls through to `none` on
 * purpose: a code this function has not been taught must not be allowed to
 * credit reachability by default.
 *
 * A step whose `error_policy` is "all" tolerates a remote error and arrives
 * here as `succeeded`, so it credits reachability through the first line
 * rather than the `mcp_remote_error` one. The two routes agree because they
 * assert the same fact — the server answered — and the author's tolerance of
 * the answer is not evidence about the server either way. That an accepted
 * remote error succeeds is pinned by mcp-request-step.test.ts.
 */
export function mcpEvidence(result: Pick<StepResult, "status" | "error">): ConnectorEvidence {
  if (result.status === "succeeded") return "answered";
  const code = result.error?.code;
  if (code === "mcp_unavailable") return "unavailable";
  // The server answered and rejected the call. Retrying would re-send an
  // argument it already refused, but it is still serving.
  if (code === "mcp_remote_error") return "answered";
  return "none";
}
