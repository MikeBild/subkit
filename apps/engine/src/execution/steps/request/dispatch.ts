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
import {
  graphqlErrorMessages,
  query as graphqlQuery,
} from "../../../connectors/drivers/graphql.ts";
import {
  buildMultipartBody,
  buildRequestPlan,
  executePlannedHttpRequest,
  HttpRequestInvalidError,
  serializeXmlBody,
} from "../../../connectors/drivers/http.ts";
import {
  pgQueryCursor,
  pgQueryWithCount,
  pgTransaction,
} from "../../../connectors/drivers/postgres.ts";
import { executeS3Request, type S3Method } from "../../../connectors/drivers/s3.ts";
import { withEgressAudit } from "../../../connectors/egress.ts";
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
import { getConnectorForEnvironment } from "../../../connectors/service.ts";
import type { Db } from "../../../db/client.ts";
import { connectorEndpointSchemas, connectors } from "../../../db/schema/index.ts";
import type { ResolvedFile } from "../../../files/resolver.ts";
import {
  estimateLlmCallTokens,
  isLlmProviderUrl,
  LlmBudgetExceededError,
  parseLlmUsage,
} from "../../../llm/accounting/index.ts";
import {
  resolvePlaceholders,
  resolvePlaceholdersTypePreserving,
  resolveStringPlaceholders,
} from "../../../llm/substitution/resolver.ts";
import { logger } from "../../../logging/logger.ts";
import { recordRequestRetry } from "../../../observability/instrumentation.ts";
import { recordSuccessShape } from "../../../schema-versions/service.ts";
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
import { applyResponseFilters, ResponseFilterFailError } from "../../response-filter.ts";
import type {
  ConnectorResolutionSummary,
  RequestMeta,
  StepResult,
  StepRunContext,
} from "../../types.ts";
import { buildStepErrorDetail } from "../error-detail.ts";
import { RequestError } from "./errors.ts";
import {
  backoffMs,
  isIdempotent,
  parseRetryAfter,
  type RetryPolicy,
  resolveRetryPolicy,
} from "./retry.ts";
import { checkRequired, deriveAuthMethodFromAuthType, extractModelHint } from "./shape.ts";
import { classifyRequestStepSideEffects, heldStepResult } from "./side-effects.ts";

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

interface FetchAttemptResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  bytes_in: number;
}

async function fetchOnce(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  tenant_id: string,
  multipartBody?: FormData,
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
  });
  return {
    status: execution.status,
    headers: execution.headers,
    body: execution.body,
    bytes_in: execution.bytes_in,
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
  /** When set on a non-idempotent method, an `Idempotency-Key` header is
   *  injected per attempt as `${base}:${attempt}` so each retry is a fresh
   *  key. The latest emitted key is returned via `last_idempotency_key`. */
  idempotency_key_base?: string;
  /** Out-param: the most recent Idempotency-Key emitted by this call. The
   *  request step copies the value into `request_meta.idempotency_key` for
   *  audit. Stays null when no key was emitted (GET / HEAD / OPTIONS). */
  last_idempotency_key?: { value: string | null };
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

async function doOnePage(p: DoOnePageParams): Promise<FetchAttemptResult> {
  let attempt = 0;
  let lastErr: unknown = null;
  while (attempt < p.max_attempts) {
    attempt += 1;
    if (attempt > 1) p.retry_counter.value += 1;
    if (p.signal.aborted) {
      throw new RequestError("aborted", "abort");
    }
    // Per-attempt header copy so the Idempotency-Key for attempt N doesn't
    // leak into attempt N+1 (the loop bumps the suffix every retry).
    const attemptHeaders: Record<string, string> = { ...p.headers };
    if (p.idempotency_key_base && !isIdempotent(p.method)) {
      const key = `${p.idempotency_key_base}:${attempt}`;
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
      );
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
        if (!isIdempotent(p.method) && !is_additional_retry_status) {
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
      if (err instanceof HttpRequestInvalidError) {
        throw new RequestError(err.message, "request_invalid", undefined, {
          path: err.path,
        });
      }
      if (err instanceof RequestError) {
        if (err.cause_kind === "http_4xx") throw err;
        if (err.cause_kind === "abort") throw err;
        if (err.cause_kind === "filter_fail") throw err;
        if (err.cause_kind === "request_invalid") throw err;
        if (attempt >= p.max_attempts) throw err;
        continue;
      }
      const e = err as { name?: string; message?: string; cause?: { name?: string } };
      const isAbort =
        e.name === "AbortError" ||
        e.cause?.name === "AbortError" ||
        /aborted|abort/i.test(e.message ?? "") ||
        p.signal.aborted;
      if (isAbort) {
        if (p.signal.aborted) throw new RequestError("aborted", "abort");
        throw new RequestError("timeout", "timeout");
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
  // Hold-writes preview (Fix G): when the run was started with
  // `hold_writes`, a write-classified step is fully RESOLVED (every
  // driver branch holds AFTER placeholder substitution, credential /
  // plan construction and policy hooks — i.e. immediately before its
  // network call) and returned as a `held` outcome instead of being
  // dispatched. Read-classified steps execute live, unchanged.
  const holdThisStep =
    p.ctx.hold_writes === true && classifyRequestStepSideEffects(p.step) === "write";
  const max_attempts = (p.step.max_retries ?? 4) + 1; // 1 initial + N retries
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
  const bodyRes =
    p.step.body !== undefined && p.step.body !== null
      ? await resolvePlaceholders(p.step.body, resolverCtx)
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
          const res = await withEgressAudit(
            {
              executor: p.ctx.db,
              tenant_id: p.ctx.tenant_id,
              actor_id: p.ctx.principal?.id ?? null,
              actor_type: p.ctx.principal?.kind === "system_account" ? "system_account" : "user",
              connector_id: connector.id,
              connector_slug: connector.slug,
              driver: "graphql",
              credential_id: null, // populated post-call from response.credential_id
              operation: p.step.graphql.operation ?? "query",
              url: endpointUrl,
              source: "execution",
              execution_id: p.ctx.execution_id,
              workflow_id: p.ctx.workflow_id,
              step_id: p.step.id,
            },
            () => graphqlQuery(args),
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
          // Update connectorResolution with the actually-applied auth method
          // (may be `oauth2_refreshed` if the driver rotated a stale token).
          connectorResolution = {
            ...connectorResolution,
            auth_method: res.auth_method,
          };
          // GraphQL fails logically via a `body.errors` array even on
          // HTTP 200 (the AppSync convention). A non-empty `errors`
          // array is a failed step — not a success whose output happens
          // to contain errors. Without this check a broken query
          // ("green" HTTP 200) flows through as a succeeded step: the
          // dry-run reports clean and auto-commits a broken workflow.
          const gqlErrors = graphqlErrorMessages(res.body);
          const graphqlOk = res.status >= 200 && res.status < 300 && gqlErrors === null;
          // Unwrap the GraphQL envelope so the step output is the `data`
          // payload, not the `{ data, errors }` transport wrapper. This
          // makes `$scope.<step>.data` consistent with the REST driver
          // (single `data`, not a confusing double `data.data`). GraphQL
          // `errors` are not lost — they are classified above and routed
          // to the step `error` channel (see `gqlErrors` / `graphql_error`
          // below); a transform reads them via `$scope.<step>.error`.
          return {
            status: graphqlOk ? "succeeded" : "failed",
            output: (res.body as { data?: unknown }).data ?? null,
            retry_count: 0,
            duration_ms: Date.now() - start,
            request_meta: {
              driver: "graphql",
              method: "POST",
              status: res.status,
              connector: connectorResolution,
            },
            ...(graphqlOk
              ? {}
              : {
                  error: gqlErrors
                    ? {
                        code: "graphql_error",
                        message: `graphql response returned errors: ${gqlErrors
                          .slice(0, 3)
                          .join("; ")}`,
                      }
                    : {
                        code: `graphql_${res.status}`,
                        message: `graphql endpoint returned ${res.status}`,
                      },
                }),
          };
        } catch (err) {
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
                  value: output,
                },
                p.ctx.db,
              );
            } catch {
              // tolerated
            }
          }

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
                value: dispatched.output,
              },
              p.ctx.db,
            );
          } catch {
            // tolerated
          }

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
      if (connector.driver !== "http") {
        clearTimeout(timer);
        return {
          status: "failed",
          retry_count: 0,
          duration_ms: Date.now() - start,
          error: {
            code: "connector_driver_mismatch",
            message: `request step requires http driver, got ${connector.driver}`,
          },
        };
      }
      // Circuit breaker enforcement (HTTP driver only)
      if (connector.circuit_state === "open") {
        const openedAt = connector.circuit_opened_at;
        if (openedAt !== null) {
          const elapsed = Date.now() - openedAt.getTime();
          if (elapsed < connector.circuit_reset_ms) {
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
        }
        // Reset period elapsed — transition to half-open
        await persistCircuitState(p.ctx.db, connector, { circuit_state: "half-open" });
      }
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
  // Idempotency-Key shape: `${execution_id}:${step_id}:${attempt}`. We pass
  // the 2-segment base here; doOnePage appends the per-attempt suffix so
  // each retry is a fresh key. Step.id is the author-facing identifier
  // (matches the workflow definition), so a retried write that crosses an
  // engine restart still maps back to the same logical step.
  const idempotencyBase = isIdempotent(p.step.method) ? null : `${p.ctx.execution_id}:${p.step.id}`;
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
  // Hold-writes: the request is fully materialized at this point —
  // placeholders substituted, connector base URL composed, credential
  // headers applied by buildRequestPlan, policy hooks evaluated. This
  // is exactly what `doOnePage` would put on the wire; record it and
  // return WITHOUT dispatching (covers the paginated path too — a held
  // write never starts its page loop). `last_meta` (no `status`, it
  // never ran) keeps the persisted request_meta diagnosable, with an
  // explicit `extras.held` marker.
  if (holdThisStep) {
    clearTimeout(timer);
    return heldStepResult({
      start,
      method: p.step.method ?? "GET",
      url: baseUrl.toString(),
      headers,
      body: resolvedStepBody ?? null,
      request_meta: { ...last_meta, extras: { ...(last_meta.extras ?? {}), held: true } },
    });
  }

  // Most recent in-flight pagination-checkpoint write. Hoisted so the
  // failure path can `await` it before reporting the result — guarantees
  // the row reflects the resume position by the time we return.
  let inFlightCheckpoint: Promise<void> | null = null;
  try {
    if (!p.step.pagination) {
      // Body schema validation (non-paginated path only)
      if (effectiveBodySchema && resolvedStepBody !== undefined && resolvedStepBody !== null) {
        const bodyErrs = checkRequired(resolvedStepBody, effectiveBodySchema);
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
          last_idempotency_key: lastIdempotencyKey,
          tenant_id: p.ctx.tenant_id,
          ...(idempotencyBase ? { idempotency_key_base: idempotencyBase } : {}),
        });
      const res = httpEgressInput
        ? await withEgressAudit(httpEgressInput, callDoOnePage, (out) => ({
            status: out.status,
            bytes_in: out.bytes_in,
          }))
        : await callDoOnePage();
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
                model: extractModelHint(resolvedStepBody, res.body),
                prompt_tokens: usage.prompt_tokens,
                completion_tokens: usage.completion_tokens,
                total_tokens: usage.total_tokens,
                run_total_tokens: p.ctx.llm_budget.total,
                workflow_id: p.ctx.workflow_id,
                step_id: p.step.id,
              },
            },
            p.ctx.db,
          );
        }
      }
      // Apply response filters
      let body = res.body;
      try {
        body = applyResponseFilters(p.step.response_filters, res.body);
      } catch (err) {
        if (err instanceof ResponseFilterFailError) {
          throw new RequestError(err.message, "filter_fail");
        }
        throw err;
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
      // Validate response schema (non-fatal; step → registry fallback)
      if (effectiveResponseSchema) {
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
      // Best-effort — observability, not load-bearing.
      if (activeConnector && res.status >= 200 && res.status < 300) {
        try {
          await recordSuccessShape(
            {
              tenant_id: p.ctx.tenant_id,
              connector_id: activeConnector.id,
              endpoint_key: `${p.step.method ?? "GET"} ${baseUrl.pathname}`,
              value: res.body,
            },
            p.ctx.db,
          );
        } catch {
          // tolerated
        }
      }
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
          }
        : {
            driver: "connectorless",
            url: baseUrl.toString(),
            method: p.step.method ?? "GET",
            status: res.status,
            bytes_in: res.bytes_in,
            ...(lastIdempotencyKey.value ? { idempotency_key: lastIdempotencyKey.value } : {}),
            digest,
          };
      return {
        status: "succeeded",
        output: body,
        retry_count: retryCounter.value,
        duration_ms: Date.now() - start,
        request_meta: last_meta,
      };
    }
    // paginated request — checkpoint + resume.
    //
    // Signature: hash of {base_url, path_or_url, query} so a workflow
    // re-author that flips a query param invalidates the resume position
    // (we'd otherwise feed the new request shape into the old offset/cursor).
    const requestSignature = paginationSignature({
      base_url: baseUrl.origin + baseUrl.pathname,
      path_or_url: p.step.path ?? p.step.url ?? "/",
      query: { ...(p.step.query ?? {}) },
    });
    let resumeSeed: PaginationCheckpoint["state"] | null = null;
    let resumePageIdx = 0;
    let resumeAccumulatedCount = 0;
    try {
      const existing = await readPaginationCheckpoint(p.ctx.tenant_id, p.ctx.step_row_id, p.ctx.db);
      if (existing && existing.signature === requestSignature) {
        resumeSeed = existing.state;
        resumePageIdx = existing.page_idx;
        resumeAccumulatedCount = existing.accumulated_count;
        logger.info({
          module: "pagination",
          action: "resumed",
          msg: "pagination resumed from checkpoint",
          execution_id: p.ctx.execution_id,
          step_id: p.step.id,
          from_page: existing.page_idx,
          accumulated_count: existing.accumulated_count,
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
    const strat = makeStrategy(
      p.step.pagination as PaginationSpec,
      { baseUrl, baseQuery: {} },
      resumeSeed,
    );
    const acc: unknown[] = [];
    let prev: unknown = null;
    let pageIdx = 0;
    let pages_fetched = 0;
    // In-memory byte cap for the accumulator. MAX_PAGES alone is not a
    // memory bound — 1000 pages × 545KB bodies (the observed GitHub page
    // size) would buffer ~545MB in one step and was a confirmed driver of
    // the engine's multi-GB RSS. `bytes_in` per page is already measured
    // by the driver; when the running total crosses the cap, pagination
    // stops with a loud `pagination_truncated` warning instead of an OOM.
    const ACC_BYTE_CAP = 64 * 1024 * 1024;
    let accBytes = 0;
    let paginationTruncated = false;
    // Most recent page's response headers — the deprecation early-warning on
    // the paginated success path reads Deprecation/Sunset from here.
    let lastPageHeaders: Record<string, string> = {};
    // Local mirror of the most recently issued checkpoint write. Carried
    // forward into `last_meta` so the failure path persists the resume
    // position even though the actual write to the row is fire-and-forget.
    let latestCheckpoint: PaginationCheckpoint | null = null;
    while (pageIdx < MAX_PAGES) {
      if (accBytes >= ACC_BYTE_CAP) {
        paginationTruncated = true;
        logger.warn({
          module: "execution",
          action: "request.pagination_truncated",
          msg: "pagination stopped at the in-memory byte cap",
          execution_id: p.ctx.execution_id,
          step_id: p.step.id,
          pages_fetched,
          accumulated_bytes: accBytes,
          byte_cap: ACC_BYTE_CAP,
        });
        break;
      }
      const next = strat.next(prev, pageIdx);
      if (next.done) break;
      const callPage = () =>
        doOnePage({
          url: next.url,
          method: p.step.method,
          headers,
          body: resolvedStepBody ?? null,
          max_attempts,
          signal,
          retry_total_ms: retryTotal,
          retry_counter: retryCounter,
          connector_id: p.step.connector_id ?? null,
          connector_slug: activeConnector?.slug ?? null,
          retry_policy,
          last_idempotency_key: lastIdempotencyKey,
          tenant_id: p.ctx.tenant_id,
          ...(idempotencyBase ? { idempotency_key_base: idempotencyBase } : {}),
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
      // Logical page number = "what page have we now finished" across the
      // physical run + any prior resumed runs. Used in the checkpoint so a
      // future restart sees the right resume point.
      const logicalPageIdx = resumePageIdx + pageIdx;
      const logicalAccumulated = resumeAccumulatedCount + acc.length;
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
      ...(paginationTruncated
        ? {
            warnings: [
              {
                code: "pagination_truncated" as const,
                message: `pagination stopped after ${pages_fetched} pages at the ${Math.round(ACC_BYTE_CAP / (1024 * 1024))}MB in-memory cap — the result is a bounded prefix. Narrow the query (filters, date range, per_page) or process pages incrementally.`,
                details: { pages_fetched, accumulated_bytes: accBytes, byte_cap: ACC_BYTE_CAP },
              },
            ],
          }
        : {}),
      request_meta: {
        ...last_meta,
        pages_fetched: resumePageIdx + pages_fetched,
        ...(resumePageIdx > 0
          ? {
              resumed_from_page: resumePageIdx,
              resumed_accumulated_count: resumeAccumulatedCount,
            }
          : {}),
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
    // Re-auth flag: an authentication rejection (401/403) means the
    // credential is dead until a human re-authenticates — a SEPARATE concern
    // from the circuit breaker above. Only the 401/403 subset of http_4xx
    // sets needs_reauth (a 404/422 must not). The mark is atomic false→true;
    // we emit the operator notification exactly once, on the transition edge,
    // in the same transaction as the mark.
    if (
      activeConnector &&
      err instanceof RequestError &&
      err.cause_kind === "http_4xx" &&
      (err.status === 401 || err.status === 403)
    ) {
      await flagConnectorAuthFailure(p.ctx.db, activeConnector, {
        reason: "request rejected authentication (401/403)",
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
