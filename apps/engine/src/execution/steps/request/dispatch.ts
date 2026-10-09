import { and, eq } from "drizzle-orm";
import { auditAwait } from "../../../audit/audit.ts";
import { AuditAction } from "../../../audit/types.ts";
import { evaluateHook } from "../../../auth/hooks.ts";
import { persistCircuitState, recordCircuitFailure } from "../../../connectors/circuit-breaker.ts";
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
import { invokeMcpConnectorCall, mcpEgressInput } from "../../../connectors/drivers/mcp.ts";
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
import { clearReauthIfProved, flagConnectorAuthFailure } from "../../../connectors/reauth.ts";
import { getConnectorForEnvironment, isCircuitOpenBlocking } from "../../../connectors/service.ts";
import type { CredentialUseSnapshot } from "../../../credentials/index.ts";
import type { Db } from "../../../db/client.ts";
import { connectorEndpointSchemas } from "../../../db/schema/index.ts";
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
import {
  inspectContentRevisionRequest,
  inspectContentRevisionResponse,
} from "../../../workflows/content-publication-boundary.ts";
import {
  GMAIL_SEND_TARGET,
  inspectReportMessage,
  reportInspectionRecord,
} from "../../../workflows/report-delivery-boundary.ts";
import {
  describeRequestBoundaryViolation,
  requestBoundary,
  requestBoundaryViolation,
} from "../../../workflows/request-boundary.ts";
import {
  describeStorageKeyViolation,
  storageBaseUrl,
  storageBoundary,
  storageKeyViolation,
} from "../../../workflows/storage-boundary.ts";
import type { RequestStep } from "../../../workflows/types.ts";
import { combineSignals } from "../../abort.ts";
import { connectorStepRefusal } from "../../connector-availability.ts";
import { appendCredentialSnapshot } from "../../credential-snapshots.ts";
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
import { GOVERNANCE_REFUSALS } from "../../state.ts";
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
  requestFailureEvidence,
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

export const REQUEST_TIMEOUT_DEFAULT_MS = 60 * 60_000;

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
  if (connector.circuit_state !== "half-open" && connector.circuit_failure_count === 0) return;
  await persistCircuitState(db, connector, { circuit_state: "closed", circuit_failure_count: 0 });
}

interface FetchAttemptResult {
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
  multipartBody?: FormData,
  captureBinary?: boolean,
  beforeDispatch?: (request: MaterializedRequest) => Promise<RequestDispatchPolicy | undefined>,
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
}

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

async function doOnePage(p: DoOnePageParams): Promise<FetchAttemptResult> {
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
        p.multipartBody,
        p.capture_binary,
        p.before_dispatch,
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
  resolved_multipart?: ResolvedMultipartPart[];
  resolved_body_file?: ResolvedFile;
}

export async function runRequestStep(p: RunRequestStepParams): Promise<StepResult> {
  const dispatchedEffects: Array<"read" | "write"> = [];
  const result = await dispatchRequestStep(p, (effect) => {
    dispatchedEffects.push(effect);
  });
  if (!dispatchedEffects.length) return result;
  const metadata: RequestMeta = result.request_meta ?? { driver: "error", url: null };
  return {
    ...result,
    request_meta: {
      ...metadata,
      extras: {
        ...metadata.extras,
        effect_kind: dispatchedEffects.includes("write") ? "write" : "read",
      },
    },
  };
}

async function dispatchRequestStep(
  p: RunRequestStepParams,
  recordEffect: (effect: "read" | "write") => void,
): Promise<StepResult> {
  const start = Date.now();
  const referencedCredentials: CredentialUseSnapshot[] = [];
  const persistCredentialUse = async (snapshot?: CredentialUseSnapshot) => {
    const captured = [...referencedCredentials, ...(snapshot ? [snapshot] : [])];
    const unique = new Map(captured.map((entry) => [JSON.stringify(entry), entry]));
    for (const entry of unique.values())
      await appendCredentialSnapshot(
        p.ctx.db,
        p.ctx.tenant_id,
        p.ctx.execution_id,
        p.ctx.step_row_id,
        entry,
      );
  };
  const referencedAuthorities: ResolvedAuthorityReference[] = [
    ...(p.ctx.prepared_workflow_references ?? []),
  ];
  let configurationDigest = authorityConnectorDigest(null);
  let credentialSnapshot: Pick<
    ResolvedConnectorCredential,
    "credential_id" | "credential_revision" | "connection_authority" | "credential_snapshot"
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
  const governanceCode = (error: unknown): string | undefined => {
    if (!(error instanceof RequestError)) return undefined;
    const reason = error.meta?.reason;
    return typeof reason === "string" && GOVERNANCE_REFUSALS.has(reason) ? reason : undefined;
  };
  const beforeDispatch = async (credential = credentialSnapshot, request?: MaterializedRequest) => {
    try {
      const documentedRead = p.step.side_effects !== "write" && isDocumentedReadOperation(request);
      const policy = await p.ctx.before_external_request?.({
        ...authoritySnapshot(credential),
        ...(documentedRead ? { requires_review: false } : {}),
        ...(request ? { request } : {}),
      });
      await persistCredentialUse(credential.credential_snapshot);
      recordEffect(
        documentedRead
          ? "read"
          : classifyRequestStepSideEffects(p.step, activeConnector?.driver, request?.method),
      );
      return documentedRead ? { redirect: "manual" as const } : policy;
    } catch (error) {
      throw new RequestError(
        `Execution authority could not be verified: ${(error as { code?: string }).code ?? "authority_check_failed"}; review the current boundary.`,
        "authority_invalid",
        undefined,
        {
          reason: (error as { code?: string }).code ?? "authority_check_failed",
          ...(typeof (error as { reason?: unknown }).reason === "string"
            ? { refusal_reason: (error as { reason: string }).reason }
            : {}),
        },
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
          ...(report ? { report_delivery_inspection: reportInspectionRecord(report) } : {}),
          ...(report?.ok ? { report_delivery_proposal: report.boundary } : {}),
          ...(contentRevision ? { content_revision_proposal: contentRevision } : {}),
        },
      },
    });
  };
  const requestIsReadOnly = classifyRequestStepSideEffects(p.step) === "read";
  let holdThisStep = p.ctx.hold_writes === true && requestRequiresPreparationHold(p.step);
  const max_attempts = requestMaxAttempts(p.step);
  const timeoutMs = p.step.timeout_ms ?? REQUEST_TIMEOUT_DEFAULT_MS;
  const timeoutCtrl = new AbortController();

  const resolvedScope = await resolveScopeForJsonata(
    p.ctx.db,
    p.ctx.tenant_id,
    p.scope,
    p.ctx.signal,
  );

  const timer = setTimeout(() => timeoutCtrl.abort("timeout"), timeoutMs);
  const signal = combineSignals([p.ctx.signal, timeoutCtrl.signal]);

  const resolverCtx = {
    onCredentialUse: (snapshot: CredentialUseSnapshot) => {
      referencedCredentials.push(snapshot);
    },
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
  const bodyRes =
    p.step.body !== undefined && p.step.body !== null
      ? await resolvePlaceholdersTypePreserving(p.step.body, resolverCtx)
      : null;
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
  const s3KeyRes = p.step.s3?.key
    ? await resolveStringPlaceholders(p.step.s3.key, resolverCtx)
    : null;
  const s3PrefixRes = p.step.s3?.prefix
    ? await resolveStringPlaceholders(p.step.s3.prefix, resolverCtx)
    : null;
  const resolvedS3Key = s3KeyRes?.value ?? p.step.s3?.key;
  const resolvedS3Prefix = s3PrefixRes?.value ?? p.step.s3?.prefix;
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

  const headers: Record<string, string> = { ...resolvedStepHeaders };
  if (xmlContentTypeSet) {
    const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === "content-type");
    if (!hasContentType) headers["Content-Type"] = "application/xml";
  }
  const query: Record<string, string | number | boolean> = { ...resolvedStepQuery };
  let baseUrl: URL;
  let activeConnector: Awaited<ReturnType<typeof getConnectorForEnvironment>> = null;
  let activeCredentialId: string | null = null;
  let storedCredentialUsed = false;
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
        auth_method: deriveAuthMethodFromAuthType(connector.auth_type),
        base_url: connector.base_url ?? null,
      };
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
        } catch {}
      }
      const refusal = connectorStepRefusal(connector, p.step, p.ctx.execution_mode);
      if (refusal) {
        clearTimeout(timer);
        return {
          status: "failed",
          retry_count: 0,
          duration_ms: Date.now() - start,
          error: refusal,
        };
      }
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
          if (Object.keys(resolvedStepHeaders).length > 0) {
            args.extra_headers = resolvedStepHeaders;
          }
          const cfg = (connector.config ?? {}) as { endpoint?: unknown };
          const endpointUrl =
            typeof cfg.endpoint === "string" && cfg.endpoint.length > 0
              ? cfg.endpoint
              : (connector.base_url ?? null);
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
            attempt: () =>
              withEgressAudit(
                mcpEgressInput({
                  executor: p.ctx.db,
                  tenant_id: p.ctx.tenant_id,
                  actor_id: p.ctx.principal?.id ?? null,
                  actor_type:
                    p.ctx.principal?.kind === "system_account" ? "system_account" : "user",
                  connector: {
                    id: connector.id,
                    slug: connector.slug,
                    url: connector.base_url ?? null,
                  },
                  call,
                  source: "execution",
                  execution_id: p.ctx.execution_id,
                  workflow_id: p.ctx.workflow_id,
                  step_id: p.step.id,
                }),
                () =>
                  invokeMcpConnectorCall({
                    on_dispatch: () => recordEffect(classifyRequestStepSideEffects(p.step)),
                    on_credential_use: persistCredentialUse,
                    db: p.ctx.db,
                    tenant_id: p.ctx.tenant_id,
                    actor_id: p.ctx.principal?.id ?? null,
                    connector,
                    call,
                    requestSource: p.ctx.request_source,
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
          await recordDriverOutcome(p.ctx.db, connector, mcpEvidence(result));
          if (result.status === "succeeded") {
            await clearReauthIfProved(p.ctx.db, connector, {
              status: 200,
              health: "ok",
              stored_credential_used: true,
            });
          }
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
        const connectorMeta = connectorResolution as ConnectorResolutionSummary;
        try {
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
            on_credential_use: async (snapshot) => {
              await persistCredentialUse(snapshot);
              recordEffect(classifyRequestStepSideEffects(p.step, activeConnector?.driver));
            },
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
          if (s3Spec?.scope) {
            const declared = storageBoundary(p.step, storageBaseUrl(connector.config));
            if (!declared)
              return {
                status: "failed",
                retry_count: 0,
                duration_ms: Date.now() - start,
                error: {
                  code: "request_outside_declared_boundary",
                  message: "The declared storage scope cannot be enforced. Nothing was sent.",
                },
              };
            const violation = storageKeyViolation(
              declared,
              reqPath.replace(/^\//, ""),
              params.body ?? null,
              p.ctx.caller_context ?? null,
            );
            if (violation)
              return {
                status: "failed",
                retry_count: 0,
                duration_ms: Date.now() - start,
                error: {
                  code: "request_outside_declared_boundary",
                  message:
                    `This request is outside the folder boundary its step declares: ${describeStorageKeyViolation(violation)}. ` +
                    "Nothing was sent. Correct `s3.scope` on this step so it covers every key and the " +
                    "largest content the workflow can produce; do not remove the scope and do not " +
                    "widen it to the whole bucket.",
                },
                request_meta: {
                  driver: "s3",
                  method,
                  refused: true,
                  key: reqPath.replace(/^\//, ""),
                  ...(typeof params.body === "string"
                    ? { bytes_out: new TextEncoder().encode(params.body).byteLength }
                    : {}),
                  connector: connectorMeta,
                },
              };
          }
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
              credential_id: null,
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
            } catch {}
          }

          await recordDriverOutcome(p.ctx.db, connector, evidenceFromStatus(res.status));
          await clearReauthIfProved(p.ctx.db, connector, {
            status: res.status,
            health: classifyConnectorHealth(res.status, res.headers),
            stored_credential_used: true,
          });

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
              ...(typeof params.body === "string"
                ? { bytes_out: new TextEncoder().encode(params.body).byteLength }
                : {}),
              connector: connectorMeta,
            },
          };
        } catch (err) {
          await recordDriverOutcome(p.ctx.db, connector, evidenceFromThrow(err));
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
          const sqlBlock = p.step.sql;
          const useTransaction =
            sqlBlock.transaction === true ||
            (sqlBlock.also !== undefined && sqlBlock.also.length > 0);
          const cursor = sqlBlock.cursor;
          const useCursor = cursor !== undefined;

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
              const stepLevelExpectation = p.step.expected_row_count;
              const tx = await pgTransaction({
                on_credential_use: async () => {
                  await persistCredentialUse({
                    connector_id: connector.id,
                    environment: connector.environment,
                    credential_id: null,
                    credential_generation: null,
                    connection_id: null,
                    access_token_version: null,
                    identity: null,
                  });
                  recordEffect(classifyRequestStepSideEffects(p.step, activeConnector?.driver));
                },
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
                on_credential_use: async () => {
                  await persistCredentialUse({
                    connector_id: connector.id,
                    environment: connector.environment,
                    credential_id: null,
                    credential_generation: null,
                    connection_id: null,
                    access_token_version: null,
                    identity: null,
                  });
                  recordEffect(classifyRequestStepSideEffects(p.step, activeConnector?.driver));
                },
                connector,
                sql: sqlBlock.query,
                params: resolvedSqlParams ?? [],
                fetch_size: cursor.fetch_size,
              });
              return { output: rows, rowCount: Array.isArray(rows) ? rows.length : null };
            }
            const res = await pgQueryWithCount({
              on_credential_use: async () => {
                await persistCredentialUse({
                  connector_id: connector.id,
                  environment: connector.environment,
                  credential_id: null,
                  credential_generation: null,
                  connection_id: null,
                  access_token_version: null,
                  identity: null,
                });
                recordEffect(classifyRequestStepSideEffects(p.step, activeConnector?.driver));
              },
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
          } catch {}

          await recordDriverOutcome(p.ctx.db, connector, "answered");
          await clearReauthIfProved(p.ctx.db, connector, {
            status: 200,
            health: "ok",
            stored_credential_used: true,
          });

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
            message: `request step has no dispatch path for connector driver '${connector.driver}'`,
          },
        };
      }
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
      storedCredentialUsed = plan.stored_credential_used;
      activeCredentialId = plan.credential_id;
      credentialSnapshot = {
        ...(plan.credential_snapshot ? { credential_snapshot: plan.credential_snapshot } : {}),
        credential_id: plan.credential_id,
        credential_revision: plan.credential_revision,
        connection_authority: plan.connection_authority ?? null,
      };
      for (const [k, v] of Object.entries(plan.headers)) {
        headers[k] = v;
      }
      if (connectorResolution) {
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
      clearTimeout(timer);
      return {
        status: "failed",
        retry_count: 0,
        duration_ms: Date.now() - start,
        error: buildStepErrorDetail({ code: "hook_error", err }),
      };
    }
  }

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
  const idempotencyBase =
    requestIsReadOnly || isIdempotent(p.step.method)
      ? null
      : `${p.ctx.execution_id}:${p.ctx.step_row_id}`;
  const lastIdempotencyKey: { value: string | null } = { value: null };
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

  let inFlightCheckpoint: Promise<void> | null = null;
  try {
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
        void clearReauthIfProved(p.ctx.db, activeConnector, {
          status: res.status,
          health: classifyConnectorHealth(res.status, res.headers),
          stored_credential_used: storedCredentialUsed,
          body,
        });
      }
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
        } catch {}
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
      const sentBytes =
        heldRequestBody === undefined || heldRequestBody === null
          ? undefined
          : new TextEncoder().encode(
              typeof heldRequestBody === "string"
                ? heldRequestBody
                : JSON.stringify(heldRequestBody),
            ).byteLength;
      last_meta = connectorResolution
        ? {
            driver: "http",
            url: baseUrl.toString(),
            method: p.step.method ?? "GET",
            status: res.status,
            bytes_in: res.bytes_in,
            ...(sentBytes === undefined ? {} : { bytes_out: sentBytes }),
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
            ...(sentBytes === undefined ? {} : { bytes_out: sentBytes }),
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
    const ACC_BYTE_CAP = 64 * 1024 * 1024;
    let accBytes = 0;
    let lastPageHeaders: Record<string, string> = {};
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
      void clearReauthIfProved(p.ctx.db, activeConnector, {
        status: 200,
        health: classifyConnectorHealth(200, lastPageHeaders),
        stored_credential_used: storedCredentialUsed,
      });
    }
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
      } catch {}
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
    if (inFlightCheckpoint) {
      try {
        await inFlightCheckpoint;
      } catch {}
    }
    if (activeConnector) {
      await recordDriverOutcome(
        p.ctx.db,
        activeConnector,
        requestFailureEvidence(err, timeoutCtrl.signal.aborted && !p.ctx.signal.aborted),
      );
    }
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
        code:
          governanceCode(err) ?? (err instanceof RequestError ? err.cause_kind : "request_error"),
        err,
        request_meta: last_meta,
      }),
      request_meta: last_meta,
    };
  } finally {
    clearTimeout(timer);
  }
}
