import {
  AuthorityDispatchError,
  executePlannedHttpRequest,
  HttpRequestInvalidError,
  type RequestDispatchPolicy,
} from "../../../connectors/drivers/http.ts";
import {
  classifyConnectorHealth,
  connectorHealthHint,
  parseDeprecation,
} from "../../../connectors/health.ts";
import type { Db } from "../../../db/client.ts";
import { logger } from "../../../logging/logger.ts";
import { recordRequestRetry } from "../../../observability/instrumentation.ts";
import type { Clock } from "../../clock.ts";
import type { MaterializedRequest } from "../../prepared-request.ts";
import { RequestError } from "./errors.ts";
import {
  type RateLimitDeadlineScope,
  rateLimitDelayMs,
  rateLimitNow,
  rateLimitSleepOverride,
} from "./rate-limit.ts";
import { backoffMs, isIdempotent, parseRetryAfter, type RetryPolicy } from "./retry.ts";

export interface FetchAttemptResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  bytes_in: number;
  body_raw?: Buffer;
}

async function fetchOnce(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  tenant_id: string,
  db: Db,
  multipartBody?: FormData,
  captureBinary?: boolean,
  beforeDispatch?: (request: MaterializedRequest) => Promise<RequestDispatchPolicy | undefined>,
  signedJwt?: Parameters<typeof executePlannedHttpRequest>[0]["signed_jwt"],
): Promise<FetchAttemptResult> {
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
    exec: db,
    tenant_id,
    method,
    url: parsedUrl,
    headers,
    body,
    signal,
    ...(multipartBody !== undefined ? { multipartBody } : {}),
    ...(captureBinary ? { capture_binary: true } : {}),
    ...(beforeDispatch ? { before_dispatch: beforeDispatch } : {}),
    ...(signedJwt ? { signed_jwt: signedJwt } : {}),
  });
  return {
    status: execution.status,
    headers: execution.headers,
    body: execution.body,
    bytes_in: execution.bytes_in,
    ...(execution.body_raw !== undefined ? { body_raw: execution.body_raw } : {}),
  };
}

export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
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

export interface DoOnePageParams {
  clock: Clock;
  signed_jwt?: Parameters<typeof executePlannedHttpRequest>[0]["signed_jwt"];
  db: Db;
  before_dispatch?: (request: MaterializedRequest) => Promise<RequestDispatchPolicy | undefined>;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  multipartBody?: FormData;
  max_attempts: number;
  signal: AbortSignal;
  retry_total_ms: { value: number };
  retry_counter: { value: number };
  tenant_id: string;
  connector_id?: string | null;
  connector_slug?: string | null;
  retry_policy: RetryPolicy;
  retry_safe: boolean;
  accepted_statuses?: ReadonlySet<number>;
  idempotency_key_base?: string;
  last_idempotency_key?: { value: string | null };
  capture_binary?: boolean;
  deadline_ms: number;
  deadline_scope: RateLimitDeadlineScope;
}

function healthHintMeta(
  status: number,
  headers: Record<string, string>,
  opts: {
    slug?: string | null | undefined;
    url?: string | undefined;
    retry_after_s?: number | null | undefined;
    rate_limited?: boolean;
  },
): Record<string, unknown> | undefined {
  const health = opts.rate_limited ? "rate_limited" : classifyConnectorHealth(status, headers);
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
    ...(deprecation ? { deprecation } : {}),
  };
}

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

export async function doOnePage(p: DoOnePageParams): Promise<FetchAttemptResult> {
  let attempt = 0;
  let lastErr: unknown = null;
  while (attempt < p.max_attempts) {
    attempt += 1;
    if (attempt > 1) p.retry_counter.value += 1;
    if (p.signal.aborted) {
      throw new RequestError("aborted", "abort");
    }
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
        p.db,
        p.multipartBody,
        p.capture_binary,
        p.before_dispatch,
        p.signed_jwt,
      );
      if (res.status >= 400 && p.accepted_statuses?.has(res.status)) {
        return res;
      }
      if (res.status >= 200 && res.status < 400) {
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
      const rateLimit =
        res.status === 403 || res.status === 429
          ? rateLimitDelayMs({
              status: res.status,
              headers: res.headers,
              body: res.body,
              attempt,
              now_ms: rateLimitNow(),
              backoff_base_ms: p.retry_policy.backoff_base_ms,
              deadline_ms: p.deadline_ms,
            })
          : ({ kind: "none" } as const);
      if (rateLimit.kind !== "none") {
        const after = parseRetryAfter(res.headers["retry-after"] ?? null);
        const health_hint = healthHintMeta(res.status, res.headers, {
          slug: p.connector_slug,
          url: p.url,
          retry_after_s: after != null ? Math.round(after / 1000) : null,
          rate_limited: true,
        });
        if (rateLimit.kind === "fail" || (attempt >= p.max_attempts && res.status !== 429)) {
          logger.warn({
            module: "execution",
            action: "request.rate_limited",
            msg: `upstream rate limit outlasts the ${p.deadline_scope} deadline; stopping without further requests`,
            reason: rateLimit.reason,
            deadline_scope: p.deadline_scope,
            attempt_no: attempt,
            delay_ms: Math.round(rateLimit.delay_ms),
            status: res.status,
            connector_id: p.connector_id ?? null,
          });
          throw new RequestError(
            `upstream rate limit (http ${res.status}) does not reset before the ${p.deadline_scope} deadline; run the workflow again after the provider's reset time`,
            "upstream_rate_limited",
            res.status,
            { health_hint },
          );
        }
        if (attempt >= p.max_attempts) {
          throw new RequestError(`http 429`, "http_429", 429, {
            headers: res.headers,
            health_hint,
          });
        }
        const wait = rateLimit.delay_ms;
        logger.info({
          module: "execution",
          action: "request.retry",
          msg: `retrying after http ${res.status} rate limit in ${Math.round(wait)}ms`,
          reason: res.status === 429 ? "http_429" : "rate_limit",
          rate_limit_reason: rateLimit.reason,
          attempt_no: attempt,
          total_attempts: p.max_attempts,
          delay_ms: Math.round(wait),
          next_attempt_at: new Date(rateLimitNow() + wait).toISOString(),
          status: res.status,
          retry_after_header: after ?? null,
          connector_id: p.connector_id ?? null,
        });
        recordRequestRetry({
          connector_id: p.connector_id ?? null,
          reason: res.status === 429 ? "http_429" : "rate_limit",
        });
        p.retry_total_ms.value += wait;
        await (rateLimitSleepOverride() ?? sleep)(wait, p.signal);
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
          next_attempt_at: new Date(p.clock.now() + wait).toISOString(),
          status: res.status,
          connector_id: p.connector_id ?? null,
        });
        recordRequestRetry({ connector_id: p.connector_id ?? null, reason: "http_5xx" });
        await sleep(wait, p.signal);
        continue;
      }
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
          next_attempt_at: new Date(p.clock.now() + wait).toISOString(),
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
        throw new RequestError(err.message, "authority_invalid", undefined, {
          reason: "authority_redirect_denied",
        });
      if (err instanceof HttpRequestInvalidError) {
        throw new RequestError(err.message, "request_invalid", undefined, {
          path: err.path,
        });
      }
      if (err instanceof RequestError) {
        if (err.cause_kind === "http_4xx") throw err;
        if (err.cause_kind === "http_5xx") throw err;
        if (err.cause_kind === "abort") throw err;
        if (err.cause_kind === "filter_fail") throw err;
        if (err.cause_kind === "request_invalid") throw err;
        if (err.cause_kind === "authority_invalid") throw err;
        if (err.cause_kind === "timeout") throw err;
        if (err.cause_kind === "upstream_rate_limited") throw err;
        if (attempt >= p.max_attempts) throw err;
        continue;
      }
      const e = err as { message?: string };
      const klass = classifyTransportError(err, p.signal.aborted);
      if (klass === "abort") throw new RequestError("aborted", "abort");
      if (klass === "timeout") {
        throw new RequestError(e.message ?? "operation timed out", "timeout");
      }
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
        next_attempt_at: new Date(p.clock.now() + wait).toISOString(),
        error_message: e.message ?? null,
        connector_id: p.connector_id ?? null,
      });
      recordRequestRetry({ connector_id: p.connector_id ?? null, reason: "connection" });
      await sleep(wait, p.signal);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("request failed");
}
