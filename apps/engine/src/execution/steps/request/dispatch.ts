import {
  inspectContentRevisionRequest,
  inspectContentRevisionResponse,
} from "../../../workflows/content-publication-boundary.ts";
import {
  GMAIL_SEND_TARGET,
  inspectReportMessage,
} from "../../../workflows/report-delivery-boundary.ts";
import {
  describeRequestBoundaryViolation,
  requestBoundary,
  requestBoundaryViolation,
} from "../../../workflows/request-boundary.ts";
// HTTP request step driver. Handles:
//   - retry policy (5 attempts max, 200ms base, 30s cap, +/- 20% jitter)
//   - 429 + Retry-After (cap 1h)
//   - timeouts via AbortController
//   - response filters
//   - pagination (offset / page / cursor) with 1000 page cap
//   - data selectors (applied by step-runner after the driver returns)
//
// Idempotency rule:
//   - GET / HEAD / OPTIONS: retry on 5xx + 429 + connection errors
//   - POST / PUT / PATCH / DELETE: retry only on 429 + connection errors

import { and, eq, sql } from "drizzle-orm";
import { auditAwait } from "../../../audit/audit.ts";
import { AuditAction } from "../../../audit/types.ts";
import { evaluateHook } from "../../../auth/hooks.ts";
import { filenameFromResponse } from "../../../connectors/drivers/file-promotion.ts";
import type { query as graphqlQuery } from "../../../connectors/drivers/graphql.ts";
import {
  AuthorityDispatchError,
  buildMultipartBody,
  buildRequestPlan,
  executePlannedHttpRequest,
  HttpRequestInvalidError,
  type RequestDispatchPolicy,
  type ResolvedConnectorCredential,
  serializeXmlBody,
} from "../../../connectors/drivers/http.ts";
import { invokeMcpConnectorCall } from "../../../connectors/drivers/mcp.ts";
import {
  pgQueryCursor,
  pgQueryWithCount,
  pgTransaction,
} from "../../../connectors/drivers/postgres.ts";
import {
  executeS3Request,
  S3CredentialError,
  type S3Method,
} from "../../../connectors/drivers/s3.ts";
import { extractCreatedResourceId, withEgressAudit } from "../../../connectors/egress.ts";
import { EgressBlockedError, RobotsDisallowedError } from "../../../connectors/egress-guard.ts";
import {
  classifyConnectorHealth,
  connectorHealthHint,
  parseDeprecation,
} from "../../../connectors/health.ts";
import {
  clearConnectorHealthOnSuccess,
  flagConnectorContractFailure,
} from "../../../connectors/health-state.ts";
import { clearConnectorReauth, flagConnectorAuthFailure } from "../../../connectors/reauth.ts";
import { getConnectorForEnvironment, isCircuitOpenBlocking } from "../../../connectors/service.ts";
import type { Db } from "../../../db/client.ts";
import { connectorEndpointSchemas, connectors } from "../../../db/schema/index.ts";
import type { ResolvedFile } from "../../../files/resolver.ts";
import { recordUsage } from "../../../llm/accounting/budget.ts";
import {
  estimateLlmCallTokens,
  isLlmProviderUrl,
  LlmBudgetExceededError,
  parseLlmUsage,
} from "../../../llm/accounting/index.ts";
import {
  type ResolvedAuthorityReference,
  resolvePlaceholders,
  resolvePlaceholdersTypePreserving,
  resolveStringPlaceholders,
} from "../../../llm/substitution/resolver.ts";
import { logger } from "../../../logging/logger.ts";
import { MCP_WIRE_METHOD, type RemoteCall } from "../../../mcp/client/remote-call.ts";
import { recordRequestRetry } from "../../../observability/instrumentation.ts";
import { getMetrics, METRIC_NAMES } from "../../../observability/metrics.ts";
import { recordSuccessShape } from "../../../schema-versions/service.ts";
import { authorityConnectorDigest } from "../../../workflows/authority-configuration.ts";
import type { RequestStep } from "../../../workflows/types.ts";
import { combineSignals } from "../../abort.ts";
import { type ExpectedRowCount, evaluateExpectedRowCount } from "../../expected-row-count.ts";
import { resolveScopeForJsonata } from "../../jsonata-bindings.ts";
import {
  MAX_PAGES,
  makeStrategy,
  PAGE_PROGRESS_INTERVAL,
  PAGINATION_CHECKPOINT_INTERVAL,
  type PaginationCheckpoint,
  type PaginationSpec,
  paginationSignature,
  readPaginationCheckpoint,
  writePaginationCheckpoint,
} from "../../pagination.ts";
import {
  type MaterializedRequest,
  preparedRequestProof,
  preparedRequestReview,
} from "../../prepared-request.ts";
import { applyResponseFilters, ResponseFilterFailError } from "../../response-filter.ts";
import type {
  ConnectorResolutionSummary,
  RequestMeta,
  StepResult,
  StepRunContext,
} from "../../types.ts";
import { buildStepErrorDetail } from "../error-detail.ts";
import {
  type ConnectorEvidence,
  evidenceFromStatus,
  evidenceFromThrow,
  graphqlEvidence,
  mcpEvidence,
} from "./circuit-evidence.ts";
import { RequestError } from "./errors.ts";
import { promoteResponseToFile } from "./file-output.ts";
import { runGraphqlWithRetry } from "./graphql-retry.ts";
import { runMcpWithRetry } from "./mcp-retry.ts";
import { isDocumentedReadOperation } from "./read-operations.ts";
import {
  backoffMs,
  isIdempotent,
  parseRetryAfter,
  type RetryPolicy,
  requestMaxAttempts,
  resolveRetryPolicy,
} from "./retry.ts";
import { checkRequired, deriveAuthMethodFromAuthType, extractModelHint } from "./shape.ts";
import {
  classifyRequestStepSideEffects,
  type HeldStepResultParams,
  heldStepResult,
  requestRequiresPreparationHold,
} from "./side-effects.ts";

export const REQUEST_TIMEOUT_DEFAULT_MS = 60 * 60_000; // 1h

/**
 * Best-effort re-auth clear on a successful authenticated request. Fire-and-
 * forget (the step result must not depend on it) but logs on failure so a
 * stuck `needs_reauth` flag is observable rather than silently swallowed.
 */
function clearReauthOnSuccess(db: Db, connector: { tenant_id: string; id: string }): void {
  void clearConnectorReauth(db, connector.tenant_id, connector.id).catch((err) => {
    logger.warn({
      module: "connectors",
      action: "connector.reauth.clear_failed",
      msg: "best-effort reauth clear on success failed",
      tenant_id: connector.tenant_id,
      connector_id: connector.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Persist a circuit-breaker state write. Drizzle builders are lazy — a bare
 * `void db.update(...)` never dispatches SQL — so every circuit write must be
 * awaited (or `.catch()`-chained) to take effect. The returned promise never
 * rejects: the step result must not depend on circuit bookkeeping, and on the
 * failure path a DB error here must not mask the original request error.
 */
async function persistCircuitState(
  db: Db,
  connector: { tenant_id: string; id: string },
  set: { circuit_state: "closed" | "half-open"; circuit_failure_count?: number },
): Promise<void> {
  try {
    await db.update(connectors).set(set).where(eq(connectors.id, connector.id));
    logger.info({
      module: "connectors",
      action: "connector.circuit.transition",
      tenant_id: connector.tenant_id,
      connector_id: connector.id,
      circuit_state: set.circuit_state,
    });
  } catch (err) {
    logger.warn({
      module: "connectors",
      action: "connector.circuit.update_failed",
      msg: "circuit-breaker state write failed",
      tenant_id: connector.tenant_id,
      connector_id: connector.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Record a request failure against the connector's circuit breaker in ONE
 * atomic statement: the increment reads the column (not a stale snapshot, so
 * concurrent failures cannot lose updates) and the same UPDATE flips the
 * circuit open when the new count reaches the threshold. Logs exactly once on
 * the open transition. Never rejects (see persistCircuitState).
 */
async function recordCircuitFailure(
  db: Db,
  connector: { tenant_id: string; id: string },
): Promise<void> {
  try {
    const rows = await db
      .update(connectors)
      .set({
        circuit_failure_count: sql`${connectors.circuit_failure_count} + 1`,
        circuit_opened_at: sql`CASE WHEN ${connectors.circuit_failure_count} + 1 >= ${connectors.circuit_threshold} AND ${connectors.circuit_state} <> 'open' THEN now() ELSE ${connectors.circuit_opened_at} END`,
        circuit_state: sql`CASE WHEN ${connectors.circuit_failure_count} + 1 >= ${connectors.circuit_threshold} THEN 'open' ELSE ${connectors.circuit_state} END`,
      })
      .where(eq(connectors.id, connector.id))
      .returning({
        circuit_state: connectors.circuit_state,
        circuit_failure_count: connectors.circuit_failure_count,
        circuit_threshold: connectors.circuit_threshold,
      });
    const row = rows[0];
    if (row?.circuit_state === "open" && row.circuit_failure_count === row.circuit_threshold) {
      logger.warn({
        module: "connectors",
        action: "connector.circuit.opened",
        msg: "connector circuit breaker opened — requests blocked until reset",
        tenant_id: connector.tenant_id,
        connector_id: connector.id,
        circuit_failure_count: row.circuit_failure_count,
        circuit_threshold: row.circuit_threshold,
      });
    }
  } catch (err) {
    logger.warn({
      module: "connectors",
      action: "connector.circuit.update_failed",
      msg: "circuit-breaker failure write failed",
      tenant_id: connector.tenant_id,
      connector_id: connector.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The ONE circuit-breaker recorder for the drivers that return their outcome
 * from inside their own branch (graphql / s3 / postgres / mcp).
 *
 * The HTTP path records failures from the outer handler, which is only
 * reached after its retry loop has already given up — so "we tried and the
 * remote could not serve us" is implied by getting there at all. These
 * branches have no such loop, so each must say what it observed; the
 * vocabulary and the classification live in `circuit-evidence.ts` so two
 * drivers cannot disagree about what "healthy" means.
 *
 * Counting a caller's own mistake would open the breaker on the author's typo
 * and take a working connector offline for the whole reset window; crediting
 * reachability we never observed would close a breaker on no evidence. Both
 * are the `none` verdict, which does neither.
 */
async function recordDriverOutcome(
  db: Db,
  connector: {
    tenant_id: string;
    id: string;
    circuit_state: string;
    circuit_failure_count: number;
  },
  evidence: ConnectorEvidence,
): Promise<void> {
  if (evidence === "unavailable") {
    await recordCircuitFailure(db, connector);
    return;
  }
  if (evidence === "none") return;
  // `answered`: the remote is serving, so a half-open breaker closes and a
  // partial failure count is cleared — the same reset the HTTP success path
  // performs.
  if (connector.circuit_state !== "half-open" && connector.circuit_failure_count === 0) return;
  await persistCircuitState(db, connector, { circuit_state: "closed", circuit_failure_count: 0 });
}

interface FetchAttemptResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  bytes_in: number;
  /** Raw bytes of a 2xx body the driver flagged for file promotion
   *  (`capture_binary` call-site contract). When set, `body` is
   *  undefined — the success path persists the bytes as an
   *  engine-managed workflow-run output file. */
  body_raw?: Buffer;
}

async function fetchOnce(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  tenant_id: string,
  multipartBody?: FormData,
  captureBinary?: boolean,
  beforeDispatch?: (request: MaterializedRequest) => Promise<RequestDispatchPolicy | undefined>,
): Promise<FetchAttemptResult> {
  // Pagination cursors and `${item.…}` resolution sometimes produce a
  // URL the placeholder validator missed. Without a typed guard,
  // `new URL(url)` throws a generic TypeError that the retry loop
  // misclassifies as a transient `connection` error and retries 5×.
  // Throw `HttpRequestInvalidError` instead so the caller short-circuits
  // to `RequestError("…", "request_invalid")`. (Audit anti-pattern E2.)
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch (err) {
    throw new HttpRequestInvalidError(
      `invalid request URL: ${err instanceof Error ? err.message : String(err)}`,
      "url",
    );
  }
  const execution = await executePlannedHttpRequest({
    tenant_id,
    method,
    url: parsedUrl,
    headers,
    body,
    signal,
    ...(multipartBody !== undefined ? { multipartBody } : {}),
    ...(captureBinary ? { capture_binary: true } : {}),
    ...(beforeDispatch ? { before_dispatch: beforeDispatch } : {}),
  });
  return {
    status: execution.status,
    headers: execution.headers,
    body: execution.body,
    bytes_in: execution.bytes_in,
    ...(execution.body_raw !== undefined ? { body_raw: execution.body_raw } : {}),
  };
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new RequestError("aborted", "abort"));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new RequestError("aborted", "abort"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

interface DoOnePageParams {
  before_dispatch?: (request: MaterializedRequest) => Promise<RequestDispatchPolicy | undefined>;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  /** Pre-built multipart FormData. When set, overrides `body`. */
  multipartBody?: FormData;
  max_attempts: number;
  signal: AbortSignal;
  retry_total_ms: { value: number };
  retry_counter: { value: number };
  tenant_id: string;
  connector_id?: string | null;
  /** Names the connector in failure hints ("Connector 'jira' returned 410…"). */
  connector_slug?: string | null;
  retry_policy: RetryPolicy;
  /** Allows safe retries for semantically read-only POST search endpoints. */
  retry_safe: boolean;
  /** Explicit workflow contract statuses. Non-2xx responses listed here are
   *  returned to the step instead of being converted into RequestError before
   *  the request-level expected_statuses gate can inspect them. */
  accepted_statuses?: ReadonlySet<number>;
  /** Stable key for one logical request/page, reused on every retry. */
  idempotency_key_base?: string;
  /** Out-param: the most recent Idempotency-Key emitted by this call. The
   *  request step copies the value into `request_meta.idempotency_key` for
   *  audit. Stays null when no key was emitted (GET / HEAD / OPTIONS). */
  last_idempotency_key?: { value: string | null };
  /** Workflow request-step contract: binary 2xx bodies come back as
   *  `body_raw` for file promotion. Never set on the paginated path —
   *  pages accumulate parsed JSON arrays; a binary page is nonsensical. */
  capture_binary?: boolean;
}

/**
 * Build the `health_hint` meta attached to a failing RequestError so
 * `buildStepErrorDetail` can surface actionable guidance on `step.failed`
 * instead of a bare `http 410`/`http 404`. Returns undefined when the
 * verdict carries no hint (plain inspectable 4xx like 409/422).
 */
function healthHintMeta(
  status: number,
  headers: Record<string, string>,
  opts: {
    slug?: string | null | undefined;
    url?: string | undefined;
    retry_after_s?: number | null | undefined;
  },
): Record<string, unknown> | undefined {
  const health = classifyConnectorHealth(status, headers);
  if (health === "ok" || health === "deprecated") return undefined;
  let path: string | null = null;
  if (opts.url) {
    try {
      path = new URL(opts.url).pathname;
    } catch {
      path = null;
    }
  }
  const deprecation = parseDeprecation(headers);
  const hint = connectorHealthHint(health, opts.slug ?? "this connector", {
    path,
    deprecation,
    retry_after_s: opts.retry_after_s ?? null,
  });
  if (!hint) return undefined;
  return {
    health,
    error_code: hint.error_code,
    suggestion: hint.suggestion,
    next_best_actions: hint.next_best_actions,
    // Parsed Deprecation/Sunset/Link signal — the 410 rollup reads the
    // vendor-announced successor URI from here.
    ...(deprecation ? { deprecation } : {}),
  };
}

/**
 * Classify a non-`RequestError` thrown by the fetch transport into the
 * retry taxonomy. Pure + exported so the timeout-is-terminal contract is
 * unit-testable without a live socket.
 *
 *   - "abort"      — the caller's signal aborted (cancellation). Terminal.
 *   - "timeout"    — a per-request timeout: `AbortSignal.timeout` raises a
 *                    DOMException `TimeoutError` ("The operation timed
 *                    out."); an `AbortError` whose source is NOT the
 *                    caller's signal is also a per-request timeout. The
 *                    attempt already spent the entire budget, so this is
 *                    terminal for ALL methods. Pre-fix (2026-06-21 Gmail
 *                    send outage) the `TimeoutError` shape leaked into
 *                    "connection" and was retried "regardless of method" —
 *                    a Gmail `POST /messages/send` that stalled for the
 *                    300s budget retried 5× (~23 min) and risked double-
 *                    sending the email.
 *   - "connection" — a transient transport error; retryable per policy.
 */
export function classifyTransportError(
  err: unknown,
  signalAborted: boolean,
): "abort" | "timeout" | "connection" {
  if (signalAborted) return "abort";
  const e = err as { name?: string; message?: string; cause?: { name?: string } };
  if (
    e.name === "AbortError" ||
    e.cause?.name === "AbortError" ||
    /aborted|abort/i.test(e.message ?? "")
  ) {
    return "timeout";
  }
  if (
    e.name === "TimeoutError" ||
    e.cause?.name === "TimeoutError" ||
    /timed out|timeout/i.test(e.message ?? "")
  ) {
    return "timeout";
  }
  return "connection";
}

async function doOnePage(p: DoOnePageParams): Promise<FetchAttemptResult> {
  let attempt = 0;
  let lastErr: unknown = null;
  while (attempt < p.max_attempts) {
    attempt += 1;
    if (attempt > 1) p.retry_counter.value += 1;
    if (p.signal.aborted) {
      throw new RequestError("aborted", "abort");
    }
    // Retries must reuse the same key: changing it asks the remote to apply
    // another effect, defeating any upstream idempotency support.
    const attemptHeaders: Record<string, string> = { ...p.headers };
    if (p.idempotency_key_base && !isIdempotent(p.method)) {
      const key = p.idempotency_key_base;
      attemptHeaders["Idempotency-Key"] = key;
      if (p.last_idempotency_key) p.last_idempotency_key.value = key;
    }
    try {
      const res = await fetchOnce(
        p.url,
        p.method,
        attemptHeaders,
        p.body,
        p.signal,
        p.tenant_id,
        p.multipartBody,
        p.capture_binary,
        p.before_dispatch,
      );
      if (res.status >= 400 && p.accepted_statuses?.has(res.status)) {
        return res;
      }
      if (res.status >= 200 && res.status < 400) {
        // A 2xx/3xx can still be an *unauthenticated* response when the
        // upstream serves auth failures as 200 (Atlassian Seraph emits
        // `X-Seraph-LoginReason: AUTHENTICATED_FAILED` with an empty body).
        // Without this, a dead credential sails through as success and the
        // downstream transform runs on an empty result set — exactly how a
        // broken Jira connector returned "0 issues" instead of failing.
        // Raise it as a 4xx so the step fails and the circuit breaker counts
        // it (non-retryable, same path as a real 401).
        if (classifyConnectorHealth(res.status, res.headers) === "auth_failed") {
          throw new RequestError(
            "upstream served an unauthenticated response (auth failed)",
            "http_4xx",
            401,
            { body: res.body },
          );
        }
        return res;
      }
      const is_additional_retry_status = p.retry_policy.additional_retry_statuses.has(res.status);
      // Uniform retry telemetry: every retry emits the
      // same shape — `attempt_no`, `total_attempts`, `delay_ms`,
      // `next_attempt_at`, plus the typed `reason`. Lets an
      // operator grep `action: "request.retry"` and reconstruct
      // the entire backoff timeline without parsing free-form
      // messages.
      if (res.status === 429) {
        const after = parseRetryAfter(res.headers["retry-after"] ?? null);
        const wait = Math.min(
          after ?? backoffMs(attempt, p.retry_policy.backoff_base_ms),
          60 * 60_000,
        );
        if (attempt >= p.max_attempts) {
          throw new RequestError(`http 429`, "http_429", 429, {
            headers: res.headers,
            health_hint: healthHintMeta(429, res.headers, {
              slug: p.connector_slug,
              url: p.url,
              retry_after_s: after != null ? Math.round(after / 1000) : null,
            }),
          });
        }
        logger.info({
          module: "execution",
          action: "request.retry",
          msg: `retrying after http 429 in ${Math.round(wait)}ms`,
          reason: "http_429",
          attempt_no: attempt,
          total_attempts: p.max_attempts,
          delay_ms: Math.round(wait),
          next_attempt_at: new Date(Date.now() + wait).toISOString(),
          status: res.status,
          retry_after_header: after ?? null,
          connector_id: p.connector_id ?? null,
        });
        recordRequestRetry({ connector_id: p.connector_id ?? null, reason: "http_429" });
        p.retry_total_ms.value += wait;
        await sleep(wait, p.signal);
        continue;
      }
      if (res.status >= 500) {
        if (!p.retry_safe && !isIdempotent(p.method) && !is_additional_retry_status) {
          throw new RequestError(`http ${res.status}`, "http_5xx", res.status, {
            health_hint: healthHintMeta(res.status, res.headers, {
              slug: p.connector_slug,
              url: p.url,
            }),
          });
        }
        if (attempt >= p.max_attempts) {
          throw new RequestError(`http ${res.status}`, "http_5xx", res.status, {
            health_hint: healthHintMeta(res.status, res.headers, {
              slug: p.connector_slug,
              url: p.url,
            }),
          });
        }
        const wait = backoffMs(attempt, p.retry_policy.backoff_base_ms);
        logger.info({
          module: "execution",
          action: "request.retry",
          msg: `retrying after http ${res.status} in ${Math.round(wait)}ms`,
          reason: "http_5xx",
          attempt_no: attempt,
          total_attempts: p.max_attempts,
          delay_ms: Math.round(wait),
          next_attempt_at: new Date(Date.now() + wait).toISOString(),
          status: res.status,
          connector_id: p.connector_id ?? null,
        });
        recordRequestRetry({ connector_id: p.connector_id ?? null, reason: "http_5xx" });
        await sleep(wait, p.signal);
        continue;
      }
      // 4xx (non-429): retryable only if explicitly opted in via retry_on_status.
      if (is_additional_retry_status) {
        if (attempt >= p.max_attempts) {
          throw new RequestError(`http ${res.status}`, "http_4xx", res.status, {
            body: res.body,
            health_hint: healthHintMeta(res.status, res.headers, {
              slug: p.connector_slug,
              url: p.url,
            }),
          });
        }
        const wait = backoffMs(attempt, p.retry_policy.backoff_base_ms);
        logger.info({
          module: "execution",
          action: "request.retry",
          msg: `retrying opted-in status http ${res.status} in ${Math.round(wait)}ms`,
          reason: "http_4xx_opt_in",
          attempt_no: attempt,
          total_attempts: p.max_attempts,
          delay_ms: Math.round(wait),
          next_attempt_at: new Date(Date.now() + wait).toISOString(),
          status: res.status,
          connector_id: p.connector_id ?? null,
        });
        recordRequestRetry({ connector_id: p.connector_id ?? null, reason: "http_4xx_opt_in" });
        await sleep(wait, p.signal);
        continue;
      }
      throw new RequestError(`http ${res.status}`, "http_4xx", res.status, {
        body: res.body,
        health_hint: healthHintMeta(res.status, res.headers, {
          slug: p.connector_slug,
          url: p.url,
        }),
      });
    } catch (err) {
      lastErr = err;
      if (err instanceof AuthorityDispatchError)
        throw new RequestError(err.message, "authority_invalid");
      if (err instanceof HttpRequestInvalidError) {
        throw new RequestError(err.message, "request_invalid", undefined, {
          path: err.path,
        });
      }
      if (err instanceof RequestError) {
        if (err.cause_kind === "http_4xx") throw err;
        // Allowed HTTP retries continue in the response branch above. A thrown
        // 5xx is terminal; catching it must not retry a non-idempotent write.
        if (err.cause_kind === "http_5xx") throw err;
        if (err.cause_kind === "abort") throw err;
        if (err.cause_kind === "filter_fail") throw err;
        if (err.cause_kind === "request_invalid") throw err;
        if (err.cause_kind === "authority_invalid") throw err;
        // A per-request timeout is terminal — it already consumed the
        // full budget; retrying would re-send a non-idempotent write.
        if (err.cause_kind === "timeout") throw err;
        if (attempt >= p.max_attempts) throw err;
        continue;
      }
      const e = err as { message?: string };
      const klass = classifyTransportError(err, p.signal.aborted);
      if (klass === "abort") throw new RequestError("aborted", "abort");
      if (klass === "timeout") {
        // A per-request timeout already spent the entire budget — it is
        // terminal for ALL methods (no retry, no non-idempotent re-send).
        // See classifyTransportError for the full root-cause note.
        throw new RequestError(e.message ?? "operation timed out", "timeout");
      }
      // connection error: retry regardless of method
      if (attempt >= p.max_attempts) {
        throw new RequestError(e.message ?? "connection error", "connection");
      }
      const wait = backoffMs(attempt, p.retry_policy.backoff_base_ms);
      logger.info({
        module: "execution",
        action: "request.retry",
        msg: `retrying after connection error in ${Math.round(wait)}ms`,
        reason: "connection_error",
        attempt_no: attempt,
        total_attempts: p.max_attempts,
        delay_ms: Math.round(wait),
        next_attempt_at: new Date(Date.now() + wait).toISOString(),
        error_message: e.message ?? null,
        connector_id: p.connector_id ?? null,
      });
      recordRequestRetry({ connector_id: p.connector_id ?? null, reason: "connection" });
      await sleep(wait, p.signal);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("request failed");
}

export interface ResolvedMultipartPart {
  name: string;
  file?: ResolvedFile;
  value?: string;
  filename?: string;
  content_type?: string;
}

function materializePaginatedBody(
  baseBody: unknown,
  parameters?: Record<string, string | number>,
): unknown {
  if (!parameters) return baseBody;
  if (baseBody === undefined || baseBody === null) return { ...parameters };
  if (typeof baseBody === "object" && !Array.isArray(baseBody)) {
    return { ...(baseBody as Record<string, unknown>), ...parameters };
  }
  throw new RequestError(
    "body pagination requires a JSON object body or no body",
    "request_invalid",
  );
}

export interface RunRequestStepParams {
  ctx: StepRunContext;
  step: RequestStep;
  scope: Record<string, unknown>;
  /** Pre-resolved multipart parts from the step-runner's walkAndResolve pass.
   *  When present the HTTP driver builds a FormData body from these instead
   *  of the JSON body path. */
  resolved_multipart?: ResolvedMultipartPart[];
  /** Pre-resolved body from the step-runner when step.body contained a
   *  $file reference. When present, the driver streams this file as the
   *  request body instead of JSON-encoding the body field. */
  resolved_body_file?: ResolvedFile;
}

export async function runRequestStep(p: RunRequestStepParams): Promise<StepResult> {
  const start = Date.now();
  const referencedAuthorities: ResolvedAuthorityReference[] = [
    ...(p.ctx.prepared_workflow_references ?? []),
  ];
  let configurationDigest = authorityConnectorDigest(null);
  let credentialSnapshot: Pick<
    ResolvedConnectorCredential,
    "credential_id" | "credential_revision" | "connection_authority"
  > = {
    credential_id: null,
    credential_revision: null,
    connection_authority: null,
  };
  const authoritySnapshot = (credential = credentialSnapshot) => ({
    ...(referencedAuthorities.length ? { referenced_authorities: referencedAuthorities } : {}),
    step_id: p.step.id,
    step_row_id: p.ctx.step_row_id,
    connector_id: p.step.connector_id ?? null,
    requires_review: requestRequiresPreparationHold(p.step, activeConnector?.driver),
    request_max_attempts: max_attempts,
    principal_id: p.ctx.principal?.id ?? null,
    configuration_digest: configurationDigest,
    credential_id: credential.credential_id,
    credential_revision: credential.credential_revision,
    connection_authority: credential.connection_authority ?? null,
  });
  const beforeDispatch = async (credential = credentialSnapshot, request?: MaterializedRequest) => {
    try {
      const documentedRead = p.step.side_effects !== "write" && isDocumentedReadOperation(request);
      const policy = await p.ctx.before_external_request?.({
        ...authoritySnapshot(credential),
        ...(documentedRead ? { requires_review: false } : {}),
        ...(request ? { request } : {}),
      });
      return documentedRead ? { redirect: "manual" as const } : policy;
    } catch (error) {
      throw new RequestError(
        `Execution authority could not be verified: ${(error as { code?: string }).code ?? "authority_check_failed"}; review the current boundary.`,
        "authority_invalid",
        undefined,
        { reason: (error as { code?: string }).code ?? "authority_check_failed" },
      );
    }
  };
  let lastMaterializedHttpRequest: MaterializedRequest | undefined;
  const beforeHttpDispatch = async (request: MaterializedRequest) => {
    if (
      p.ctx.hold_writes &&
      requestRequiresPreparationHold(p.step, activeConnector?.driver) &&
      (p.step.side_effects === "write" || !isDocumentedReadOperation(request))
    ) {
      throw new RequestError(
        "Preview request is no longer a supported read operation",
        "authority_invalid",
      );
    }
    const key = request.headers["Idempotency-Key"];
    const suffix =
      idempotencyBase && key?.startsWith(`${idempotencyBase}:`)
        ? key.slice(idempotencyBase.length + 1)
        : null;
    const policy = await beforeDispatch(credentialSnapshot, {
      ...request,
      ...(key !== undefined && suffix !== null && /^(0|[1-9][0-9]*)$/.test(suffix)
        ? { generated_idempotency: { key, page: Number(suffix) } }
        : {}),
    });
    // Keep the actual checked request in memory only. Revision provenance below
    // records just resource identities, never headers, credentials or content.
    lastMaterializedHttpRequest = request;
    return policy;
  };
  const heldHttpResult = (held: HeldStepResultParams) => {
    const proof = held.url
      ? preparedRequestProof(
          p.ctx.tenant_id,
          authoritySnapshot(),
          {
            method: held.method,
            url: held.url,
            headers: {
              ...held.headers,
              ...(idempotencyBase ? { "Idempotency-Key": `${idempotencyBase}:0` } : {}),
            },
            body: held.body,
            ...(idempotencyBase
              ? { generated_idempotency: { key: `${idempotencyBase}:0`, page: 0 } }
              : {}),
            ...(p.resolved_multipart || p.resolved_body_file ? { unsupported_body: true } : {}),
          },
          max_attempts,
        )
      : null;
    const review =
      proof && held.url
        ? preparedRequestReview({
            method: held.method,
            url: held.url,
            headers: held.headers ?? {},
            body: held.body,
          })
        : null;
    const metadata = held.request_meta ?? {
      driver: "connectorless" as const,
      method: held.method,
      url: held.url,
    };
    const report =
      held.method === "POST" && held.url === GMAIL_SEND_TARGET
        ? inspectReportMessage(held.body)
        : null;
    const contentRevision =
      held.url && !p.resolved_multipart && !p.resolved_body_file
        ? inspectContentRevisionRequest({
            method: held.method,
            url: held.url,
            headers: held.headers ?? {},
            body: held.body,
          })
        : null;
    return heldStepResult({
      ...held,
      request_meta: {
        ...metadata,
        extras: {
          ...held.request_meta?.extras,
          ...(proof ? { prepared_request_proof: proof } : {}),
          ...(review ? { prepared_request_review: review } : {}),
          ...(report ? { report_delivery_proposal: report.boundary } : {}),
          ...(contentRevision ? { content_revision_proposal: contentRevision } : {}),
        },
      },
    });
  };
  // Hold-writes preview (Fix G): when the run was started with
  // `hold_writes`, a write or unknown-effect step is fully RESOLVED (every
  // driver branch holds AFTER placeholder substitution, credential /
  // plan construction and policy hooks — i.e. immediately before its
  // network call) and returned as a `held` outcome instead of being
  // dispatched. Read-classified steps execute live, unchanged.
  const requestIsReadOnly = classifyRequestStepSideEffects(p.step) === "read";
  let holdThisStep = p.ctx.hold_writes === true && requestRequiresPreparationHold(p.step);
  const max_attempts = requestMaxAttempts(p.step);
  const timeoutMs = p.step.timeout_ms ?? REQUEST_TIMEOUT_DEFAULT_MS;
  const timeoutCtrl = new AbortController();

  // A request step is a downstream consumer of the scope via
  // `${scope.<step>.…}` placeholder substitution. When an upstream loop
  // spilled large body payloads to storage, the loop key in `scope`
  // holds `OffloadRef` placeholders — re-hydrate them so a token like
  // `${scope.prior_loop.data}` substitutes the real payload. The helper
  // returns the same object when nothing was offloaded.
  //
  // This runs BEFORE the timeout timer is armed: rehydration is a
  // DB/S3 fetch that is step *setup*, not part of the HTTP call. Arming
  // the timer first would burn the request's `timeout_ms` budget on the
  // rehydrate fetch before the HTTP call even starts.
  const resolvedScope = await resolveScopeForJsonata(
    p.ctx.db,
    p.ctx.tenant_id,
    p.scope,
    p.ctx.signal,
  );

  const timer = setTimeout(() => timeoutCtrl.abort("timeout"), timeoutMs);
  const signal = combineSignals([p.ctx.signal, timeoutCtrl.signal]);

  // Substitute `${item.…}`, `${scope.<step>.…}`, `${input.…}`,
  // `${cred.…}`, `${connector.…}` against the live execution scope BEFORE
  // the HTTP driver builds the request. Without this, a literal token like
  // `${item.id}` flows into `new URL()` and ends up URL-encoded as
  // `%24%7Bitem.id%7D`, causing the API to 404 on a non-existent id.
  const resolverCtx = {
    onAuthorityReference: (reference: ResolvedAuthorityReference) => {
      if (
        !referencedAuthorities.some(
          (existing) =>
            existing.connector_id === reference.connector_id &&
            existing.configuration_digest === reference.configuration_digest &&
            existing.credential_id === reference.credential_id &&
            existing.credential_revision === reference.credential_revision,
        )
      )
        referencedAuthorities.push(reference);
    },
    tenant_id: p.ctx.tenant_id,
    environment: p.ctx.execution_mode,
    db: p.ctx.db,
    input: resolvedScope?.$input,
    scope: resolvedScope,
    ...(p.ctx.principal ? { principal: p.ctx.principal } : {}),
  };
  const pathRes = p.step.path ? await resolveStringPlaceholders(p.step.path, resolverCtx) : null;
  const urlRes = p.step.url ? await resolveStringPlaceholders(p.step.url, resolverCtx) : null;
  const headersRes = p.step.headers ? await resolvePlaceholders(p.step.headers, resolverCtx) : null;
  const queryRes = p.step.query ? await resolvePlaceholders(p.step.query, resolverCtx) : null;
  // The HTTP request body must preserve native JSON types, exactly like
  // the GraphQL variables path below: a whole-value `"${ref}"` leaf carries
  // the native array/object/number it resolves to, while a mixed string
  // still stringifies. Pre-fix the shared string-coercing
  // `resolvePlaceholders` walker stringified every leaf, so a nested
  // `{children:"${blocks}"}` was JSON.stringify'd here AND again by the
  // HTTP driver — Notion (and every other typed-body API) received
  // `{"children":"[…]"}` (a string) and rejected it with `should be an
  // array`. Type-preserving resolution brings the body to parity with the
  // GraphQL variables resolution.
  const bodyRes =
    p.step.body !== undefined && p.step.body !== null
      ? await resolvePlaceholdersTypePreserving(p.step.body, resolverCtx)
      : null;
  // Fail-fast when path/url has unresolved tokens — otherwise the literal
  // `${…}` reaches the wire and the operator sees an opaque 404.
  const pathUrlUnresolved = [...(pathRes?.unresolved ?? []), ...(urlRes?.unresolved ?? [])];
  if (pathUrlUnresolved.length > 0) {
    clearTimeout(timer);
    const tokens = pathUrlUnresolved.map((u) => u.token).join(", ");
    return {
      status: "failed",
      retry_count: 0,
      duration_ms: Date.now() - start,
      error: {
        code: "placeholder_unresolved",
        message: `unresolved placeholder(s) in path/url: ${tokens}`,
        details: { unresolved: pathUrlUnresolved },
      },
      request_meta: {
        driver: "error",
        url: null,
        method: p.step.method,
        unresolved_placeholders: pathUrlUnresolved.map((u) => u.token),
        // No digest yet — placeholder failure happens before headers
        // are built; consumers fall back to the unresolved list.
      },
    };
  }
  const resolvedStepPath = pathRes?.value ?? p.step.path ?? null;
  const resolvedStepUrl = urlRes?.value ?? p.step.url ?? null;
  const resolvedStepHeaders =
    (headersRes?.value as Record<string, string> | undefined) ?? p.step.headers ?? {};
  const resolvedStepQuery =
    (queryRes?.value as Record<string, string | number | boolean> | undefined) ??
    p.step.query ??
    {};
  // Resolve placeholders inside the structured s3 / sql blocks alongside
  // the HTTP fields so dispatch downstream can use the resolved values
  // verbatim.
  const s3KeyRes = p.step.s3?.key
    ? await resolveStringPlaceholders(p.step.s3.key, resolverCtx)
    : null;
  const s3PrefixRes = p.step.s3?.prefix
    ? await resolveStringPlaceholders(p.step.s3.prefix, resolverCtx)
    : null;
  const resolvedS3Key = s3KeyRes?.value ?? p.step.s3?.key;
  const resolvedS3Prefix = s3PrefixRes?.value ?? p.step.s3?.prefix;
  // SQL params: only string entries get placeholder resolution; other
  // values pass through untouched.
  let resolvedSqlParams: unknown[] | undefined;
  if (p.step.sql && Array.isArray(p.step.sql.params)) {
    resolvedSqlParams = [];
    for (const raw of p.step.sql.params) {
      if (typeof raw === "string") {
        const r = await resolveStringPlaceholders(raw, resolverCtx);
        resolvedSqlParams.push(r.value);
      } else {
        resolvedSqlParams.push(raw);
      }
    }
  }
  // MCP block. The target (tool name / resource URI / prompt name) is a
  // string; the arguments map goes through the TYPE-PRESERVING resolver
  // for the same reason `graphql.variables` does — a remote tool's input
  // schema declares `limit: number`, and a stringified `"7"` is rejected
  // by the SDK's own schema validation before the call leaves the process.
  const mcpTarget =
    p.step.mcp?.operation === "read_resource"
      ? p.step.mcp.uri
      : p.step.mcp?.operation === "get_prompt"
        ? p.step.mcp.prompt
        : p.step.mcp?.tool;
  const mcpTargetRes = mcpTarget ? await resolveStringPlaceholders(mcpTarget, resolverCtx) : null;
  const mcpArgsRes =
    p.step.mcp?.arguments !== undefined
      ? await resolvePlaceholdersTypePreserving(p.step.mcp.arguments, resolverCtx)
      : null;
  let resolvedStepBody = bodyRes ? bodyRes.value : p.step.body;
  // Symmetric XML request body. When `xml: { body, declaration? }` is
  // set, serialise via the same tree conventions the response parser
  // produces and stamp `Content-Type: application/xml` unless the
  // operator already set one. Resolved placeholders inside the tree
  // come from the standard body resolution above when `step.body` was
  // ALSO set; the `xml` block is a separate slot, so we resolve it
  // here independently.
  let xmlContentTypeSet = false;
  if (p.step.xml !== undefined) {
    const xmlBodyRes = await resolvePlaceholders(p.step.xml.body, resolverCtx);
    const tree = (xmlBodyRes?.value as unknown) ?? p.step.xml.body;
    let xmlText = serializeXmlBody(tree);
    if (p.step.xml.declaration) {
      xmlText = `<?xml version="1.0" encoding="UTF-8"?>${xmlText}`;
    }
    resolvedStepBody = xmlText;
    xmlContentTypeSet = true;
  }

  // Compose headers/query/URL — connector-scoped steps route through the
  // HTTP driver so credentials get decrypted + applied once up front,
  // then the P3 retry loop runs on the resulting URL.
  const headers: Record<string, string> = { ...resolvedStepHeaders };
  if (xmlContentTypeSet) {
    const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === "content-type");
    if (!hasContentType) headers["Content-Type"] = "application/xml";
  }
  const query: Record<string, string | number | boolean> = { ...resolvedStepQuery };
  let baseUrl: URL;
  // Holds the resolved HTTP connector so circuit state can be updated on
  // success / failure in the outer try/catch block.
  let activeConnector: Awaited<ReturnType<typeof getConnectorForEnvironment>> = null;
  // Credential row id from the resolved HTTP plan, threaded into the
  // egress audit so the trail names which secret was used.
  let activeCredentialId: string | null = null;
  let connectorResolution: ConnectorResolutionSummary | null = null;
  try {
    if (p.step.connector_id) {
      const connector = await getConnectorForEnvironment(
        p.ctx.tenant_id,
        p.step.connector_id,
        p.ctx.execution_mode,
        p.ctx.db,
      );
      if (!connector) {
        clearTimeout(timer);
        return {
          status: "failed",
          retry_count: 0,
          duration_ms: Date.now() - start,
          error: {
            code: "connector_not_found",
            message: `connector ${p.step.connector_id} not found`,
          },
        };
      }
      configurationDigest = authorityConnectorDigest(connector);
      holdThisStep =
        p.ctx.hold_writes === true && requestRequiresPreparationHold(p.step, connector.driver);
      connectorResolution = {
        step_key: p.step.id,
        connector_id: connector.id,
        connector_slug: connector.slug,
        requested_environment: p.ctx.execution_mode,
        resolved_environment: connector.environment,
        driver: connector.driver,
        // auth_method + base_url are filled once the driver-specific path
        // runs (HTTP: buildRequestPlan tells us; GraphQL/S3: derived from
        // connector.auth_type which matches the applied method since those
        // drivers don't do inline oauth2 refresh yet).
        auth_method: deriveAuthMethodFromAuthType(connector.auth_type),
        base_url: connector.base_url ?? null,
      };
      // Visibility for the silent env fallback: when the requested execution
      // environment couldn't be resolved to a same-env connector binding, the
      // resolver returns the original (possibly dev) connector. The fallback
      // is load-bearing for single-env tenants so it STAYS — but a prod run
      // hitting a dev binding must be greppable, not silent.
      if (connector.environment !== p.ctx.execution_mode) {
        logger.warn({
          module: "connectors",
          action: "connector.environment.fallback",
          msg: "connector resolved to a different environment than requested — the run may be hitting the dev binding",
          tenant_id: p.ctx.tenant_id,
          connector_id: connector.id,
          connector_slug: connector.slug,
          requested_environment: p.ctx.execution_mode,
          resolved_environment: connector.environment,
        });
        try {
          getMetrics().inc(METRIC_NAMES.CONNECTOR_ENV_FALLBACK_TOTAL, {
            connector_id: connector.id,
            requested_environment: p.ctx.execution_mode,
            resolved_environment: connector.environment,
          });
        } catch {
          /* metrics are best-effort */
        }
        // HARD gate for writes (audit H2): the warn above proved insufficient
        // — 769 silent dev→prod fallbacks shipped writes into the wrong
        // environment before anyone grepped for it. A write-classified step
        // (non-GET/HEAD/OPTIONS method, GraphQL mutation, non-SELECT SQL, S3
        // put — the same `classifyRequestStepSideEffects` seam hold-writes
        // uses) must NOT dispatch through a different-environment binding.
        // Reads keep the warn-only fallback: it stays load-bearing for
        // single-env tenants, and a cross-env read is recoverable.
        if (classifyRequestStepSideEffects(p.step) === "write") {
          clearTimeout(timer);
          return {
            status: "failed",
            retry_count: 0,
            duration_ms: Date.now() - start,
            error: {
              code: "connector_environment_mismatch",
              message:
                `write step requested environment "${p.ctx.execution_mode}" but connector "${connector.slug}" only resolves to "${connector.environment}" — ` +
                `create a ${p.ctx.execution_mode} binding for this connector; an author label is not permission to send writes through an environment fallback`,
            },
          };
        }
      }
      // Circuit-breaker ENFORCEMENT, for every driver.
      //
      // This block used to sit below the `driver !== "http"` guard, so
      // graphql, s3 and postgres steps were never blocked by an open
      // breaker — while `execution/engine.ts`'s for_each preflight applied
      // the same predicate to any connector regardless of driver. One
      // predicate with two scopes meant a fan-out could be blocked at the
      // container by a breaker the per-step path would have ignored.
      // Hoisting it here is what makes "connectors have a circuit breaker"
      // a true statement rather than an HTTP-only one.
      if (connector.circuit_state === "open") {
        if (isCircuitOpenBlocking(connector)) {
          clearTimeout(timer);
          return {
            status: "failed",
            retry_count: 0,
            duration_ms: Date.now() - start,
            error: {
              code: "circuit_open",
              message: "connector circuit breaker is open — requests blocked until reset",
            },
          };
        }
        // Reset period elapsed — transition to half-open
        await persistCircuitState(p.ctx.db, connector, { circuit_state: "half-open" });
      }
      if (connector.driver === "graphql" || p.step.graphql) {
        clearTimeout(timer);
        if (!p.step.graphql) {
          return {
            status: "failed",
            retry_count: 0,
            duration_ms: Date.now() - start,
            error: {
              code: "missing_graphql",
              message: "request step against a graphql connector requires a `graphql` config",
            },
          };
        }
        try {
          // Resolve placeholders BEFORE handing to the GraphQL driver.
          // The query is a string (so we use the string-only resolver); the
          // variables map must preserve native JSON types — `${input.limit}`
          // alone in a value position becomes the typed input, not the
          // string `"7"`. Pre-fix the shared `resolvePlaceholders` walker
          // stringified every leaf and AppSync rejected `Variable 'limit'
          // has an invalid value` for ~30 minutes in session 820c1664.
          const queryRes = await resolveStringPlaceholders(p.step.graphql.query, resolverCtx);
          const variablesRes =
            p.step.graphql.variables !== undefined
              ? await resolvePlaceholdersTypePreserving(p.step.graphql.variables, resolverCtx)
              : null;
          const allUnresolved = [...queryRes.unresolved, ...(variablesRes?.unresolved ?? [])];
          if (allUnresolved.length > 0) {
            clearTimeout(timer);
            const tokens = allUnresolved.map((u) => u.token).join(", ");
            return {
              status: "failed",
              retry_count: 0,
              duration_ms: Date.now() - start,
              error: {
                code: "placeholder_unresolved",
                message: `unresolved placeholder(s) in graphql query/variables: ${tokens}`,
                details: { unresolved: allUnresolved },
              },
              request_meta: {
                driver: "error",
                method: "POST",
                url: connector.base_url ?? null,
                unresolved_placeholders: allUnresolved.map((u) => u.token),
              },
            };
          }
          const args: Parameters<typeof graphqlQuery>[0] = {
            before_dispatch: beforeDispatch,
            db: p.ctx.db,
            tenant_id: p.ctx.tenant_id,
            connector,
            query: queryRes.value,
          };
          if (variablesRes !== null) {
            args.variables = variablesRes.value as Record<string, unknown>;
          }
          if (p.step.graphql.operation !== undefined) {
            args.operation = p.step.graphql.operation;
          }
          // Step-level headers — placeholder-resolved upstream into
          // `resolvedStepHeaders`. Pre-fix the GraphQL driver path
          // ignored them entirely so a workflow that minted a token
          // in step N and forwarded it as
          // `headers: { Authorization: "${scope.…}" }` to step N+1
          // saw the explicit header dropped silently. The operator
          // had to switch the connector driver from `graphql` to
          // `http` and rebuild the body shape (~5 extra preview
          // rounds in session 1b94070c).
          if (Object.keys(resolvedStepHeaders).length > 0) {
            args.extra_headers = resolvedStepHeaders;
          }
          const cfg = (connector.config ?? {}) as { endpoint?: unknown };
          const endpointUrl =
            typeof cfg.endpoint === "string" && cfg.endpoint.length > 0
              ? cfg.endpoint
              : (connector.base_url ?? null);
          // Hold-writes: a mutation is materialized (resolved document +
          // typed variables) and recorded — the GraphQL driver is never
          // invoked, so no token refresh and no wire call happen.
          if (holdThisStep) {
            return heldStepResult({
              start,
              method: "POST",
              url: endpointUrl,
              headers: resolvedStepHeaders,
              body: {
                query: queryRes.value,
                ...(variablesRes !== null
                  ? { variables: variablesRes.value as Record<string, unknown> }
                  : {}),
              },
            });
          }
          const graphqlResult = await runGraphqlWithRetry({
            queryArgs: args,
            egressInput: {
              executor: p.ctx.db,
              tenant_id: p.ctx.tenant_id,
              actor_id: p.ctx.principal?.id ?? null,
              actor_type: p.ctx.principal?.kind === "system_account" ? "system_account" : "user",
              connector_id: connector.id,
              connector_slug: connector.slug,
              driver: "graphql",
              operation: p.step.graphql.operation ?? "query",
              url: endpointUrl,
              source: "execution",
              execution_id: p.ctx.execution_id,
              workflow_id: p.ctx.workflow_id,
              step_id: p.step.id,
            },
            step: p.step,
            signal,
            start,
            connectorResolution,
          });
          await recordDriverOutcome(p.ctx.db, connector, graphqlEvidence(graphqlResult));
          return graphqlResult;
        } catch (err) {
          await recordDriverOutcome(p.ctx.db, connector, evidenceFromThrow(err));
          // Header-contract violations on the GraphQL pipeline get the
          // same `request_invalid` classification as the HTTP driver.
          // Without this distinction the LLM sees `graphql_error` for
          // both real query failures and "your headers are malformed",
          // and may loop trying to repair the GraphQL document instead
          // of fixing the headers. (Audit anti-pattern C1.)
          if (err instanceof HttpRequestInvalidError) {
            return {
              status: "failed",
              retry_count: 0,
              duration_ms: Date.now() - start,
              error: buildStepErrorDetail({ code: "request_invalid", err }),
            };
          }
          return {
            status: "failed",
            retry_count: 0,
            duration_ms: Date.now() - start,
            error: buildStepErrorDetail({ code: "graphql_error", err }),
          };
        }
      }
      if (connector.driver === "mcp" || p.step.mcp) {
        // Dropping the step timer here is WHY the schema refuses `timeout_ms`
        // on an mcp step (workflows/types.ts). From this point the only
        // deadline is the connector's `remote_tool_call_timeout_ms`, which is
        // what makes `signal.aborted` on this path mean "the run was
        // cancelled" and nothing else — the property the abort handling
        // depends on. If this line ever goes, the schema refusal becomes a
        // lie and should go with it.
        clearTimeout(timer);
        const connectorMeta = connectorResolution as ConnectorResolutionSummary;
        if (connector.driver !== "mcp") {
          return {
            status: "failed",
            retry_count: 0,
            duration_ms: Date.now() - start,
            error: {
              code: "connector_driver_mismatch",
              message: `request step carries an \`mcp\` block but connector '${connector.slug}' is driver '${connector.driver}'`,
            },
          };
        }
        const mcpSpec = p.step.mcp;
        if (!mcpSpec) {
          return {
            status: "failed",
            retry_count: 0,
            duration_ms: Date.now() - start,
            error: {
              code: "missing_mcp",
              message:
                "request step against an mcp connector requires an `mcp` block naming the operation (call_tool | read_resource | get_prompt)",
            },
          };
        }
        const unresolved = [...(mcpTargetRes?.unresolved ?? []), ...(mcpArgsRes?.unresolved ?? [])];
        if (unresolved.length > 0) {
          const tokens = unresolved.map((u) => u.token).join(", ");
          return {
            status: "failed",
            retry_count: 0,
            duration_ms: Date.now() - start,
            error: {
              code: "placeholder_unresolved",
              message: `unresolved placeholder(s) in mcp target/arguments: ${tokens}`,
              details: { unresolved },
            },
            request_meta: {
              driver: "error",
              url: connector.base_url ?? null,
              unresolved_placeholders: unresolved.map((u) => u.token),
            },
          };
        }
        const target = mcpTargetRes?.value ?? "";
        const args = (mcpArgsRes?.value as Record<string, unknown> | undefined) ?? {};
        const call: RemoteCall =
          mcpSpec.operation === "read_resource"
            ? { operation: "read_resource", uri: target }
            : mcpSpec.operation === "get_prompt"
              ? { operation: "get_prompt", prompt: target, arguments: args }
              : { operation: "call_tool", tool: target, arguments: args };
        const wireMethod = MCP_WIRE_METHOD[mcpSpec.operation];

        // Hold-writes: a `call_tool` is materialized — the resolved target
        // and typed arguments — and recorded. No session is established,
        // so no handshake, no token refresh and no remote call happen.
        // `url` is the server's endpoint, which is what the judge needs to
        // see: the tool name alone does not say WHERE it would run.
        if (holdThisStep) {
          return heldStepResult({
            start,
            method: wireMethod,
            url: connector.base_url ?? null,
            body: { target, ...(mcpSpec.operation === "read_resource" ? {} : { arguments: args }) },
          });
        }

        try {
          const result = await runMcpWithRetry({
            // Wrapped in the egress audit like every other driver. The pool
            // writes `mcp_external_tool.invoked`, which answers "which tool did
            // the model reach for" — a different question from the one the
            // egress trail answers. `connectors/egress.ts` is the single source
            // of truth for the documented claim that ALL egress is logged with
            // request source, caller identity and outcome (SOC 2 CC9), and an
            // MCP tool call is egress: it leaves the tenant carrying a
            // credential. Without this row an operator grepping "what left"
            // sees every driver except this one.
            //
            // Per ATTEMPT, not per step: each retry is its own outbound call,
            // and a trail that collapsed three attempts into one row would
            // under-report what actually crossed the boundary.
            attempt: () =>
              withEgressAudit(
                {
                  executor: p.ctx.db,
                  tenant_id: p.ctx.tenant_id,
                  actor_id: p.ctx.principal?.id ?? null,
                  actor_type:
                    p.ctx.principal?.kind === "system_account" ? "system_account" : "user",
                  connector_id: connector.id,
                  connector_slug: connector.slug,
                  driver: "mcp",
                  // Resolved inside the pool, which owns the session and its
                  // credential; the wrapper never sees the row id.
                  credential_id: null,
                  operation: wireMethod,
                  url: connector.base_url ?? null,
                  source: "execution",
                  execution_id: p.ctx.execution_id,
                  workflow_id: p.ctx.workflow_id,
                  step_id: p.step.id,
                },
                () =>
                  invokeMcpConnectorCall({
                    db: p.ctx.db,
                    tenant_id: p.ctx.tenant_id,
                    actor_id: p.ctx.principal?.id ?? null,
                    connector,
                    call,
                    // The run's own source — a scheduled run and a chat-driven
                    // run must not both be audited as the same thing.
                    requestSource: p.ctx.request_source,
                    // Aborting the run cancels the outbound request too, not
                    // just the retry sleep between attempts.
                    signal,
                  }),
              ),
            step: p.step,
            signal,
            start,
            connector: connectorMeta,
            operation: wireMethod,
            connector_id: connector.id,
          });
          // The breaker reads the layer verdict the retry loop already made
          // (`mcp_unavailable` vs `mcp_remote_error` vs `mcp_cancelled`), so
          // the two cannot disagree about what counts as the remote's fault.
          await recordDriverOutcome(p.ctx.db, connector, mcpEvidence(result));
          if (
            result.status === "succeeded" &&
            p.step.response_filters &&
            p.step.response_filters.length > 0
          ) {
            try {
              return {
                ...result,
                output: applyResponseFilters(p.step.response_filters, result.output),
              };
            } catch (err) {
              // A FAIL filter matching is the AUTHOR'S declared refusal of
              // this payload, not a driver fault. It gets its own code on
              // the HTTP path and must get the same one here, or the same
              // filter reports two different failures depending on driver.
              if (err instanceof ResponseFilterFailError) {
                return {
                  status: "failed",
                  retry_count: result.retry_count,
                  duration_ms: Date.now() - start,
                  error: { code: "filter_fail", message: err.message },
                  ...(result.request_meta ? { request_meta: result.request_meta } : {}),
                };
              }
              throw err;
            }
          }
          return result;
        } catch (err) {
          // `invokeMcpConnectorCall` throws only for a config or tool-name
          // fault — the pool converts every wire failure into a result.
          // Both are the author's to fix, so neither reaches the breaker.
          return {
            status: "failed",
            retry_count: 0,
            duration_ms: Date.now() - start,
            error: buildStepErrorDetail({ code: "mcp_step_invalid", err }),
          };
        }
      }
      if (connector.driver === "s3") {
        clearTimeout(timer);
        // Reached only inside the `if (p.step.connector_id)` block that
        // already populated connectorResolution; narrow the local
        // variable for the s3 / postgres returns below.
        const connectorMeta = connectorResolution as ConnectorResolutionSummary;
        try {
          // The `s3` block carries operation-specific affordances
          // (key, prefix, parse_as, content_type, metadata, range,
          // presign, multipart…). The verb itself lives at
          // `step.method` — single source of truth. Placeholder
          // resolution already ran upstream into resolvedS3Key /
          // resolvedS3Prefix.
          const s3Spec = p.step.s3;
          const method = (p.step.method ?? "GET") as S3Method;
          const resolvedKey = resolvedS3Key;
          const resolvedPrefix = resolvedS3Prefix;
          const reqPath =
            method === "LIST"
              ? `/${(resolvedPrefix ?? "").replace(/^\/+/, "")}`
              : resolvedKey
                ? `/${resolvedKey.replace(/^\/+/, "")}`
                : (resolvedStepPath ?? resolvedStepUrl ?? "/");
          const params: Parameters<typeof executeS3Request>[0] = {
            db: p.ctx.db,
            tenant_id: p.ctx.tenant_id,
            connector,
            method,
            path: reqPath,
            ...(s3Spec?.scope
              ? { before_dispatch: beforeDispatch, signal, timeout_ms: timeoutMs }
              : {}),
          };
          if (resolvedStepBody !== undefined && resolvedStepBody !== null) {
            params.body =
              typeof resolvedStepBody === "string"
                ? resolvedStepBody
                : JSON.stringify(resolvedStepBody);
          }
          if (s3Spec?.content_type) {
            params.contentType = s3Spec.content_type;
          }
          if (s3Spec?.metadata) {
            params.metadata = s3Spec.metadata;
          }
          if (typeof s3Spec?.max_keys === "number") {
            params.maxKeys = s3Spec.max_keys;
          }
          if (s3Spec?.paginate !== undefined) params.paginate = s3Spec.paginate;
          if (s3Spec?.multipart !== undefined) params.multipart = s3Spec.multipart;
          if (s3Spec?.multipart_threshold_mb !== undefined) {
            params.multipartThresholdMb = s3Spec.multipart_threshold_mb;
          }
          if (s3Spec?.range !== undefined) params.range = s3Spec.range;
          if (s3Spec?.presign !== undefined) {
            params.presignExpiresIn = s3Spec.presign.expires_in_s;
          }
          // Hold-writes: a PUT/DELETE is materialized (resolved key /
          // path + body) and recorded — the S3 driver never runs.
          if (holdThisStep) {
            return heldStepResult({
              start,
              method,
              url: reqPath,
              headers: resolvedStepHeaders,
              body: params.body ?? null,
            });
          }
          const res = await withEgressAudit(
            {
              executor: p.ctx.db,
              tenant_id: p.ctx.tenant_id,
              actor_id: p.ctx.principal?.id ?? null,
              actor_type: p.ctx.principal?.kind === "system_account" ? "system_account" : "user",
              connector_id: connector.id,
              connector_slug: connector.slug,
              driver: "s3",
              credential_id: null, // populated post-call from response.credential_id
              operation: method,
              url: null,
              source: "execution",
              execution_id: p.ctx.execution_id,
              workflow_id: p.ctx.workflow_id,
              step_id: p.step.id,
            },
            () => executeS3Request(params),
            (out) => ({ status: out.status }),
          );
          // parse_as decides how the GET body is decoded. Default
          // honours the driver's auto-detection; the explicit modes
          // give the caller a deterministic shape for downstream
          // transforms. `bytes` returns a Buffer (raw); `base64`
          // encodes the actual bytes (not double-encoded over a
          // utf8-decoded string, which previously corrupted binary
          // payloads).
          let output: unknown = res.body;
          if (method === "GET" && s3Spec?.parse_as) {
            const raw = res.body;
            const buf = Buffer.isBuffer(raw)
              ? raw
              : raw instanceof Uint8Array
                ? Buffer.from(raw)
                : typeof raw === "string"
                  ? Buffer.from(raw, "utf8")
                  : Buffer.from(String(raw ?? ""), "utf8");
            if (s3Spec.parse_as === "json") {
              try {
                output = JSON.parse(buf.toString("utf8"));
              } catch {
                output = buf.toString("utf8");
              }
            } else if (s3Spec.parse_as === "base64") {
              output = buf.toString("base64");
            } else if (s3Spec.parse_as === "bytes") {
              output = buf;
            } else {
              output = buf.toString("utf8");
            }
          }
          // expected_statuses honours the same contract as HTTP — the
          // S3 driver returns synthetic 200/204/404 codes that map
          // cleanly to operator expectations.
          if (
            Array.isArray(p.step.expected_statuses) &&
            p.step.expected_statuses.length > 0 &&
            !p.step.expected_statuses.includes(res.status)
          ) {
            return {
              status: "failed",
              retry_count: 0,
              duration_ms: Date.now() - start,
              error: {
                code: "unexpected_status_code",
                message: `expected one of ${JSON.stringify(p.step.expected_statuses)}, got ${res.status}`,
              },
              request_meta: {
                driver: "s3",
                method,
                status: res.status,
                ...(resolvedKey ? { key: resolvedKey } : {}),
                ...(resolvedPrefix ? { prefix: resolvedPrefix } : {}),
                connector: connectorMeta,
              },
            };
          }

          // Record success shape for drift detection / migration
          // tooling. Best-effort — observability, not load-bearing.
          if (res.status >= 200 && res.status < 300) {
            try {
              await recordSuccessShape(
                {
                  tenant_id: p.ctx.tenant_id,
                  connector_id: connector.id,
                  endpoint_key: `S3 ${method} ${resolvedPrefix ?? resolvedKey ?? "/"}`,
                  workflow_id: p.ctx.workflow_id,
                  step_id: p.step.id,
                  value: output,
                },
                p.ctx.db,
              );
            } catch {
              // tolerated
            }
          }

          // The store answered — close a half-open breaker even when the
          // answer was a 4xx, because a missing key is not evidence of an
          // unavailable store. A 5xx or a 429 IS, and used to be credited
          // here as reachability along with everything else.
          await recordDriverOutcome(p.ctx.db, connector, evidenceFromStatus(res.status));

          return {
            status: res.status >= 200 && res.status < 300 ? "succeeded" : "failed",
            output,
            retry_count: 0,
            duration_ms: Date.now() - start,
            request_meta: {
              driver: "s3",
              method,
              status: res.status,
              ...(resolvedKey ? { key: resolvedKey } : {}),
              ...(resolvedPrefix ? { prefix: resolvedPrefix } : {}),
              connector: connectorMeta,
            },
          };
        } catch (err) {
          await recordDriverOutcome(p.ctx.db, connector, evidenceFromThrow(err));
          // Credential-shape failures carry their own machine-branchable
          // code (credential_missing / credential_invalid /
          // credential_mode_unsupported_for_s3). Collapsing them into
          // `s3_error` would steer repair toward the request instead of
          // the stored credential.
          if (err instanceof S3CredentialError) {
            return {
              status: "failed",
              retry_count: 0,
              duration_ms: Date.now() - start,
              error: buildStepErrorDetail({ code: err.error_code, err }),
            };
          }
          return {
            status: "failed",
            retry_count: 0,
            duration_ms: Date.now() - start,
            error: buildStepErrorDetail({ code: "s3_error", err }),
          };
        }
      }
      if (connector.driver === "postgres") {
        clearTimeout(timer);
        // Same narrowing as the s3 block above.
        const connectorMeta = connectorResolution as ConnectorResolutionSummary;
        if (!p.step.sql?.query) {
          return {
            status: "failed",
            retry_count: 0,
            duration_ms: Date.now() - start,
            error: {
              code: "sql_required_for_postgres",
              message:
                "request step on a postgres connector requires `sql.query` (parameterised SQL) — the http path doesn't apply",
            },
          };
        }
        try {
          // Placeholder resolution for `params` already happened
          // upstream into `resolvedSqlParams`. The query string itself
          // is NEVER interpolated — placeholders go through `params`
          // to keep SQL injection structurally impossible.
          const sqlBlock = p.step.sql;
          const useTransaction =
            sqlBlock.transaction === true ||
            (sqlBlock.also !== undefined && sqlBlock.also.length > 0);
          const cursor = sqlBlock.cursor;
          const useCursor = cursor !== undefined;

          // Hold-writes: a non-SELECT statement (or transaction) is
          // materialized — query text + resolved params — and recorded;
          // no connection is opened, nothing executes.
          if (holdThisStep) {
            return heldStepResult({
              start,
              method: p.step.method ?? "SQL",
              url: null,
              body: {
                query: sqlBlock.query,
                params: resolvedSqlParams ?? [],
                ...(sqlBlock.also && sqlBlock.also.length > 0
                  ? {
                      also: sqlBlock.also.map((s) => ({
                        query: s.query,
                        params: s.params ?? [],
                      })),
                    }
                  : {}),
              },
            });
          }

          const dispatch = async (): Promise<{
            output: unknown;
            rowCount: number | null;
            rowCountPerStatement?: Array<number | null>;
          }> => {
            if (useTransaction) {
              const alsoStatements = sqlBlock.also ?? [];
              const statements = [
                { query: sqlBlock.query, params: resolvedSqlParams ?? [] },
                ...alsoStatements.map((s) => ({
                  query: s.query,
                  params: (s.params ?? []) as unknown[],
                })),
              ];
              // Per-statement assertions: index 0 inherits the
              // step-level expected_row_count; indices 1+ pull from
              // the matching `also[i-1].expected_row_count`. Throwing
              // inside `onStatement` rolls back the whole tx.
              const stepLevelExpectation = p.step.expected_row_count;
              const tx = await pgTransaction({
                connector,
                statements,
                onStatement: (idx, _rows, rowCount) => {
                  if (rowCount === null) return;
                  const expectation =
                    idx === 0 ? stepLevelExpectation : alsoStatements[idx - 1]?.expected_row_count;
                  if (expectation === undefined) return;
                  const violation = evaluateExpectedRowCount(
                    expectation as ExpectedRowCount,
                    rowCount,
                  );
                  if (violation) {
                    throw Object.assign(
                      new Error(`expected_row_count violation on statement ${idx}: ${violation}`),
                      { code: "expected_row_count_mismatch", statement_index: idx },
                    );
                  }
                },
              });
              return {
                output: tx.rows_per_statement[0] ?? [],
                rowCount: tx.total_row_count,
                rowCountPerStatement: tx.row_count_per_statement,
              };
            }
            if (useCursor && cursor) {
              const rows = await pgQueryCursor({
                connector,
                sql: sqlBlock.query,
                params: resolvedSqlParams ?? [],
                fetch_size: cursor.fetch_size,
              });
              return { output: rows, rowCount: Array.isArray(rows) ? rows.length : null };
            }
            const res = await pgQueryWithCount({
              connector,
              sql: sqlBlock.query,
              params: resolvedSqlParams ?? [],
            });
            return { output: res.rows, rowCount: res.row_count };
          };

          const dispatched = await withEgressAudit(
            {
              executor: p.ctx.db,
              tenant_id: p.ctx.tenant_id,
              actor_id: p.ctx.principal?.id ?? null,
              actor_type: p.ctx.principal?.kind === "system_account" ? "system_account" : "user",
              connector_id: connector.id,
              connector_slug: connector.slug,
              driver: "postgres",
              credential_id: null,
              operation: p.step.method ?? (useTransaction ? "TRANSACTION" : "QUERY"),
              url: null,
              source: "execution",
              execution_id: p.ctx.execution_id,
              workflow_id: p.ctx.workflow_id,
              step_id: p.step.id,
            },
            dispatch,
            () => ({ status: 200 }),
          );

          // Step-level assertion (single-statement path). The
          // transaction path checks per-statement inside the
          // `onStatement` hook above and rolls back on miss.
          if (
            !useTransaction &&
            p.step.expected_row_count !== undefined &&
            dispatched.rowCount !== null
          ) {
            const violation = evaluateExpectedRowCount(
              p.step.expected_row_count as ExpectedRowCount,
              dispatched.rowCount,
            );
            if (violation && connectorResolution) {
              return {
                status: "failed",
                retry_count: 0,
                duration_ms: Date.now() - start,
                error: {
                  code: "expected_row_count_mismatch",
                  message: violation,
                },
                request_meta: {
                  driver: "postgres",
                  query_preview: sqlBlock.query.slice(0, 120),
                  row_count: dispatched.rowCount,
                  transaction: useTransaction,
                  cursor: useCursor,
                  connector: connectorResolution,
                },
              };
            }
          }

          // Record success shape for drift / migration tooling.
          // Best-effort — observability, not load-bearing.
          try {
            await recordSuccessShape(
              {
                tenant_id: p.ctx.tenant_id,
                connector_id: connector.id,
                endpoint_key: `${p.step.method ?? "SQL"} ${sqlBlock.query.slice(0, 80)}`,
                workflow_id: p.ctx.workflow_id,
                step_id: p.step.id,
                value: dispatched.output,
              },
              p.ctx.db,
            );
          } catch {
            // tolerated
          }

          // The statement ran, so the database answered.
          await recordDriverOutcome(p.ctx.db, connector, "answered");

          return {
            status: "succeeded",
            output: dispatched.output,
            retry_count: 0,
            duration_ms: Date.now() - start,
            request_meta: {
              driver: "postgres",
              query_preview: sqlBlock.query.slice(0, 120),
              row_count: dispatched.rowCount,
              transaction: useTransaction,
              cursor: useCursor,
              connector: connectorMeta,
              ...(dispatched.rowCountPerStatement
                ? { row_count_per_statement: dispatched.rowCountPerStatement }
                : {}),
            },
          };
        } catch (err) {
          await recordDriverOutcome(p.ctx.db, connector, evidenceFromThrow(err));
          // The onStatement hook tags expected_row_count violations
          // with a structured error.code so the caller sees the
          // typed envelope rather than a generic postgres_error.
          const code =
            err && typeof err === "object" && (err as { code?: string }).code
              ? (err as { code: string }).code
              : "postgres_error";
          return {
            status: "failed",
            retry_count: 0,
            duration_ms: Date.now() - start,
            error: buildStepErrorDetail({ code, err }),
          };
        }
      }
      // Drift backstop. Every driver with a branch above returned already,
      // so reaching here means `DriverEnum` grew a member and this chain
      // did not. The message names the driver rather than claiming http is
      // the only valid one — it has not been for four drivers now.
      if (connector.driver !== "http") {
        clearTimeout(timer);
        return {
          status: "failed",
          retry_count: 0,
          duration_ms: Date.now() - start,
          error: {
            code: "connector_driver_mismatch",
            message: `request step has no dispatch path for connector driver '${connector.driver}'`,
          },
        };
      }
      // Circuit-breaker enforcement already ran above, for every driver.
      // Track the connector so circuit state can be updated after the request.
      activeConnector = connector;
      const plan = await buildRequestPlan({
        db: p.ctx.db,
        tenant_id: p.ctx.tenant_id,
        connector,
        path_or_url: resolvedStepPath ?? resolvedStepUrl ?? "/",
        headers,
        query,
      });
      baseUrl = plan.url;
      activeCredentialId = plan.credential_id;
      credentialSnapshot = {
        credential_id: plan.credential_id,
        credential_revision: plan.credential_revision,
        connection_authority: plan.connection_authority ?? null,
      };
      for (const [k, v] of Object.entries(plan.headers)) {
        headers[k] = v;
      }
      if (connectorResolution) {
        // The plan observed whether the credential was refreshed inline —
        // prefer its auth_method over the connector's declared auth_type.
        connectorResolution.auth_method = plan.auth_method;
      }
    } else {
      if (!resolvedStepUrl) {
        clearTimeout(timer);
        return {
          status: "failed",
          retry_count: 0,
          duration_ms: Date.now() - start,
          error: { code: "missing_url", message: "request step requires url or connector_id" },
        };
      }
      baseUrl = new URL(resolvedStepUrl);
      for (const [k, v] of Object.entries(query)) {
        baseUrl.searchParams.set(k, String(v));
      }
    }
  } catch (err) {
    clearTimeout(timer);
    // Web-scraper — preserve the typed code for robots / egress
    // failures emitted by buildRequestPlan. Otherwise these surface as
    // a generic `request_setup_error` and the operator can't
    // distinguish "robots.txt blocked you" from "the URL is malformed".
    const code =
      err instanceof RobotsDisallowedError
        ? "robots_disallowed"
        : err instanceof EgressBlockedError
          ? "egress_blocked"
          : "request_setup_error";
    return {
      status: "failed",
      retry_count: 0,
      duration_ms: Date.now() - start,
      error: buildStepErrorDetail({ code, err }),
    };
  }

  // Before-Request Hook evaluation — fail-closed.
  if (p.ctx.principal) {
    try {
      const decision = await evaluateHook({
        db: p.ctx.db,
        tenant_id: p.ctx.tenant_id,
        principal: p.ctx.principal,
        requestCtx: {
          method: p.step.method,
          url: baseUrl.toString(),
          headers,
          body: resolvedStepBody ?? null,
          execution_id: p.ctx.execution_id,
          workflow_id: p.ctx.workflow_id,
          step_id: p.step.id,
        },
        trace_id: p.ctx.trace_id,
      });
      // Step-runner trace — every hook evaluation emits a single
      // debug line so operators can see why a request was allowed or
      // denied without having to recompute the decision from audit
      // rows alone.
      logger.debug({
        module: "execution",
        action: "hook.evaluated",
        hook_id: decision.hook_id ?? null,
        role: p.ctx.principal?.roles?.[0] ?? null,
        decision: decision.allowed ? "allow" : "deny",
        reason: decision.reason ?? null,
      });
      if (!decision.allowed) {
        clearTimeout(timer);
        return {
          status: "failed",
          retry_count: 0,
          duration_ms: Date.now() - start,
          error: {
            code: "policy.denied",
            message: decision.reason ?? "before-request hook denied",
            details: decision.hook_id ? { hook_id: decision.hook_id } : undefined,
          },
        };
      }
    } catch (err) {
      // Fail-closed on evaluator failure too.
      clearTimeout(timer);
      return {
        status: "failed",
        retry_count: 0,
        duration_ms: Date.now() - start,
        error: buildStepErrorDetail({ code: "hook_error", err }),
      };
    }
  }

  // Resolve registry-backed fallbacks for body/response/expected_statuses
  // when the step itself doesn't declare them. Lookup key is
  // (connector_id, method, raw template path) to match what
  // runDocumentAnalysisFlow persisted.
  let registryRow: {
    request_schema: unknown;
    response_schema: unknown;
    expected_statuses: number[] | null;
  } | null = null;
  if (activeConnector && p.step.path) {
    const rows = await p.ctx.db
      .select({
        request_schema: connectorEndpointSchemas.request_schema,
        response_schema: connectorEndpointSchemas.response_schema,
        expected_statuses: connectorEndpointSchemas.expected_statuses,
      })
      .from(connectorEndpointSchemas)
      .where(
        and(
          eq(connectorEndpointSchemas.tenant_id, p.ctx.tenant_id),
          eq(connectorEndpointSchemas.connector_id, activeConnector.id),
          eq(connectorEndpointSchemas.method, p.step.method),
          eq(connectorEndpointSchemas.path, p.step.path),
        ),
      )
      .limit(1);
    registryRow = rows[0] ?? null;
  }
  const effectiveBodySchema = (p.step.body_schema ??
    (registryRow?.request_schema as Record<string, unknown> | undefined) ??
    null) as Record<string, unknown> | null;
  const effectiveResponseSchema = (p.step.response_schema ??
    (registryRow?.response_schema as Record<string, unknown> | undefined) ??
    null) as Record<string, unknown> | null;
  const effectiveExpectedStatuses =
    p.step.expected_statuses && p.step.expected_statuses.length > 0
      ? p.step.expected_statuses
      : (registryRow?.expected_statuses ?? null);

  const retryTotal = { value: 0 };
  const retryCounter = { value: 0 };
  const retry_policy = resolveRetryPolicy(p.step);
  // The persisted step instance separates loop iterations with the same
  // author-facing step id. Each page gets its own key, stable across retries.
  // Remote support is optional; this is not an exactly-once guarantee.
  const idempotencyBase =
    requestIsReadOnly || isIdempotent(p.step.method)
      ? null
      : `${p.ctx.execution_id}:${p.ctx.step_row_id}`;
  const lastIdempotencyKey: { value: string | null } = { value: null };
  // Pre-populate the diagnostic envelope with what we are about to send.
  // Without this, a failure before the first response handler runs (e.g.
  // an unexpected-status fail-fast or a connection error) returns
  // `request_meta: {}`, which leaves diagnose_run with nothing to show.
  // Audit-safe: header / query *names* only, never values.
  // Pre-populated diagnostic envelope. The audit-safe digest of
  // header + query keys + body kind lives in the first-class
  // `digest` field; both the http and connectorless variants surface
  // it identically.
  const digest = {
    header_keys: Object.keys(headers).sort(),
    query_keys: Object.keys(query).sort(),
    body_kind:
      resolvedStepBody == null
        ? "none"
        : Array.isArray(resolvedStepBody)
          ? "array"
          : typeof resolvedStepBody,
  };
  let last_meta: RequestMeta = connectorResolution
    ? {
        driver: "http",
        url: baseUrl.toString(),
        method: p.step.method ?? "GET",
        connector: connectorResolution,
        digest,
      }
    : {
        driver: "connectorless",
        url: baseUrl.toString(),
        method: p.step.method ?? "GET",
        digest,
      };
  let heldRequestUrl = baseUrl.toString();
  let heldRequestBody: unknown = resolvedStepBody;
  if (p.step.pagination) {
    const previewStrategy = makeStrategy(p.step.pagination as PaginationSpec, {
      baseUrl,
      baseQuery: {},
    });
    const firstPage = previewStrategy.next(null, 0);
    heldRequestUrl = firstPage.url;
    heldRequestBody = materializePaginatedBody(resolvedStepBody, firstPage.body_parameters);
  }
  // Validate the exact first request materialization before hold-writes so a
  // preview and live dispatch enforce the same body contract. Later pages are
  // validated again after their pagination parameters are materialized.
  if (effectiveBodySchema && heldRequestBody !== undefined && heldRequestBody !== null) {
    const bodyErrs = checkRequired(heldRequestBody, effectiveBodySchema);
    if (bodyErrs.length > 0) {
      clearTimeout(timer);
      return {
        status: "failed",
        retry_count: 0,
        duration_ms: Date.now() - start,
        error: { code: "request_body_schema_violation", message: bodyErrs.join("; ") },
      };
    }
  }

  // A step that declares `boundary` asks a human to approve exactly that
  // statement. Hold the materialized request to it here — before hold-writes,
  // so preview and live dispatch agree — or a green preview hides a request
  // its own boundary refuses on the first scheduled run.
  if (p.step.boundary) {
    const declared = requestBoundary(p.step, activeConnector?.base_url ?? null);
    const violation = declared
      ? requestBoundaryViolation(declared, {
          method: p.step.method ?? "GET",
          url: heldRequestUrl,
          headers,
          body: (heldRequestBody ?? null) as MaterializedRequest["body"],
          ...(p.resolved_multipart || p.resolved_body_file ? { unsupported_body: true } : {}),
        })
      : null;
    if (violation) {
      clearTimeout(timer);
      return {
        status: "failed",
        retry_count: 0,
        duration_ms: Date.now() - start,
        error: {
          code: "request_outside_declared_boundary",
          message:
            `This request is outside the boundary its step declares: ${describeRequestBoundaryViolation(violation)}. ` +
            "Nothing was sent. Correct `boundary` on this step so it covers the largest request the " +
            "workflow's own limits allow, or tighten those limits; do not remove the boundary.",
        },
      };
    }
  }

  // Hold-writes: the request is fully materialized at this point —
  // placeholders substituted, connector base URL composed, credential
  // headers applied by buildRequestPlan, policy hooks evaluated. This
  // is exactly what `doOnePage` would put on the wire; record it and
  // return WITHOUT dispatching (covers the paginated path too — a held
  // write never starts its page loop). `last_meta` (no `status`, it
  // never ran) keeps the persisted request_meta diagnosable, with an
  // explicit `extras.held` marker.
  if (
    holdThisStep &&
    p.step.side_effects !== "write" &&
    !p.step.pagination &&
    !p.resolved_multipart &&
    !p.resolved_body_file &&
    isDocumentedReadOperation({
      method: p.step.method ?? "GET",
      url: heldRequestUrl,
      headers,
      body: heldRequestBody as MaterializedRequest["body"],
    })
  )
    holdThisStep = false;
  if (holdThisStep) {
    clearTimeout(timer);
    return heldHttpResult({
      start,
      method: p.step.method ?? "GET",
      url: heldRequestUrl,
      headers,
      body: heldRequestBody ?? null,
      request_meta: { ...last_meta, extras: { ...(last_meta.extras ?? {}), held: true } },
    });
  }

  // Most recent in-flight pagination-checkpoint write. Hoisted so the
  // failure path can `await` it before reporting the result — guarantees
  // the row reflects the resume position by the time we return.
  let inFlightCheckpoint: Promise<void> | null = null;
  try {
    // KNOWN GAP: LLM budget enforcement and `llm_usage` accounting live in this
    // branch only, so a PAGINATED request step to a provider host is neither
    // capped nor booked. Left as-is deliberately rather than restructured on
    // speculation — no provider chat endpoint paginates, and production
    // currently has 7 LLM-connector steps, none of them paginated. Move the
    // accounting out if that ever stops being true.
    if (!p.step.pagination) {
      const httpEgressInput = activeConnector
        ? {
            executor: p.ctx.db,
            tenant_id: p.ctx.tenant_id,
            actor_id: p.ctx.principal?.id ?? null,
            actor_type: (p.ctx.principal?.kind === "system_account" ? "system_account" : "user") as
              | "user"
              | "system_account",
            connector_id: activeConnector.id,
            connector_slug: activeConnector.slug,
            driver: "http" as const,
            credential_id: activeCredentialId,
            operation: p.step.method,
            url: baseUrl,
            source: "execution" as const,
            execution_id: p.ctx.execution_id,
            workflow_id: p.ctx.workflow_id,
            step_id: p.step.id,
          }
        : null;
      // Per-run LLM-token budget — pre-call gate. Detect that the
      // resolved URL targets a known LLM provider host; if so,
      // estimate the call's max tokens from the request body and
      // refuse dispatch when the projected total would exceed the
      // workflow's `max_llm_tokens_per_run`. The check fires on every
      // request regardless of cap; the accumulator's `cap == null`
      // path short-circuits when the workflow did not declare a cap.
      const llmCall = isLlmProviderUrl(baseUrl);
      if (llmCall) {
        const estimated = estimateLlmCallTokens(resolvedStepBody);
        try {
          p.ctx.llm_budget.checkPreCall(estimated);
        } catch (err) {
          if (err instanceof LlmBudgetExceededError) {
            clearTimeout(timer);
            return {
              status: "failed",
              retry_count: 0,
              duration_ms: Date.now() - start,
              error: {
                code: err.code,
                message: err.message,
                details: {
                  running_total: err.running_total,
                  estimated_call_tokens: err.estimated_call_tokens,
                  cap: err.cap,
                },
              },
            };
          }
          throw err;
        }
      }
      // Build multipart body if the step carries pre-resolved parts.
      // `buildMultipartBody` is awaited once per non-paginated page call;
      // for the paginated path the same FormData is reused per page.
      let multipartFormData: FormData | undefined;
      if (p.resolved_multipart && p.resolved_multipart.length > 0) {
        multipartFormData = await buildMultipartBody(p.resolved_multipart);
      }
      const callDoOnePage = () =>
        doOnePage({
          before_dispatch: beforeHttpDispatch,
          url: baseUrl.toString(),
          method: p.step.method,
          headers,
          body: resolvedStepBody ?? null,
          ...(multipartFormData !== undefined ? { multipartBody: multipartFormData } : {}),
          max_attempts,
          signal,
          retry_total_ms: retryTotal,
          retry_counter: retryCounter,
          connector_id: p.step.connector_id ?? null,
          connector_slug: activeConnector?.slug ?? null,
          retry_policy,
          retry_safe: requestIsReadOnly,
          ...(effectiveExpectedStatuses
            ? { accepted_statuses: new Set(effectiveExpectedStatuses) }
            : {}),
          last_idempotency_key: lastIdempotencyKey,
          tenant_id: p.ctx.tenant_id,
          capture_binary: true,
          ...(idempotencyBase ? { idempotency_key_base: `${idempotencyBase}:0` } : {}),
        });
      const res = httpEgressInput
        ? await withEgressAudit(httpEgressInput, callDoOnePage, (out) => {
            // record the created/sent resource id (e.g. the provider
            // message id of an email send) so the EXECUTION audit row says
            // WHAT went out, not just host+status. This is the path real
            // workflow sends take (source:"execution").
            const createdId = extractCreatedResourceId(p.step.method ?? "GET", out.body);
            return {
              status: out.status,
              bytes_in: out.bytes_in,
              ...(createdId ? { created_resource_id: createdId } : {}),
            };
          })
        : await callDoOnePage();
      const contentRevisionReceipt = lastMaterializedHttpRequest
        ? inspectContentRevisionResponse({
            step_id: p.step.id,
            request: lastMaterializedHttpRequest,
            status: res.status,
            body: res.body,
          })
        : null;
      // Per-run LLM-token budget — post-call accounting. Parse the
      // provider's `usage` envelope, fold the prompt + completion
      // tokens into the run accumulator, and audit the outbound call
      // as an `external_write`. The audit row carries per-call AND
      // running-total counts so an operator can see the burn-down
      // without joining across rows.
      if (llmCall) {
        const usage = parseLlmUsage(res.body);
        if (usage) {
          p.ctx.llm_budget.account(usage);
          const model = extractModelHint(resolvedStepBody, res.body);
          await auditAwait(
            {
              tenant_id: p.ctx.tenant_id,
              actor_type: "system",
              action: AuditAction.EXTERNAL_WRITE,
              resource_type: "llm",
              resource_id: p.ctx.execution_id,
              result: "success",
              metadata: {
                provider: baseUrl.hostname,
                model,
                prompt_tokens: usage.prompt_tokens,
                completion_tokens: usage.completion_tokens,
                total_tokens: usage.total_tokens,
                cache_read_tokens: usage.cache_read_tokens,
                cache_creation_tokens: usage.cache_creation_tokens,
                run_total_tokens: p.ctx.llm_budget.total,
                workflow_id: p.ctx.workflow_id,
                step_id: p.step.id,
              },
            },
            p.ctx.db,
          );
          // …and into `llm_usage`, which is where every cost question is
          // actually asked from. The audit row above has recorded these
          // numbers all along, but nothing joins audit rows to answer "what
          // did this month cost": the editorial workflows spent real money on
          // claude-fable-5 and gpt-5.6 and reported zero LLM cost, because a
          // connector-borne call never reached this table. The host detection
          // and the parse were already here; only the write was missing.
          //
          // Deliberately not fatal: a bookkeeping failure must not fail a step
          // that already succeeded upstream.
          try {
            await recordUsage(
              {
                tenant_id: p.ctx.tenant_id,
                flow: "workflow_step",
                model: model ?? baseUrl.hostname,
                prompt_tokens: usage.prompt_tokens,
                completion_tokens: usage.completion_tokens,
                cache_read_tokens: usage.cache_read_tokens,
                cache_creation_tokens: usage.cache_creation_tokens,
                latency_ms: Date.now() - start,
                result: "success",
                actor_type: "system",
                execution_id: p.ctx.execution_id,
              },
              p.ctx.db,
            );
          } catch (err) {
            logger.warn({
              module: "execution",
              action: "llm_usage.record_failed",
              msg: "connector LLM call succeeded but its usage row could not be written",
              execution_id: p.ctx.execution_id,
              step_id: p.step.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      // Apply response filters. Promoted binary bodies skip them —
      // there is nothing JSON-shaped to filter; the envelope is built
      // after the expected_statuses gate below.
      let body = res.body;
      if (res.body_raw === undefined) {
        try {
          body = applyResponseFilters(p.step.response_filters, res.body);
        } catch (err) {
          if (err instanceof ResponseFilterFailError) {
            throw new RequestError(err.message, "filter_fail");
          }
          throw err;
        }
      }
      // Check expected_statuses (step → registry fallback)
      if (effectiveExpectedStatuses && effectiveExpectedStatuses.length > 0) {
        if (!effectiveExpectedStatuses.includes(res.status)) {
          clearTimeout(timer);
          return {
            status: "failed",
            retry_count: 0,
            duration_ms: Date.now() - start,
            error: {
              code: "unexpected_status_code",
              message: `status ${res.status} not in expected [${effectiveExpectedStatuses.join(",")}]`,
            },
          };
        }
      }
      // Binary response → engine-managed file. Runs AFTER the
      // expected_statuses gate so a rejected status never persists
      // bytes. The envelope becomes the step output; downstream steps
      // reference `${steps.<id>.file}` and sk-cli prints the download
      // hint from the `$file` leaf.
      let producedFileId: string | null = null;
      if (res.body_raw !== undefined) {
        const envelope = await promoteResponseToFile({
          db: p.ctx.db,
          tenant_id: p.ctx.tenant_id,
          actor_id: p.ctx.principal?.id ?? null,
          execution_id: p.ctx.execution_id,
          step_id: p.step.id,
          filename: filenameFromResponse({
            content_disposition: res.headers["content-disposition"] ?? null,
            url: baseUrl.toString(),
            content_type: res.headers["content-type"] ?? null,
            step_id: p.step.id,
          }),
          content_type: res.headers["content-type"]?.split(";")[0]?.trim() ?? null,
          bytes: res.body_raw,
        });
        body = envelope;
        producedFileId = envelope.file.$file;
      }
      // Validate response schema (non-fatal; step → registry fallback;
      // promoted bodies carry the envelope, not the vendor shape)
      if (effectiveResponseSchema && res.body_raw === undefined) {
        const respErrs = checkRequired(body, effectiveResponseSchema);
        if (respErrs.length > 0) {
          logger.warn({
            module: "execution",
            action: "response_schema_violation",
            step_id: p.step.id,
            errors: respErrs,
            schema_source: p.step.response_schema ? "step" : "registry",
          });
        }
      }
      // Circuit breaker: reset on success
      if (
        activeConnector &&
        (activeConnector.circuit_state === "half-open" || activeConnector.circuit_failure_count > 0)
      ) {
        await persistCircuitState(p.ctx.db, activeConnector, {
          circuit_state: "closed",
          circuit_failure_count: 0,
        });
      }
      // Re-auth clear: a successful authenticated response proves the
      // credential is live. This is a SEPARATE concern from the circuit
      // breaker — needs_reauth can be true while the circuit is closed, so
      // clear unconditionally on success (outside the circuit-state guard).
      if (activeConnector) {
        clearReauthOnSuccess(p.ctx.db, activeConnector);
      }
      // Deprecation early-warning: a SUCCESSFUL response that carries
      // Deprecation/Sunset headers means the vendor announced this
      // endpoint's removal — flag it now, months before the eventual 410,
      // so the migration happens inside the vendor's warning window instead
      // of as a production outage. Otherwise recover transient health
      // (degraded) on success. Both are edge-guarded; the in-memory
      // snapshot guards skip the no-op write on the steady state.
      if (activeConnector) {
        const deprecation = parseDeprecation(res.headers);
        if (deprecation && activeConnector.health_state !== "needs_update") {
          logger.warn({
            module: "connectors",
            action: "connector.endpoint.deprecated",
            msg: "vendor announced endpoint deprecation on a successful response",
            tenant_id: p.ctx.tenant_id,
            connector_id: activeConnector.id,
            step_id: p.step.id,
            sunset: deprecation.sunset,
            successor_uri: deprecation.successor_uri,
          });
          await flagConnectorContractFailure(p.ctx.db, activeConnector, {
            error_code: "endpoint_deprecated",
            reason: `vendor announced deprecation of an endpoint this connector uses${deprecation.sunset ? ` (sunset: ${deprecation.sunset})` : ""}`,
            deprecation,
            workflow_id: p.ctx.workflow_id ?? null,
          });
        } else if (
          !deprecation &&
          (activeConnector.health_state === "degraded" ||
            activeConnector.health_state === "needs_reauth")
        ) {
          await clearConnectorHealthOnSuccess(p.ctx.db, activeConnector);
        }
      }
      // Record success shape for drift detection / migration tooling —
      // the same call the s3/postgres branches already make. HTTP is the
      // most common driver; without this `getLatestShape` is always null
      // for HTTP connectors and the self-healing drift signals
      // (http_status_new_shape / schema_diff) can never fire.
      // Best-effort — observability, not load-bearing. Promoted binary
      // bodies are skipped: the envelope is engine shape, not vendor
      // shape, and would poison drift detection.
      if (activeConnector && res.status >= 200 && res.status < 300 && res.body_raw === undefined) {
        try {
          await recordSuccessShape(
            {
              tenant_id: p.ctx.tenant_id,
              connector_id: activeConnector.id,
              endpoint_key: `${p.step.method ?? "GET"} ${baseUrl.pathname}`,
              workflow_id: p.ctx.workflow_id,
              step_id: p.step.id,
              value: res.body,
            },
            p.ctx.db,
          );
        } catch {
          // tolerated
        }
      }
      const producedExtras =
        producedFileId || contentRevisionReceipt
          ? {
              extras: {
                ...(producedFileId ? { produced_file_id: producedFileId } : {}),
                ...(contentRevisionReceipt
                  ? { content_revision_receipt: contentRevisionReceipt }
                  : {}),
              },
            }
          : {};
      last_meta = connectorResolution
        ? {
            driver: "http",
            url: baseUrl.toString(),
            method: p.step.method ?? "GET",
            status: res.status,
            bytes_in: res.bytes_in,
            ...(lastIdempotencyKey.value ? { idempotency_key: lastIdempotencyKey.value } : {}),
            connector: connectorResolution,
            digest,
            ...producedExtras,
          }
        : {
            driver: "connectorless",
            url: baseUrl.toString(),
            method: p.step.method ?? "GET",
            status: res.status,
            bytes_in: res.bytes_in,
            ...(lastIdempotencyKey.value ? { idempotency_key: lastIdempotencyKey.value } : {}),
            digest,
            ...producedExtras,
          };
      return {
        status: "succeeded",
        output: body,
        retry_count: retryCounter.value,
        duration_ms: Date.now() - start,
        request_meta: last_meta,
      };
    }
    // Paginated request. Checkpoints are progress evidence only: without a
    // durable page accumulator, skipping completed pages would make the
    // returned result incomplete, so every retry starts at page 1.
    //
    // The signature covers URL, query, body and pagination config so progress
    // evidence is never attributed to a different workflow shape.
    const requestSignature = paginationSignature({
      base_url: baseUrl.origin + baseUrl.pathname,
      path_or_url: p.step.path ?? p.step.url ?? "/",
      query: { ...(p.step.query ?? {}) },
      body: resolvedStepBody ?? null,
      pagination: p.step.pagination,
    });
    try {
      const existing = await readPaginationCheckpoint(p.ctx.tenant_id, p.ctx.step_row_id, p.ctx.db);
      if (existing && existing.signature === requestSignature) {
        logger.info({
          module: "pagination",
          action: "restart_from_origin",
          msg: "pagination restarts from page 1 to preserve a complete result",
          execution_id: p.ctx.execution_id,
          step_id: p.step.id,
          prior_page: existing.page_idx,
          prior_accumulated_count: existing.accumulated_count,
        });
      }
    } catch (err) {
      // A read failure must NOT prevent the request from running — the
      // worst case is we restart from page 1 (the existing behaviour).
      logger.warn({
        module: "pagination",
        action: "resume_read_failed",
        execution_id: p.ctx.execution_id,
        step_id: p.step.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const paginationSpec = p.step.pagination as PaginationSpec;
    const strat = makeStrategy(paginationSpec, { baseUrl, baseQuery: {} });
    const acc: unknown[] = [];
    let prev: unknown = null;
    let pageIdx = 0;
    let pages_fetched = 0;
    // In-memory byte cap for the accumulator. MAX_PAGES alone is not a
    // memory bound — 1000 pages × 545KB bodies (the observed GitHub page
    // size) would buffer ~545MB in one step and was a confirmed driver of
    // the engine's multi-GB RSS. `bytes_in` per page is already measured
    // by the driver; when another page would be required after the running
    // total crosses the cap, the step fails instead of returning a prefix.
    const ACC_BYTE_CAP = 64 * 1024 * 1024;
    let accBytes = 0;
    // Most recent page's response headers — the deprecation early-warning on
    // the paginated success path reads Deprecation/Sunset from here.
    let lastPageHeaders: Record<string, string> = {};
    // Local mirror of the most recently issued progress-checkpoint write.
    let latestCheckpoint: PaginationCheckpoint | null = null;
    const maxPages = paginationSpec.max_pages ?? MAX_PAGES;
    while (pageIdx < maxPages) {
      const next = strat.next(prev, pageIdx);
      if (next.done) break;
      if (accBytes >= ACC_BYTE_CAP) {
        throw new RequestError(
          `pagination exceeded the ${Math.round(ACC_BYTE_CAP / (1024 * 1024))}MB in-memory byte cap before the endpoint terminated`,
          "request_invalid",
        );
      }
      const pageBody = materializePaginatedBody(resolvedStepBody, next.body_parameters);
      if (effectiveBodySchema && pageBody !== undefined && pageBody !== null) {
        const bodyErrs = checkRequired(pageBody, effectiveBodySchema);
        if (bodyErrs.length > 0) {
          throw new RequestError(
            `request body schema violation: ${bodyErrs.join("; ")}`,
            "request_invalid",
          );
        }
      }
      const callPage = () =>
        doOnePage({
          before_dispatch: beforeHttpDispatch,
          url: next.url,
          method: p.step.method,
          headers,
          body: pageBody ?? null,
          max_attempts,
          signal,
          retry_total_ms: retryTotal,
          retry_counter: retryCounter,
          connector_id: p.step.connector_id ?? null,
          connector_slug: activeConnector?.slug ?? null,
          retry_policy,
          retry_safe: requestIsReadOnly,
          ...(effectiveExpectedStatuses
            ? { accepted_statuses: new Set(effectiveExpectedStatuses) }
            : {}),
          last_idempotency_key: lastIdempotencyKey,
          tenant_id: p.ctx.tenant_id,
          ...(idempotencyBase ? { idempotency_key_base: `${idempotencyBase}:${pageIdx}` } : {}),
        });
      const pageEgressInput = activeConnector
        ? {
            executor: p.ctx.db,
            tenant_id: p.ctx.tenant_id,
            actor_id: p.ctx.principal?.id ?? null,
            actor_type: (p.ctx.principal?.kind === "system_account" ? "system_account" : "user") as
              | "user"
              | "system_account",
            connector_id: activeConnector.id,
            connector_slug: activeConnector.slug,
            driver: "http" as const,
            credential_id: activeCredentialId,
            operation: p.step.method,
            url: next.url,
            source: "execution" as const,
            execution_id: p.ctx.execution_id,
            workflow_id: p.ctx.workflow_id,
            step_id: p.step.id,
          }
        : null;
      const res = pageEgressInput
        ? await withEgressAudit(pageEgressInput, callPage, (out) => ({
            status: out.status,
            bytes_in: out.bytes_in,
          }))
        : await callPage();
      let body = res.body;
      try {
        body = applyResponseFilters(p.step.response_filters, res.body);
      } catch (err) {
        if (err instanceof ResponseFilterFailError) {
          throw new RequestError(err.message, "filter_fail");
        }
        throw err;
      }
      strat.merge(acc, body);
      prev = body;
      lastPageHeaders = res.headers;
      accBytes += res.bytes_in;
      pageIdx += 1;
      pages_fetched += 1;
      const logicalPageIdx = pageIdx;
      const logicalAccumulated = acc.length;
      // Pagination checkpoint goes on the typed `pagination_checkpoint`
      // field; the recovery path reads it directly from there.
      const checkpointTyped = latestCheckpoint
        ? {
            page_idx: logicalPageIdx,
            accumulated_count: logicalAccumulated,
            signature:
              typeof (latestCheckpoint as { signature?: unknown }).signature === "string"
                ? (latestCheckpoint as { signature: string }).signature
                : "",
          }
        : undefined;
      last_meta = connectorResolution
        ? {
            driver: "http",
            url: next.url,
            method: p.step.method ?? "GET",
            status: res.status,
            ...(lastIdempotencyKey.value ? { idempotency_key: lastIdempotencyKey.value } : {}),
            connector: connectorResolution,
            digest,
            pages_fetched: logicalPageIdx,
            ...(checkpointTyped ? { pagination_checkpoint: checkpointTyped } : {}),
          }
        : {
            driver: "connectorless",
            url: next.url,
            method: p.step.method ?? "GET",
            status: res.status,
            ...(lastIdempotencyKey.value ? { idempotency_key: lastIdempotencyKey.value } : {}),
            digest,
            pages_fetched: logicalPageIdx,
            ...(checkpointTyped ? { pagination_checkpoint: checkpointTyped } : {}),
          };
      if (pages_fetched % PAGE_PROGRESS_INTERVAL === 0) {
        logger.info({
          module: "execution",
          action: "request.pagination_progress",
          msg: "pagination progress",
          execution_id: p.ctx.execution_id,
          step_id: p.step.id,
          pages_fetched,
        });
      }
      // Checkpoint write — fire-and-forget so the loop doesn't block on
      // disk. Failures log a warning and the request continues; if the
      // engine then restarts before the next checkpoint window we lose at
      // most one window of progress (= PAGINATION_CHECKPOINT_INTERVAL pages).
      if (logicalPageIdx % PAGINATION_CHECKPOINT_INTERVAL === 0) {
        const snapshot = strat.snapshot(prev);
        const checkpoint: PaginationCheckpoint = {
          state: snapshot,
          page_idx: logicalPageIdx,
          accumulated_count: logicalAccumulated,
          signature: requestSignature,
          written_at: new Date().toISOString(),
        };
        latestCheckpoint = checkpoint;
        inFlightCheckpoint = writePaginationCheckpoint(
          p.ctx.tenant_id,
          p.ctx.step_row_id,
          checkpoint,
          p.ctx.db,
        ).catch((err) => {
          logger.warn({
            module: "pagination",
            action: "checkpoint_write_failed",
            execution_id: p.ctx.execution_id,
            step_id: p.step.id,
            page_idx: logicalPageIdx,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
    if (pageIdx >= maxPages && !strat.next(prev, pageIdx).done) {
      throw new RequestError(
        `pagination reached max_pages=${maxPages} before the endpoint terminated`,
        "request_invalid",
      );
    }
    if (inFlightCheckpoint) await inFlightCheckpoint;
    // Circuit-breaker reset + re-auth clear on the PAGINATED success path (the
    // single-page path does both above). A paginated workflow — e.g. a Jira
    // JQL search — that recovers after a credential fix must clear both too.
    if (
      activeConnector &&
      (activeConnector.circuit_state === "half-open" || activeConnector.circuit_failure_count > 0)
    ) {
      await persistCircuitState(p.ctx.db, activeConnector, {
        circuit_state: "closed",
        circuit_failure_count: 0,
      });
    }
    if (activeConnector) {
      clearReauthOnSuccess(p.ctx.db, activeConnector);
    }
    // Deprecation early-warning / health recovery on the paginated success
    // path — same contract as the single-page path above.
    if (activeConnector) {
      const deprecation = parseDeprecation(lastPageHeaders);
      if (deprecation && activeConnector.health_state !== "needs_update") {
        logger.warn({
          module: "connectors",
          action: "connector.endpoint.deprecated",
          msg: "vendor announced endpoint deprecation on a successful response",
          tenant_id: p.ctx.tenant_id,
          connector_id: activeConnector.id,
          step_id: p.step.id,
          sunset: deprecation.sunset,
          successor_uri: deprecation.successor_uri,
        });
        await flagConnectorContractFailure(p.ctx.db, activeConnector, {
          error_code: "endpoint_deprecated",
          reason: `vendor announced deprecation of an endpoint this connector uses${deprecation.sunset ? ` (sunset: ${deprecation.sunset})` : ""}`,
          deprecation,
          workflow_id: p.ctx.workflow_id ?? null,
        });
      } else if (
        !deprecation &&
        (activeConnector.health_state === "degraded" ||
          activeConnector.health_state === "needs_reauth")
      ) {
        await clearConnectorHealthOnSuccess(p.ctx.db, activeConnector);
      }
    }
    // Record success shape (drift detection) on the paginated path too.
    // The LAST page's body is shape-representative for the endpoint —
    // deriving from the full accumulator would walk every page for no
    // additional contract signal. Best-effort.
    if (activeConnector && prev !== null) {
      try {
        await recordSuccessShape(
          {
            tenant_id: p.ctx.tenant_id,
            connector_id: activeConnector.id,
            endpoint_key: `${p.step.method ?? "GET"} ${baseUrl.pathname}`,
            workflow_id: p.ctx.workflow_id,
            step_id: p.step.id,
            value: prev,
          },
          p.ctx.db,
        );
      } catch {
        // tolerated
      }
    }
    return {
      status: "succeeded",
      output: acc,
      retry_count: retryCounter.value,
      duration_ms: Date.now() - start,
      request_meta: {
        ...last_meta,
        pages_fetched,
      } as RequestMeta,
    };
  } catch (err) {
    const duration_ms = Date.now() - start;
    // Drain any pending pagination-checkpoint write so the row reflects
    // the resume position before the catch handler returns. Failures
    // already log via the inner .catch().
    if (inFlightCheckpoint) {
      try {
        await inFlightCheckpoint;
      } catch {
        // Already logged; swallow to keep the original error in flight.
      }
    }
    // Circuit breaker: record failure and potentially open the circuit.
    // Atomic increment-and-flip — never read-then-write (concurrent failures
    // would lose updates and the threshold would be unreachable).
    if (activeConnector) {
      await recordCircuitFailure(p.ctx.db, activeConnector);
    }
    // Re-auth flag: a 401 means the credential itself was rejected and is dead
    // until a human re-authenticates — a SEPARATE concern from the circuit
    // breaker above. Only 401 out of http_4xx sets needs_reauth (404/422 must
    // not). The mark is atomic false→true; we emit the operator notification
    // exactly once, on the transition edge, in the same transaction.
    //
    // A 403 is deliberately NOT an auth failure. It is the upstream answering
    // "this identity may not touch THIS resource" — a wrong id in a path, a
    // scope the grant never covered, a per-resource permission. The credential
    // is alive. This distinction is the one the rest of the codebase already
    // makes: probe classification maps 401 to `credential_invalid` and 403 to
    // `scope_insufficient`, and the proactive scan
    // (scheduler/connector-reauth-scan-runner.ts) flags ONLY the former.
    //
    // Conflating them is not a cosmetic mislabel: the flag makes every step on
    // the connector unavailable, which holds the workflow's schedule AND
    // refuses the prepared run that would clear the flag again. One 403 against
    // a resource the identity never owned could therefore strand a healthy
    // connector indefinitely. A genuinely dead credential still gets caught —
    // by its next 401, or by the proactive probe scan.
    if (
      activeConnector &&
      err instanceof RequestError &&
      err.cause_kind === "http_4xx" &&
      err.status === 401
    ) {
      await flagConnectorAuthFailure(p.ctx.db, activeConnector, {
        reason: "request rejected the credential (401)",
        workflow_id: p.ctx.workflow_id ?? null,
      });
    }
    // Contract-failure rollup: 410 Gone means the vendor REMOVED the endpoint
    // — flip connector health to needs_update on the transition edge (one
    // notification + audit row, however many runs keep hitting it), carrying
    // the vendor's announced successor URI when the 410 response included
    // deprecation Link headers. This is what converts the silent
    // "0 results forever" failure mode into an operator-visible state.
    if (
      activeConnector &&
      activeConnector.health_state !== "needs_update" &&
      err instanceof RequestError &&
      err.cause_kind === "http_4xx" &&
      err.status === 410
    ) {
      const hint = (err.meta?.health_hint ?? null) as {
        suggestion?: string;
        deprecation?: { deprecated: string; sunset: string | null; successor_uri: string | null };
      } | null;
      await flagConnectorContractFailure(p.ctx.db, activeConnector, {
        error_code: "endpoint_removed",
        reason:
          hint?.suggestion ?? "request returned 410 Gone — the vendor removed this endpoint/path",
        deprecation: hint?.deprecation ?? null,
        workflow_id: p.ctx.workflow_id ?? null,
      });
    }
    if (err instanceof RequestError && err.cause_kind === "abort") {
      // distinguish step timeout vs external cancel
      if (timeoutCtrl.signal.aborted && !p.ctx.signal.aborted) {
        return {
          status: "timed_out",
          retry_count: retryCounter.value,
          duration_ms,
          error: { code: "step_timeout", message: `request exceeded ${timeoutMs}ms` },
          request_meta: last_meta,
        };
      }
      return {
        status: "aborted",
        retry_count: retryCounter.value,
        duration_ms,
        error: { code: "aborted", message: "execution aborted" },
        request_meta: last_meta,
      };
    }
    if (err instanceof RequestError && err.cause_kind === "timeout") {
      return {
        status: "timed_out",
        retry_count: retryCounter.value,
        duration_ms,
        error: { code: "step_timeout", message: `request exceeded ${timeoutMs}ms` },
        request_meta: last_meta,
      };
    }
    return {
      status: "failed",
      retry_count: retryCounter.value,
      duration_ms,
      error: buildStepErrorDetail({
        code: err instanceof RequestError ? err.cause_kind : "request_error",
        err,
        request_meta: last_meta,
      }),
      request_meta: last_meta,
    };
  } finally {
    clearTimeout(timer);
  }
}
