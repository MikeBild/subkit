import type { McpInvokeResult } from "../../../connectors/drivers/mcp.ts";
import { logger } from "../../../logging/index.ts";
import { MCP_WIRE_METHOD } from "../../../mcp/client/remote-call.ts";
import { recordRequestRetry } from "../../../observability/instrumentation.ts";
import type { RequestStep } from "../../../workflows/types.ts";
import { type Clock, SYSTEM_CLOCK } from "../../clock.ts";
import type { ConnectorResolutionSummary, StepResult, StepWarning } from "../../types.ts";
import { RequestError } from "./errors.ts";
import { backoffMs, requestMaxAttempts, resolveRetryPolicy } from "./retry.ts";

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

function isMcpAvailabilityFailure(failure: McpInvokeResult["failure"]): boolean {
  return failure === "transport" || failure === "not_connected";
}

interface RunMcpWithRetryParams {
  attempt: () => Promise<McpInvokeResult>;
  step: Pick<RequestStep, "max_retries" | "retry_backoff_ms" | "error_policy">;
  signal: AbortSignal;
  start: number;
  clock?: Clock;
  connector: ConnectorResolutionSummary;
  operation: string;
  connector_id: string;
}

export async function runMcpWithRetry(p: RunMcpWithRetryParams): Promise<StepResult> {
  const clock = p.clock ?? SYSTEM_CLOCK;
  const policy = resolveRetryPolicy(p.step as RequestStep);
  const max_attempts = requestMaxAttempts(p.step);
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
      next_attempt_at: new Date(clock.now() + wait).toISOString(),
      connector_id: p.connector_id,
    });
    recordRequestRetry({ connector_id: p.connector_id, reason: `mcp_${last.failure}` });
    await sleep(wait, p.signal);
  }

  if (!last) {
    return {
      status: "failed",
      retry_count: 0,
      duration_ms: clock.now() - p.start,
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

  const output =
    last.wire_method === MCP_WIRE_METHOD.call_tool
      ? { content: last.content, structured_content: last.structured_content ?? null }
      : last.content;

  if (last.ok) {
    return {
      status: "succeeded",
      output,
      retry_count: finalAttempt,
      duration_ms: clock.now() - p.start,
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
      output,
      retry_count: finalAttempt,
      duration_ms: clock.now() - p.start,
      request_meta,
      warnings,
    };
  }

  if (last.failure === "cancelled") {
    return {
      status: "aborted",
      retry_count: finalAttempt,
      duration_ms: clock.now() - p.start,
      request_meta,
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
    duration_ms: clock.now() - p.start,
    request_meta,
    error: {
      code: isMcpAvailabilityFailure(last.failure) ? "mcp_unavailable" : "mcp_remote_error",
      message: `mcp ${p.operation} failed: ${detail}`,
    },
  };
}

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
