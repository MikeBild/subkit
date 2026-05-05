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
import { auditAwait } from "../../../audit/audit.ts";
import { AuditAction } from "../../../audit/types.ts";
import { evaluateHook } from "../../../auth/hooks.ts";
import { query as graphqlQuery } from "../../../connectors/drivers/graphql.ts";
import {
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
import { getConnectorForEnvironment } from "../../../connectors/service.ts";
import { connectorEndpointSchemas, connectors } from "../../../db/schema/index.ts";
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

export const REQUEST_TIMEOUT_DEFAULT_MS = 60 * 60_000; // 1h

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
    tenant_id: tunnel?.tenant_id ?? "",
    method,
    url: parsedUrl,
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
  /** When set on a non-idempotent method, an `Idempotency-Key` header is
   *  injected per attempt as `${base}:${attempt}` so each retry is a fresh
   *  key. The latest emitted key is returned via `last_idempotency_key`. */
  idempotency_key_base?: string;
  /** Out-param: the most recent Idempotency-Key emitted by this call. The
   *  request step copies the value into `request_meta.idempotency_key` for
   *  audit. Stays null when no key was emitted (GET / HEAD / OPTIONS). */
  last_idempotency_key?: { value: string | null };
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
      const res = await fetchOnce(p.url, p.method, attemptHeaders, p.body, p.signal, p.tunnel);
      if (res.status >= 200 && res.status < 400) return res;
      const is_additional_retry_status = p.retry_policy.additional_retry_statuses.has(res.status);
      // Reference-aligned retry telemetry: every retry emits the
      // same shape — `attempt_no`, `total_attempts`, `delay_ms`,
      // `next_attempt_at`, plus the typed `reason`. Lets an
      // operator grep `action: "request.retry"` and reconstruct
      // the entire backoff timeline without parsing free-form
      // messages. Mirrors the reference impl's per-attempt logs.
      if (res.status === 429) {
        const after = parseRetryAfter(res.headers["retry-after"] ?? null);
        const wait = Math.min(
          after ?? backoffMs(attempt, p.retry_policy.backoff_base_ms),
          60 * 60_000,
        );
        if (attempt >= p.max_attempts) {
          throw new RequestError(`http 429`, "http_429", 429, { headers: res.headers });
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
          throw new RequestError(`http ${res.status}`, "http_5xx", res.status);
        }
        if (attempt >= p.max_attempts) {
          throw new RequestError(`http ${res.status}`, "http_5xx", res.status);
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
          throw new RequestError(`http ${res.status}`, "http_4xx", res.status, { body: res.body });
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
      throw new RequestError(`http ${res.status}`, "http_4xx", res.status, { body: res.body });
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

  // Substitute `${item.…}`, `${scope.<step>.…}`, `${input.…}`,
  // `${cred.…}`, `${connector.…}` against the live execution scope BEFORE
  // the HTTP driver builds the request. Without this, a literal token like
  // `${item.id}` flows into `new URL()` and ends up URL-encoded as
  // `%24%7Bitem.id%7D`, causing the API to 404 on a non-existent id.
  const resolverCtx = {
    tenant_id: p.ctx.tenant_id,
    environment: p.ctx.execution_mode,
    db: p.ctx.db,
    input: p.scope?.$input,
    scope: p.scope,
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
  let tunnelRoute: TunnelRoute | undefined;
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
          // Update connectorResolution with the actually-applied auth method
          // (may be `oauth2_refreshed` if the driver rotated a stale token).
          connectorResolution = {
            ...connectorResolution,
            auth_method: res.auth_method,
          };
          return {
            status: res.status >= 200 && res.status < 300 ? "succeeded" : "failed",
            output: res.body,
            retry_count: 0,
            duration_ms: Date.now() - start,
            request_meta: {
              driver: "graphql",
              method: "POST",
              status: res.status,
              connector: connectorResolution,
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
          const res = await withEgressAudit(
            {
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
      if (plan.tunnel_target) {
        tunnelRoute = { tenant_id: p.ctx.tenant_id, target: plan.tunnel_target };
        if (connectorResolution) connectorResolution.tunnel_target = plan.tunnel_target;
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
    return {
      status: "failed",
      retry_count: 0,
      duration_ms: Date.now() - start,
      error: buildStepErrorDetail({ code: "request_setup_error", err }),
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
      const callDoOnePage = () =>
        doOnePage({
          url: baseUrl.toString(),
          method: p.step.method,
          headers,
          body: resolvedStepBody ?? null,
          max_attempts,
          signal,
          retry_total_ms: retryTotal,
          retry_counter: retryCounter,
          connector_id: p.step.connector_id ?? null,
          retry_policy,
          last_idempotency_key: lastIdempotencyKey,
          ...(idempotencyBase ? { idempotency_key_base: idempotencyBase } : {}),
          ...(tunnelRoute ? { tunnel: tunnelRoute } : {}),
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
        void p.ctx.db
          .update(connectors)
          .set({ circuit_state: "closed", circuit_failure_count: 0 })
          .where(eq(connectors.id, activeConnector.id));
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
      const existing = await readPaginationCheckpoint(p.ctx.step_row_id, p.ctx.db);
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
    // Local mirror of the most recently issued checkpoint write. Carried
    // forward into `last_meta` so the failure path persists the resume
    // position even though the actual write to the row is fire-and-forget.
    let latestCheckpoint: PaginationCheckpoint | null = null;
    while (pageIdx < MAX_PAGES) {
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
          retry_policy,
          last_idempotency_key: lastIdempotencyKey,
          ...(idempotencyBase ? { idempotency_key_base: idempotencyBase } : {}),
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
    return {
      status: "succeeded",
      output: acc,
      retry_count: retryCounter.value,
      duration_ms: Date.now() - start,
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
