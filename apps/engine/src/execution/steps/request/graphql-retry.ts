import {
  graphqlErrorMessages,
  query as graphqlQuery,
} from "../../../connectors/drivers/graphql.ts";
import {
  classifyGraphqlSchemaError,
  isGraphqlRetryable,
} from "../../../connectors/drivers/graphql-retry-classify.ts";
import {
  AuthorityDispatchError,
  HttpRequestInvalidError,
} from "../../../connectors/drivers/http.ts";
import type { EgressInput } from "../../../connectors/egress.ts";
import { withEgressAudit } from "../../../connectors/egress.ts";
import { classifyConnectorHealth } from "../../../connectors/health.ts";
import { clearReauthIfProved } from "../../../connectors/reauth.ts";
import { logger } from "../../../logging/logger.ts";
import { recordRequestRetry } from "../../../observability/instrumentation.ts";
import { graphqlEndpointKey, recordSuccessShape } from "../../../schema-versions/service.ts";
import type { RequestStep } from "../../../workflows/types.ts";
import { GOVERNANCE_REFUSALS } from "../../state.ts";
import type { ConnectorResolutionSummary, StepResult, StepWarning } from "../../types.ts";
import { buildStepErrorDetail } from "../error-detail.ts";
import { RequestError } from "./errors.ts";
import { backoffMs, parseRetryAfter, requestMaxAttempts, resolveRetryPolicy } from "./retry.ts";

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

function retryReason(status: number, body: unknown): "graphql_throttle" | "graphql_5xx" {
  if (status === 429) return "graphql_throttle";
  const errors = (body as { errors?: unknown } | null | undefined)?.errors;
  if (Array.isArray(errors)) {
    for (const e of errors) {
      if (!e || typeof e !== "object") continue;
      const entry = e as Record<string, unknown>;
      const ext =
        entry.extensions && typeof entry.extensions === "object"
          ? (entry.extensions as Record<string, unknown>)
          : null;
      for (const field of [ext?.code, entry.errorType, ext?.classification]) {
        if (typeof field === "string") {
          const up = field.toUpperCase();
          if (
            up.includes("THROTTL") ||
            up.includes("RATE_LIMIT") ||
            up.includes("RATELIMIT") ||
            up.includes("TOO_MANY")
          ) {
            return "graphql_throttle";
          }
        }
      }
    }
  }
  return "graphql_5xx";
}

export interface RunGraphqlWithRetryParams {
  queryArgs: Parameters<typeof graphqlQuery>[0];
  egressInput: Omit<EgressInput, "credential_id">;
  step: Pick<RequestStep, "max_retries" | "retry_backoff_ms" | "error_policy">;
  signal: AbortSignal;
  start: number;
  connectorResolution: ConnectorResolutionSummary;
}

export async function runGraphqlWithRetry(p: RunGraphqlWithRetryParams): Promise<StepResult> {
  const { step, signal, start, egressInput } = p;
  const policy = resolveRetryPolicy(step as RequestStep);
  const max_attempts = requestMaxAttempts(step);
  let connRes = p.connectorResolution;
  let finalAttempt = 0;
  let lastRes: Awaited<ReturnType<typeof graphqlQuery>> | null = null;

  for (let attempt = 0; attempt < 10_000; attempt++) {
    finalAttempt = attempt;
    let raw: Awaited<ReturnType<typeof graphqlQuery>>;
    try {
      raw = await withEgressAudit(
        { ...egressInput, credential_id: null },
        () => graphqlQuery(p.queryArgs),
        (out) => {
          const gqlErrors = graphqlErrorMessages(out.body);
          return {
            status: out.status,
            bytes_in: out.bytes_in,
            ok: out.status >= 200 && out.status < 300 && gqlErrors === null,
            ...(gqlErrors
              ? { reason: `graphql response returned ${gqlErrors.length} error(s)` }
              : {}),
          };
        },
      );
    } catch (err) {
      if (
        err instanceof AuthorityDispatchError ||
        (err instanceof RequestError && err.cause_kind === "authority_invalid")
      ) {
        const reason =
          err instanceof AuthorityDispatchError
            ? "authority_redirect_denied"
            : err instanceof RequestError && typeof err.meta?.reason === "string"
              ? err.meta.reason
              : undefined;
        return {
          status: "failed",
          retry_count: attempt,
          duration_ms: Date.now() - start,
          error: buildStepErrorDetail({
            code: reason && GOVERNANCE_REFUSALS.has(reason) ? reason : "authority_invalid",
            err,
          }),
        };
      }
      if (err instanceof HttpRequestInvalidError) {
        return {
          status: "failed",
          retry_count: attempt,
          duration_ms: Date.now() - start,
          error: buildStepErrorDetail({ code: "request_invalid", err }),
        };
      }
      return {
        status: "failed",
        retry_count: attempt,
        duration_ms: Date.now() - start,
        error: buildStepErrorDetail({ code: "graphql_error", err }),
      };
    }

    connRes = { ...connRes, auth_method: raw.auth_method };
    lastRes = raw;

    if (isGraphqlRetryable(raw.status, raw.body) && attempt < max_attempts - 1) {
      const reason = retryReason(raw.status, raw.body);
      let wait: number;
      if (raw.status === 429) {
        const after = parseRetryAfter(
          (raw.headers as Record<string, string>)["retry-after"] ?? null,
        );
        wait = Math.min(after ?? backoffMs(attempt, policy.backoff_base_ms), 60 * 60_000);
      } else {
        wait = backoffMs(attempt, policy.backoff_base_ms);
      }
      logger.info({
        module: "execution",
        action: "request.retry",
        msg: `retrying after graphql ${raw.status} in ${Math.round(wait)}ms`,
        reason,
        attempt_no: attempt,
        total_attempts: max_attempts,
        delay_ms: Math.round(wait),
        next_attempt_at: new Date(Date.now() + wait).toISOString(),
        status: raw.status,
        connector_id: egressInput.connector_id,
      });
      recordRequestRetry({ connector_id: egressInput.connector_id, reason });
      await sleep(wait, signal);
      continue;
    }
    break;
  }

  if (!lastRes) {
    return {
      status: "failed",
      retry_count: 0,
      duration_ms: Date.now() - start,
      error: { code: "graphql_error", message: "no response received" },
    };
  }

  await clearReauthIfProved(p.queryArgs.db, p.queryArgs.connector, {
    status: lastRes.status,
    health: classifyConnectorHealth(lastRes.status, lastRes.headers),
    stored_credential_used: lastRes.stored_credential_used,
    body: lastRes.body,
  });

  const gqlErrors = graphqlErrorMessages(lastRes.body);
  const httpOk = lastRes.status >= 200 && lastRes.status < 300;
  const errorPolicy = step.error_policy ?? "none";

  const recordShape = async (value: unknown): Promise<void> => {
    if (!lastRes) return;
    try {
      await recordSuccessShape(
        {
          tenant_id: egressInput.tenant_id,
          connector_id: egressInput.connector_id,
          endpoint_key: graphqlEndpointKey(lastRes.operation_name),
          workflow_id: egressInput.workflow_id ?? null,
          step_id: egressInput.step_id ?? null,
          value,
        },
        p.queryArgs.db,
      );
    } catch {}
  };

  if (errorPolicy === "all" && gqlErrors !== null && httpOk) {
    const data = (lastRes.body as { data?: unknown }).data;
    if (data !== undefined) {
      const warnings: StepWarning[] = [
        {
          code: "graphql_partial_errors",
          message: `graphql response contained ${gqlErrors.length} error(s): ${gqlErrors
            .slice(0, 3)
            .join("; ")}`,
        },
      ];
      logger.warn({
        module: "execution",
        action: "graphql.partial_errors",
        connector_id: egressInput.connector_id,
        error_count: gqlErrors.length,
        status: lastRes.status,
      });
      await recordShape(data);
      return {
        status: "succeeded",
        output: data,
        retry_count: finalAttempt,
        duration_ms: Date.now() - start,
        request_meta: {
          driver: "graphql",
          method: "POST",
          status: lastRes.status,
          connector: connRes,
          operation_name: lastRes.operation_name,
          extras: { partial: true, graphql_errors: gqlErrors },
        },
        warnings,
      };
    }
  }

  const graphqlOk = httpOk && gqlErrors === null;
  if (graphqlOk) {
    await recordShape((lastRes.body as { data?: unknown }).data ?? null);
  }
  const schemaVerdict = graphqlOk
    ? null
    : gqlErrors
      ? classifyGraphqlSchemaError(lastRes.body)
      : null;
  return {
    status: graphqlOk ? "succeeded" : "failed",
    output: (lastRes.body as { data?: unknown }).data ?? null,
    retry_count: finalAttempt,
    duration_ms: Date.now() - start,
    request_meta: {
      driver: "graphql",
      method: "POST",
      status: lastRes.status,
      connector: connRes,
      operation_name: lastRes.operation_name,
    },
    ...(graphqlOk
      ? {}
      : {
          error: gqlErrors
            ? {
                code: "graphql_error",
                message: `graphql response returned errors: ${gqlErrors.slice(0, 3).join("; ")}`,
                ...(schemaVerdict?.schema_shaped
                  ? {
                      kind: "graphql_schema_error",
                      details: {
                        operation_name: lastRes.operation_name,
                        messages: gqlErrors,
                        root_field: schemaVerdict.root_field,
                      },
                    }
                  : {}),
              }
            : {
                code: `graphql_${lastRes.status}`,
                message: `graphql endpoint returned ${lastRes.status}`,
              },
        }),
  };
}
