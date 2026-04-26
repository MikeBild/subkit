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

import { and, eq } from "drizzle-orm";
import { evaluateHook } from "../../auth/hooks.ts";
import { query as graphqlQuery } from "../../connectors/drivers/graphql.ts";
import { buildRequestPlan, executePlannedHttpRequest } from "../../connectors/drivers/http.ts";
import { executeS3Request, type S3Method } from "../../connectors/drivers/s3.ts";
import { withEgressAudit } from "../../connectors/egress.ts";
import { getConnectorForEnvironment } from "../../connectors/service.ts";
import { connectorEndpointSchemas, connectors } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { recordRequestRetry } from "../../observability/instrumentation.ts";
import type { RequestStep } from "../../workflows/types.ts";
import { combineSignals } from "../abort.ts";
import {
  MAX_PAGES,
  makeStrategy,
  PAGE_PROGRESS_INTERVAL,
  type PaginationSpec,
} from "../pagination.ts";
import { applyResponseFilters, ResponseFilterFailError } from "../response-filter.ts";
import type { StepResult, StepRunContext } from "../types.ts";

export const RETRY_BASE_MS = 200;
export const RETRY_CAP_MS = 30_000;
export const REQUEST_TIMEOUT_DEFAULT_MS = 60 * 60_000; // 1h

export class RequestError extends Error {
  constructor(
    message: string,
    public readonly cause_kind:
      | "http_5xx"
      | "http_429"
      | "http_4xx"
      | "timeout"
      | "abort"
      | "connection"
      | "filter_fail",
    public readonly status?: number,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

function jitter(ms: number): number {
  const j = ms * 0.2;
  return ms + (Math.random() * 2 - 1) * j;
}

/** Map a connector's declared `auth_type` to the applied-auth-method
 *  vocabulary used in request_meta.connector.auth_method. For HTTP
 *  requests this is overwritten with the plan's observed value (which
 *  distinguishes oauth2_refreshed vs oauth2_static). GraphQL/S3 paths
 *  use this directly since they don't do inline oauth2 refresh. */
function deriveAuthMethodFromAuthType(
  authType: "none" | "bearer" | "basic" | "oauth2" | "header" | "query",
): "none" | "bearer" | "header" | "query" | "basic" | "oauth2_static" | "oauth2_refreshed" {
  if (authType === "oauth2") return "oauth2_static";
  return authType;
}

function backoffMs(attempt: number, base_ms: number = RETRY_BASE_MS): number {
  const raw = Math.min(RETRY_CAP_MS, base_ms * 2 ** attempt);
  return Math.max(0, jitter(raw));
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  const numeric = Number.parseFloat(trimmed);
  if (Number.isFinite(numeric)) {
    return Math.max(0, numeric * 1000);
  }
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }
  return null;
}

function isIdempotent(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

// Per-step retry overrides. `additional_retry_statuses` extends the built-in
// retry policy (5xx + 429): any listed status retries regardless of method,
// matching the "explicit opt-in" semantics for non-idempotent codes like 408
// (Request Timeout) or 425 (Too Early).
interface RetryPolicy {
  backoff_base_ms: number;
  additional_retry_statuses: Set<number>;
}

function resolveRetryPolicy(step: RequestStep): RetryPolicy {
  return {
    backoff_base_ms: step.retry_backoff_ms ?? RETRY_BASE_MS,
    additional_retry_statuses: new Set(step.retry_on_status ?? []),
  };
}

function checkRequired(value: unknown, schema: Record<string, unknown>): string[] {
  const required = schema.required as string[] | undefined;
  if (!required || !Array.isArray(required)) return [];
  if (typeof value !== "object" || value === null)
    return required.map((f) => `required field '${f}' is missing`);
  return required
    .filter((f) => !(f in (value as Record<string, unknown>)))
    .map((f) => `required field '${f}' is missing`);
}

interface FetchAttemptResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  bytes_in: number;
}

interface TunnelRoute {
  tenant_id: string;
  target: string;
}

async function fetchOnce(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  tunnel?: TunnelRoute,
): Promise<FetchAttemptResult> {
  const execution = await executePlannedHttpRequest({
    tenant_id: tunnel?.tenant_id ?? "",
    method,
    url: new URL(url),
    headers,
    body,
    signal,
    ...(tunnel ? { tunnel_target: tunnel.target } : {}),
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
  max_attempts: number;
  signal: AbortSignal;
  retry_total_ms: { value: number };
  retry_counter: { value: number };
  tunnel?: TunnelRoute;
  connector_id?: string | null;
  retry_policy: RetryPolicy;
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
    try {
      const res = await fetchOnce(p.url, p.method, p.headers, p.body, p.signal, p.tunnel);
      if (res.status >= 200 && res.status < 400) return res;
      const is_additional_retry_status = p.retry_policy.additional_retry_statuses.has(res.status);
      if (res.status === 429) {
        const after = parseRetryAfter(res.headers["retry-after"] ?? null);
        const wait = Math.min(
          after ?? backoffMs(attempt, p.retry_policy.backoff_base_ms),
          60 * 60_000,
        );
        logger.info({
          module: "execution",
          action: "request.retry",
          msg: "request retrying due to 429",
          reason: "http_429",
          attempt,
          wait_ms: Math.round(wait),
        });
        recordRequestRetry({ connector_id: p.connector_id ?? null, reason: "http_429" });
        if (attempt >= p.max_attempts) {
          throw new RequestError(`http 429`, "http_429", 429, { headers: res.headers });
        }
        p.retry_total_ms.value += wait;
        await sleep(wait, p.signal);
        continue;
      }
      if (res.status >= 500) {
        if (!isIdempotent(p.method) && !is_additional_retry_status) {
          throw new RequestError(`http ${res.status}`, "http_5xx", res.status);
        }
        if (attempt >= p.max_attempts) {
          throw new RequestError(`http ${res.status}`, "http_5xx", res.status);
        }
        const wait = backoffMs(attempt, p.retry_policy.backoff_base_ms);
        logger.info({
          module: "execution",
          action: "request.retry",
          msg: "request retrying due to 5xx",
          reason: "http_5xx",
          attempt,
          wait_ms: Math.round(wait),
        });
        recordRequestRetry({ connector_id: p.connector_id ?? null, reason: "http_5xx" });
        await sleep(wait, p.signal);
        continue;
      }
      // 4xx (non-429): retryable only if explicitly opted in via retry_on_status.
      if (is_additional_retry_status) {
        if (attempt >= p.max_attempts) {
          throw new RequestError(`http ${res.status}`, "http_4xx", res.status, { body: res.body });
        }
        const wait = backoffMs(attempt, p.retry_policy.backoff_base_ms);
        logger.info({
          module: "execution",
          action: "request.retry",
          msg: "request retrying due to opted-in status",
          reason: "http_4xx_opt_in",
          status: res.status,
          attempt,
          wait_ms: Math.round(wait),
        });
        recordRequestRetry({ connector_id: p.connector_id ?? null, reason: "http_4xx_opt_in" });
        await sleep(wait, p.signal);
        continue;
      }
      throw new RequestError(`http ${res.status}`, "http_4xx", res.status, { body: res.body });
    } catch (err) {
      lastErr = err;
      if (err instanceof RequestError) {
        if (err.cause_kind === "http_4xx") throw err;
        if (err.cause_kind === "abort") throw err;
        if (err.cause_kind === "filter_fail") throw err;
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
        msg: "request retrying due to connection error",
        reason: "connection_error",
        attempt,
        wait_ms: Math.round(wait),
      });
      recordRequestRetry({ connector_id: p.connector_id ?? null, reason: "connection" });
      await sleep(wait, p.signal);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("request failed");
}

export interface RunRequestStepParams {
  ctx: StepRunContext;
  step: RequestStep;
  scope: Record<string, unknown>;
}

export async function runRequestStep(p: RunRequestStepParams): Promise<StepResult> {
  const start = Date.now();
  const max_attempts = (p.step.max_retries ?? 4) + 1; // 1 initial + N retries
  const timeoutMs = p.step.timeout_ms ?? REQUEST_TIMEOUT_DEFAULT_MS;
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort("timeout"), timeoutMs);
  const signal = combineSignals([p.ctx.signal, timeoutCtrl.signal]);
  // Compose headers/query/URL — connector-scoped steps route through the
  // HTTP driver so credentials get decrypted + applied once up front,
  // then the P3 retry loop runs on the resulting URL.
  const headers: Record<string, string> = { ...(p.step.headers ?? {}) };
  const query: Record<string, string | number | boolean> = { ...(p.step.query ?? {}) };
  let baseUrl: URL;
  let tunnelRoute: TunnelRoute | undefined;
  // Holds the resolved HTTP connector so circuit state can be updated on
  // success / failure in the outer try/catch block.
  let activeConnector: Awaited<ReturnType<typeof getConnectorForEnvironment>> = null;
  // Credential row id from the resolved HTTP plan, threaded into the
  // egress audit so the trail names which secret was used.
  let activeCredentialId: string | null = null;
  let connectorResolution: {
    connector_id: string;
    connector_slug: string;
    requested_environment: string;
    resolved_environment: string;
    driver: string;
    auth_method: string;
    base_url: string | null;
    tunnel_target?: string | null;
  } | null = null;
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
        tunnel_target: null,
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
          const args: Parameters<typeof graphqlQuery>[0] = {
            db: p.ctx.db,
            tenant_id: p.ctx.tenant_id,
            connector,
            query: p.step.graphql.query,
          };
          if (p.step.graphql.variables !== undefined) {
            args.variables = p.step.graphql.variables;
          }
          if (p.step.graphql.operation !== undefined) {
            args.operation = p.step.graphql.operation;
          }
          const cfg = (connector.config ?? {}) as { endpoint?: unknown };
          const endpointUrl =
            typeof cfg.endpoint === "string" && cfg.endpoint.length > 0
              ? cfg.endpoint
              : (connector.base_url ?? null);
          const res = await withEgressAudit(
            {
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
            (out) => ({ status: out.status, bytes_in: out.bytes_in }),
          );
          return {
            status: res.status >= 200 && res.status < 300 ? "succeeded" : "failed",
            output: res.body,
            retry_count: 0,
            duration_ms: Date.now() - start,
            request_meta: {
              driver: "graphql",
              status: res.status,
              operation: p.step.graphql.operation ?? "query",
              operation_name: res.operation_name,
              bytes_in: res.bytes_in,
              ...(connectorResolution ? { connector: connectorResolution } : {}),
            },
            ...(res.status >= 200 && res.status < 300
              ? {}
              : {
                  error: {
                    code: `graphql_${res.status}`,
                    message: `graphql endpoint returned ${res.status}`,
                  },
                }),
          };
        } catch (err) {
          return {
            status: "failed",
            retry_count: 0,
            duration_ms: Date.now() - start,
            error: {
              code: "graphql_error",
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      }
      if (connector.driver === "s3") {
        clearTimeout(timer);
        try {
          const reqPath = p.step.path ?? p.step.url ?? "/";
          const params: Parameters<typeof executeS3Request>[0] = {
            db: p.ctx.db,
            tenant_id: p.ctx.tenant_id,
            connector,
            method: (p.step.method ?? "GET") as S3Method,
            path: reqPath,
          };
          if (p.step.body !== undefined && p.step.body !== null) {
            params.body =
              typeof p.step.body === "string" ? p.step.body : JSON.stringify(p.step.body);
          }
          const res = await withEgressAudit(
            {
              tenant_id: p.ctx.tenant_id,
              actor_id: p.ctx.principal?.id ?? null,
              actor_type: p.ctx.principal?.kind === "system_account" ? "system_account" : "user",
              connector_id: connector.id,
              connector_slug: connector.slug,
              driver: "s3",
              credential_id: null, // populated post-call from response.credential_id
              operation: p.step.method ?? "GET",
              url: null,
              source: "execution",
              execution_id: p.ctx.execution_id,
              workflow_id: p.ctx.workflow_id,
              step_id: p.step.id,
            },
            () => executeS3Request(params),
            (out) => ({ status: out.status }),
          );
          return {
            status: res.status >= 200 && res.status < 300 ? "succeeded" : "failed",
            output: res.body,
            retry_count: 0,
            duration_ms: Date.now() - start,
            request_meta: {
              driver: "s3",
              method: p.step.method ?? "GET",
              status: res.status,
              ...(connectorResolution ? { connector: connectorResolution } : {}),
            },
          };
        } catch (err) {
          return {
            status: "failed",
            retry_count: 0,
            duration_ms: Date.now() - start,
            error: {
              code: "s3_error",
              message: err instanceof Error ? err.message : String(err),
            },
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
        void p.ctx.db
          .update(connectors)
          .set({ circuit_state: "half-open" })
          .where(eq(connectors.id, connector.id));
      }
      // Track the connector so circuit state can be updated after the request.
      activeConnector = connector;
      const plan = await buildRequestPlan({
        db: p.ctx.db,
        tenant_id: p.ctx.tenant_id,
        connector,
        path_or_url: p.step.path ?? p.step.url ?? "/",
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
      if (plan.tunnel_target) {
        tunnelRoute = { tenant_id: p.ctx.tenant_id, target: plan.tunnel_target };
        if (connectorResolution) connectorResolution.tunnel_target = plan.tunnel_target;
      }
    } else {
      if (!p.step.url) {
        clearTimeout(timer);
        return {
          status: "failed",
          retry_count: 0,
          duration_ms: Date.now() - start,
          error: { code: "missing_url", message: "request step requires url or connector_id" },
        };
      }
      baseUrl = new URL(p.step.url);
      for (const [k, v] of Object.entries(query)) {
        baseUrl.searchParams.set(k, String(v));
      }
    }
  } catch (err) {
    clearTimeout(timer);
    return {
      status: "failed",
      retry_count: 0,
      duration_ms: Date.now() - start,
      error: {
        code: "request_setup_error",
        message: err instanceof Error ? err.message : String(err),
      },
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
          body: p.step.body ?? null,
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
        error: {
          code: "hook_error",
          message: err instanceof Error ? err.message : String(err),
        },
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
  let last_meta: Record<string, unknown> = {};
  try {
    if (!p.step.pagination) {
      // Body schema validation (non-paginated path only)
      if (effectiveBodySchema && p.step.body !== undefined && p.step.body !== null) {
        const bodyErrs = checkRequired(p.step.body, effectiveBodySchema);
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
      const callDoOnePage = () =>
        doOnePage({
          url: baseUrl.toString(),
          method: p.step.method,
          headers,
          body: p.step.body ?? null,
          max_attempts,
          signal,
          retry_total_ms: retryTotal,
          retry_counter: retryCounter,
          connector_id: p.step.connector_id ?? null,
          retry_policy,
          ...(tunnelRoute ? { tunnel: tunnelRoute } : {}),
        });
      const res = httpEgressInput
        ? await withEgressAudit(httpEgressInput, callDoOnePage, (out) => ({
            status: out.status,
            bytes_in: out.bytes_in,
          }))
        : await callDoOnePage();
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
        void p.ctx.db
          .update(connectors)
          .set({ circuit_state: "closed", circuit_failure_count: 0 })
          .where(eq(connectors.id, activeConnector.id));
      }
      last_meta = {
        url: baseUrl.toString(),
        method: p.step.method,
        status: res.status,
        bytes_in: res.bytes_in,
        ...(connectorResolution ? { connector: connectorResolution } : {}),
      };
      return {
        status: "succeeded",
        output: body,
        retry_count: retryCounter.value,
        duration_ms: Date.now() - start,
        request_meta: last_meta,
      };
    }
    // paginated request
    const strat = makeStrategy(p.step.pagination as PaginationSpec, {
      baseUrl,
      baseQuery: {},
    });
    const acc: unknown[] = [];
    let prev: unknown = null;
    let pageIdx = 0;
    let pages_fetched = 0;
    while (pageIdx < MAX_PAGES) {
      const next = strat.next(prev, pageIdx);
      if (next.done) break;
      const callPage = () =>
        doOnePage({
          url: next.url,
          method: p.step.method,
          headers,
          body: p.step.body ?? null,
          max_attempts,
          signal,
          retry_total_ms: retryTotal,
          retry_counter: retryCounter,
          connector_id: p.step.connector_id ?? null,
          retry_policy,
          ...(tunnelRoute ? { tunnel: tunnelRoute } : {}),
        });
      const pageEgressInput = activeConnector
        ? {
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
      pageIdx += 1;
      pages_fetched += 1;
      last_meta = {
        url: next.url,
        method: p.step.method,
        status: res.status,
        page_idx: pageIdx,
        ...(connectorResolution ? { connector: connectorResolution } : {}),
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
    }
    return {
      status: "succeeded",
      output: acc,
      retry_count: retryCounter.value,
      duration_ms: Date.now() - start,
      request_meta: { ...last_meta, pages_fetched },
    };
  } catch (err) {
    const duration_ms = Date.now() - start;
    // Circuit breaker: record failure and potentially open the circuit
    if (activeConnector) {
      const newCount = activeConnector.circuit_failure_count + 1;
      if (newCount >= activeConnector.circuit_threshold) {
        void p.ctx.db
          .update(connectors)
          .set({
            circuit_state: "open",
            circuit_opened_at: new Date(),
            circuit_failure_count: newCount,
          })
          .where(eq(connectors.id, activeConnector.id));
      } else {
        void p.ctx.db
          .update(connectors)
          .set({ circuit_failure_count: newCount })
          .where(eq(connectors.id, activeConnector.id));
      }
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
    const e = err instanceof Error ? err : new Error(String(err));
    return {
      status: "failed",
      retry_count: retryCounter.value,
      duration_ms,
      error: {
        code: err instanceof RequestError ? err.cause_kind : "request_error",
        message: e.message,
      },
      request_meta: last_meta,
    };
  } finally {
    clearTimeout(timer);
  }
}
