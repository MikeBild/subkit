// MCP request step with retry + error_policy.
//
// Same shape as graphql-retry.ts, and for the same reason: the branch that
// owns a driver also owns the loop around it, because the retry decision
// is driver-specific. What differs here is WHAT is retryable.
//
// An MCP call fails at one of three layers, and the pool reports which:
//   - `not_connected` / `transport` — the session could not be
//     established, or died mid-call. Evidence about the remote, so it is
//     retried (the pool reconnects on the next attempt) and it counts
//     toward the connector's circuit breaker — ONCE for the whole step,
//     because this loop reports ONE layer verdict however many attempts
//     it spent. The breaker asks whether the connector is serving
//     requests at all, and a step's retry storm is a single observation
//     of that: counting per attempt would let one step on the default
//     four retries trip a five-failure threshold by itself, and a pooled
//     session makes that worse rather than better, because every retry
//     after the first rides a reconnect of the SAME dead remote. Proved
//     by apps/engine/src/execution/tests/mcp-request-step.test.ts.
//   - `remote_error` — the server answered and said the call failed
//     (`tools/call` with `isError`, a JSON-RPC error, or structured output
//     that failed the tool's own declared schema). Retrying re-sends an
//     argument the remote already rejected, and counting it would open the
//     breaker on the author's own mistake. Neither happens.
//   - `cancelled` — the run was aborted, so the call was too. Not retried
//     (nothing is waiting for the answer), not counted (the connector did
//     nothing wrong), and reported as an ABORTED step rather than a failed
//     one — the engine lifts an aborted step into an aborted run, and a
//     user who stopped a run must not be told it failed. It still carries
//     its own error code, because telling an operator the remote errored
//     when the run was stopped sends them to read a remote that was fine.
//
// `error_policy` mirrors the GraphQL convention exactly: "none" (default)
// fails the step on a remote error, "all" accepts the error content as a
// partial success with a warning. There is no MCP equivalent of
// "data alongside errors" — `isError` covers the whole result — so "all"
// means "hand me what the tool said and let the workflow decide".

import type { McpInvokeResult } from "../../../connectors/drivers/mcp.ts";
import { logger } from "../../../logging/logger.ts";
import { MCP_WIRE_METHOD } from "../../../mcp/client/remote-call.ts";
import { recordRequestRetry } from "../../../observability/instrumentation.ts";
import type { RequestStep } from "../../../workflows/types.ts";
import type { ConnectorResolutionSummary, StepResult, StepWarning } from "../../types.ts";
import { RequestError } from "./errors.ts";
import { backoffMs, resolveRetryPolicy } from "./retry.ts";

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new RequestError("aborted", "abort"));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new RequestError("aborted", "abort"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** True when the failure is about reaching the server rather than about
 *  what we asked it for. The one predicate both the retry loop and the
 *  circuit-breaker recording read, so they can never disagree. */
export function isMcpAvailabilityFailure(failure: McpInvokeResult["failure"]): boolean {
  return failure === "transport" || failure === "not_connected";
}

export interface RunMcpWithRetryParams {
  /** Performs one attempt. Supplied by the dispatcher so this module
   *  neither resolves connectors nor touches the pool. */
  attempt: () => Promise<McpInvokeResult>;
  step: Pick<RequestStep, "max_retries" | "retry_backoff_ms" | "error_policy">;
  signal: AbortSignal;
  /** `Date.now()` at step start — for duration accounting. */
  start: number;
  connector: ConnectorResolutionSummary;
  /** Operation label for logs and `request_meta`. */
  operation: string;
  connector_id: string;
}

export async function runMcpWithRetry(p: RunMcpWithRetryParams): Promise<StepResult> {
  const policy = resolveRetryPolicy(p.step as RequestStep);
  const max_attempts = (p.step.max_retries ?? 4) + 1;
  let finalAttempt = 0;
  let last: McpInvokeResult | null = null;

  for (let attempt = 0; attempt < max_attempts; attempt++) {
    finalAttempt = attempt;
    last = await p.attempt();
    if (last.ok || !isMcpAvailabilityFailure(last.failure)) break;
    if (attempt >= max_attempts - 1) break;
    const wait = backoffMs(attempt, policy.backoff_base_ms);
    logger.info({
      module: "execution",
      action: "request.retry",
      msg: `retrying mcp ${p.operation} in ${Math.round(wait)}ms`,
      reason: `mcp_${last.failure}`,
      attempt_no: attempt,
      total_attempts: max_attempts,
      delay_ms: Math.round(wait),
      next_attempt_at: new Date(Date.now() + wait).toISOString(),
      connector_id: p.connector_id,
    });
    recordRequestRetry({ connector_id: p.connector_id, reason: `mcp_${last.failure}` });
    await sleep(wait, p.signal);
  }

  // Unreachable while `max_attempts >= 1`, which the schema guarantees
  // (`max_retries` is min 0). Kept because the alternative is a non-null
  // assertion on a value the loop could in principle never set.
  if (!last) {
    return {
      status: "failed",
      retry_count: 0,
      duration_ms: Date.now() - p.start,
      error: { code: "mcp_error", message: "no attempt was made" },
    };
  }

  const request_meta = {
    driver: "mcp" as const,
    operation: p.operation,
    bytes_in: last.bytes,
    connector: p.connector,
    ...(last.tool_name !== undefined ? { tool_name: last.tool_name } : {}),
  };

  // What the step hands downstream — one shape per OPERATION, never one
  // shape per reply.
  //
  // A `tools/call` reply has two halves: `content` is what the tool wants
  // a reader to see, `structured_content` is what it promised conforms to
  // its declared `outputSchema` (the SDK validated it against that schema
  // before it got here, which is why it is worth keeping separate).
  // Handing back bare content when a tool declares no output schema would
  // make the step's output shape a property of the REMOTE: a server that
  // later adds an `outputSchema` would re-shape the output of a saved
  // workflow whose definition never changed, and `${scope.step[0].text}`
  // would resolve to nothing. So the envelope is unconditional and the
  // typed half is `null` when the tool sent none — adding a schema later
  // is then purely additive.
  //
  // `resources/read` and `prompts/get` return their payload verbatim: the
  // protocol gives neither a typed sibling, so a key that could never be
  // non-null would promise something the wire cannot deliver. Which of
  // the two shapes applies is decided by the `operation` the AUTHOR wrote
  // in the step — visible in the definition, and not something a remote
  // can change underneath it.
  const output =
    last.wire_method === MCP_WIRE_METHOD.call_tool
      ? { content: last.content, structured_content: last.structured_content ?? null }
      : last.content;

  if (last.ok) {
    return {
      status: "succeeded",
      output,
      retry_count: finalAttempt,
      duration_ms: Date.now() - p.start,
      request_meta,
    };
  }

  const detail = remoteErrorText(last.content);

  if ((p.step.error_policy ?? "none") === "all" && last.failure === "remote_error") {
    const warnings: StepWarning[] = [
      {
        code: "mcp_remote_error",
        message: `mcp ${p.operation} reported an error: ${detail}`,
      },
    ];
    logger.warn({
      module: "execution",
      action: "mcp.remote_error_accepted",
      connector_id: p.connector_id,
      operation: p.operation,
    });
    return {
      status: "succeeded",
      // The SAME shape the ok path returns. Whether the author tolerated
      // the remote's error must not decide what the output looks like —
      // that would put the shape back under the remote's control by
      // another route.
      output,
      retry_count: finalAttempt,
      duration_ms: Date.now() - p.start,
      request_meta,
      warnings,
    };
  }

  if (last.failure === "cancelled") {
    return {
      // Not "failed": the engine reads this status to decide the run's
      // own, and a stopped run reporting `failed` would put a
      // retry-on-failure operator to work on a remote that was fine.
      status: "aborted",
      retry_count: finalAttempt,
      duration_ms: Date.now() - p.start,
      request_meta,
      // No `output`: the pool's payload for an aborted call is its own
      // `{error}` note, and passing that off as the tool's content would
      // make the envelope claim the remote answered.
      error: {
        code: "mcp_cancelled",
        message: `mcp ${p.operation} was cancelled: the run was aborted`,
      },
    };
  }

  return {
    status: "failed",
    output,
    retry_count: finalAttempt,
    duration_ms: Date.now() - p.start,
    request_meta,
    error: {
      // Two codes, because the operator's next action differs:
      // `mcp_unavailable` is the server's problem and `mcp_remote_error`
      // is the call's. Collapsing them sends the author to re-read their
      // arguments while the remote is down.
      code: isMcpAvailabilityFailure(last.failure) ? "mcp_unavailable" : "mcp_remote_error",
      message: `mcp ${p.operation} failed: ${detail}`,
    },
  };
}

/** Best-effort human text out of whatever the remote returned. MCP content
 *  is a heterogeneous array of blocks; the pool's own failure payloads are
 *  `{error}` objects. Neither is guaranteed, so this never throws. */
function remoteErrorText(content: unknown): string {
  if (content === null || content === undefined) return "no detail";
  if (typeof content === "string") return content.slice(0, 500);
  if (Array.isArray(content)) {
    const texts = content
      .map((c) =>
        c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string"
          ? (c as { text: string }).text
          : null,
      )
      .filter((t): t is string => t !== null);
    if (texts.length > 0) return texts.join("; ").slice(0, 500);
  }
  if (typeof content === "object") {
    const err = (content as { error?: unknown }).error;
    if (typeof err === "string") return err.slice(0, 500);
  }
  try {
    return (JSON.stringify(content) ?? "no detail").slice(0, 500);
  } catch {
    return "no detail";
  }
}
