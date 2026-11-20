import { and, eq } from "drizzle-orm";
import { evaluateHook } from "../../../../auth/hooks.ts";
import { buildMultipartBody, buildRequestPlan } from "../../../../connectors/drivers/http.ts";
import {
  multipartObservationHeaders,
  prepareMultipartBody,
} from "../../../../connectors/drivers/http-multipart.ts";
import { flagConnectorContractFailure } from "../../../../connectors/health-state.ts";
import { flagConnectorAuthFailure } from "../../../../connectors/reauth.ts";
import { connectorMaskedQueryKeys } from "../../../../connectors/recorded-url.ts";
import { connectorEndpointSchemas } from "../../../../db/schema/index.ts";
import { logger } from "../../../../logging/logger.ts";
import { inspectContentRevisionRequest } from "../../../../workflows/content-publication-boundary.ts";
import {
  GMAIL_SEND_TARGET,
  inspectReportMessage,
  reportInspectionRecord,
} from "../../../../workflows/report-delivery-boundary.ts";
import {
  type ConnectorQuery,
  connectorQueryOf,
  describePagedBodyViolation,
  describeRequestBoundaryViolation,
  pagedBodyGuard,
  requestBoundary,
  requestBoundaryViolation,
} from "../../../../workflows/request-boundary.ts";
import { makeStrategy, type PaginationSpec } from "../../../pagination.ts";
import {
  type MaterializedRequest,
  preparedRequestProof,
  preparedRequestReview,
} from "../../../prepared-request.ts";
import { GOVERNANCE_REFUSALS } from "../../../state.ts";
import type { RequestMeta, StepResult } from "../../../types.ts";
import { buildStepErrorDetail } from "../../error-detail.ts";
import { requestFailureEvidence } from "../circuit-evidence.ts";
import { RequestError } from "../errors.ts";
import type { DoOnePageParams } from "../http-attempt.ts";
import { redactOwnCredentials } from "../own-credentials.ts";
import { isDocumentedReadOperation } from "../read-operations.ts";
import { isIdempotent, resolveRetryPolicy } from "../retry.ts";
import { checkRequired } from "../shape.ts";
import {
  classifyRequestStepSideEffects,
  type HeldStepResultParams,
  heldStepResult,
  requestRequiresPreparationHold,
} from "../side-effects.ts";
import {
  failedStep,
  type RequestConnector,
  type RequestDispatch,
  type RequestStepDriver,
  recordDriverOutcome,
  setupFailure,
} from "./context.ts";
import {
  type HttpExchange,
  materializePaginatedBody,
  recordedUrl,
  requestIsReadOnly,
} from "./http-exchange.ts";
import { runHttpPages } from "./http-pages.ts";
import { runHttpSinglePage } from "./http-single.ts";

function sameOrigin(url: URL, baseUrl: string | null): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).origin === url.origin;
  } catch {
    return false;
  }
}

type Prepared = { result: StepResult } | { exchange: HttpExchange };

interface HttpTarget {
  base_url: URL;
  active_credential_id: string | null;
  signed_jwt: DoOnePageParams["signed_jwt"];
  stored_credential_used: boolean;
  connector_query: ConnectorQuery | null;
  masked_query_keys: string[];
}

async function connectorTarget(
  d: RequestDispatch,
  connector: RequestConnector,
): Promise<HttpTarget | { result: StepResult }> {
  const { p } = d;
  d.state.activeConnector = connector;
  const plan = await buildRequestPlan({
    db: p.ctx.db,
    tenant_id: p.ctx.tenant_id,
    connector,
    path_or_url: d.parts.path ?? d.parts.url ?? "/",
    headers: d.parts.headers,
    query: d.parts.query,
    ...(d.own_credentials.length > 0
      ? { redact_log_url: (url: string) => redactOwnCredentials(url, d.own_credentials) }
      : {}),
  });
  if (
    d.own_credentials.length > 0 &&
    (connector.id !== d.own_connector?.id || !sameOrigin(plan.url, connector.base_url))
  ) {
    return {
      result: failedStep(d, {
        code: "credential_boundary_violation",
        message:
          "the request carries the connector's own credential and may only go to the connector's base_url origin",
      }),
    };
  }
  d.state.credentialSnapshot = {
    ...(plan.credential_snapshot ? { credential_snapshot: plan.credential_snapshot } : {}),
    credential_id: plan.credential_id,
    credential_revision: plan.credential_revision,
    connection_authority: plan.connection_authority ?? null,
  };
  for (const [k, v] of Object.entries(plan.headers)) {
    d.parts.headers[k] = v;
  }
  if (d.connector_resolution) {
    d.connector_resolution.auth_method = plan.auth_method;
  }
  return {
    base_url: plan.url,
    active_credential_id: plan.credential_id,
    signed_jwt:
      plan.credential?.mode === "signed_jwt"
        ? { connector, credential: plan.credential }
        : undefined,
    stored_credential_used: plan.stored_credential_used,
    connector_query: connectorQueryOf(
      (connector.config as { static_query?: unknown } | null | undefined)?.static_query,
      plan.credential?.mode === "query" ? Object.keys(plan.credential.query) : [],
    ),
    masked_query_keys: connectorMaskedQueryKeys(connector.config, plan.credential),
  };
}

async function resolveTarget(d: RequestDispatch): Promise<HttpTarget | { result: StepResult }> {
  try {
    if (d.connector) return await connectorTarget(d, d.connector);
    if (!d.parts.url) {
      return {
        result: failedStep(d, {
          code: "missing_url",
          message: "request step requires url or connector_id",
        }),
      };
    }
    const base_url = new URL(d.parts.url);
    for (const [k, v] of Object.entries(d.parts.query)) {
      base_url.searchParams.set(k, String(v));
    }
    return {
      base_url,
      active_credential_id: null,
      signed_jwt: undefined,
      stored_credential_used: false,
      connector_query: connectorQueryOf(undefined, []),
      masked_query_keys: [],
    };
  } catch (err) {
    return { result: setupFailure(d, err) };
  }
}

async function policyHookRefusal(
  d: RequestDispatch,
  baseUrl: URL,
  maskedQueryKeys: readonly string[],
): Promise<StepResult | null> {
  const { p } = d;
  if (!p.ctx.principal) return null;
  try {
    const decision = await evaluateHook({
      db: p.ctx.db,
      tenant_id: p.ctx.tenant_id,
      principal: p.ctx.principal,
      requestCtx: {
        method: p.step.method,
        url: baseUrl.toString(),
        recorded_url: recordedUrl(baseUrl, maskedQueryKeys),
        headers: d.parts.headers,
        body: d.parts.body ?? null,
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
      return failedStep(d, {
        code: "policy.denied",
        message: decision.reason ?? "before-request hook denied",
        details: decision.hook_id ? { hook_id: decision.hook_id } : undefined,
      });
    }
    return null;
  } catch (err) {
    return failedStep(d, buildStepErrorDetail({ code: "hook_error", err }));
  }
}

async function endpointRegistryRow(d: RequestDispatch) {
  const { p } = d;
  const activeConnector = d.state.activeConnector;
  if (!activeConnector || !p.step.path) return null;
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
  return rows[0] ?? null;
}

function httpBeforeDispatch(x: HttpExchange) {
  const { d } = x;
  return async (request: MaterializedRequest) => {
    if (
      d.p.ctx.hold_writes &&
      requestRequiresPreparationHold(
        d.p.step,
        d.state.activeConnector?.driver,
        d.state.activeConnector?.base_url,
      ) &&
      (d.p.step.side_effects === "write" || !isDocumentedReadOperation(request))
    ) {
      throw new RequestError(
        "Preview request is no longer a supported read operation",
        "authority_invalid",
      );
    }
    const paging = x.paged_body_guard?.(request.body);
    if (paging)
      throw new RequestError(
        `This request is outside the boundary its step declares: ${describePagedBodyViolation(paging)}. Nothing was sent.`,
        "authority_invalid",
        undefined,
        { reason: "request_outside_declared_boundary" },
      );
    const key = request.headers["Idempotency-Key"];
    const idempotencyBase = x.idempotency_base;
    const suffix =
      idempotencyBase && key?.startsWith(`${idempotencyBase}:`)
        ? key.slice(idempotencyBase.length + 1)
        : null;
    const policy = await d.before_dispatch(d.state.credentialSnapshot, {
      ...request,
      ...(key !== undefined && suffix !== null && /^(0|[1-9][0-9]*)$/.test(suffix)
        ? { generated_idempotency: { key, page: Number(suffix) } }
        : {}),
    });
    x.last_request = request;
    return d.own_credentials.length > 0 ? { redirect: "manual" as const } : policy;
  };
}

function heldHttpResult(
  d: RequestDispatch,
  idempotencyBase: string | null,
  preparedMultipart: Awaited<ReturnType<typeof prepareMultipartBody>> | undefined,
  maskedQueryKeys: readonly string[],
  held: HeldStepResultParams,
): StepResult {
  const { p } = d;
  const proof = held.url
    ? preparedRequestProof(
        p.ctx.tenant_id,
        d.authority_snapshot(),
        {
          method: held.method,
          url: held.url,
          headers: {
            ...(preparedMultipart ? multipartObservationHeaders(held.headers ?? {}) : held.headers),
            ...(idempotencyBase ? { "Idempotency-Key": `${idempotencyBase}:0` } : {}),
          },
          body: held.body,
          ...(preparedMultipart ? preparedMultipart.observation : {}),
          ...(idempotencyBase
            ? { generated_idempotency: { key: `${idempotencyBase}:0`, page: 0 } }
            : {}),
          ...(p.resolved_body_file ? { unsupported_body: true } : {}),
        },
        d.max_attempts,
      )
    : null;
  const review =
    proof && held.url
      ? preparedRequestReview({
          method: held.method,
          url: recordedUrl(held.url, maskedQueryKeys),
          headers: preparedMultipart
            ? multipartObservationHeaders(held.headers ?? {})
            : (held.headers ?? {}),
          body: held.body,
          ...(preparedMultipart ? preparedMultipart.observation : {}),
        })
      : null;
  const metadata = held.request_meta ?? {
    driver: "connectorless" as const,
    method: held.method,
    url: held.url ? recordedUrl(held.url, maskedQueryKeys) : held.url,
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
    url: held.url ? recordedUrl(held.url, maskedQueryKeys) : held.url,
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
}

async function prepareHttp(d: RequestDispatch): Promise<Prepared> {
  const { p } = d;
  const target = await resolveTarget(d);
  if ("result" in target) return target;
  const baseUrl = target.base_url;
  const refusal = await policyHookRefusal(d, baseUrl, target.masked_query_keys);
  if (refusal) return { result: refusal };

  const registryRow = await endpointRegistryRow(d);
  const headers = d.parts.headers;
  const query = d.parts.query;
  const resolvedStepBody = d.parts.body;
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

  const idempotencyBase =
    requestIsReadOnly(d) ||
    isIdempotent(p.step.method) ||
    Object.keys(headers).some((name) => name.toLowerCase() === "idempotency-key")
      ? null
      : `${p.ctx.execution_id}:${p.ctx.step_row_id}`;
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
  const meta: RequestMeta = d.connector_resolution
    ? {
        driver: "http",
        url: recordedUrl(baseUrl, target.masked_query_keys),
        method: p.step.method ?? "GET",
        connector: d.connector_resolution,
        digest,
      }
    : {
        driver: "connectorless",
        url: recordedUrl(baseUrl, target.masked_query_keys),
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
      return {
        result: failedStep(d, {
          code: "request_body_schema_violation",
          message: bodyErrs.join("; "),
        }),
      };
    }
  }

  let multipartFormData: FormData | undefined;
  let preparedMultipart: Awaited<ReturnType<typeof prepareMultipartBody>> | undefined;
  if (p.resolved_multipart && p.resolved_multipart.length > 0) {
    multipartFormData = await buildMultipartBody(p.resolved_multipart);
    preparedMultipart = await prepareMultipartBody(multipartFormData);
  }
  const declared = p.step.boundary
    ? requestBoundary(p.step, d.state.activeConnector?.base_url ?? null, target.connector_query)
    : null;
  if (p.step.boundary) {
    const violation = declared
      ? requestBoundaryViolation(declared, {
          method: p.step.method ?? "GET",
          url: heldRequestUrl,
          headers: preparedMultipart ? multipartObservationHeaders(headers) : headers,
          body: (heldRequestBody ?? null) as MaterializedRequest["body"],
          ...(preparedMultipart ? preparedMultipart.observation : {}),
          ...(p.resolved_body_file ? { unsupported_body: true } : {}),
        })
      : null;
    if (violation) {
      return {
        result: failedStep(d, {
          code: "request_outside_declared_boundary",
          message:
            `This request is outside the boundary its step declares: ${describeRequestBoundaryViolation(violation)}. ` +
            "Nothing was sent. Correct `boundary` on this step so it covers the largest request the " +
            "workflow's own limits allow, or tighten those limits; do not remove the boundary.",
        }),
      };
    }
  }

  if (
    d.state.holdThisStep &&
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
    d.state.holdThisStep = false;
  if (d.state.holdThisStep) {
    return {
      result: heldHttpResult(d, idempotencyBase, preparedMultipart, target.masked_query_keys, {
        start: d.start,
        clock: d.clock,
        method: p.step.method ?? "GET",
        url: heldRequestUrl,
        headers,
        body: heldRequestBody ?? null,
        request_meta: { ...meta, extras: { ...(meta.extras ?? {}), held: true } },
      }),
    };
  }

  const exchange: HttpExchange = {
    d,
    base_url: baseUrl,
    headers,
    query,
    active_credential_id: target.active_credential_id,
    signed_jwt: target.signed_jwt,
    stored_credential_used: target.stored_credential_used,
    body_schema: effectiveBodySchema,
    response_schema: effectiveResponseSchema,
    expected_statuses: effectiveExpectedStatuses,
    retry_total: { value: 0 },
    retry_counter: { value: 0 },
    idempotency_base: idempotencyBase,
    last_idempotency_key: { value: null },
    digest,
    meta,
    held_body: heldRequestBody,
    multipart: multipartFormData,
    last_request: undefined,
    in_flight_checkpoint: null,
    paged_body_guard: declared ? pagedBodyGuard(declared) : null,
    masked_query_keys: target.masked_query_keys,
    before_dispatch: async () => undefined,
  };
  exchange.before_dispatch = httpBeforeDispatch(exchange);
  return { exchange };
}

function governanceCode(error: unknown): string | undefined {
  if (!(error instanceof RequestError)) return undefined;
  const reason = error.meta?.reason;
  return typeof reason === "string" && GOVERNANCE_REFUSALS.has(reason) ? reason : undefined;
}

async function httpFailure(x: HttpExchange, err: unknown): Promise<StepResult> {
  const { d } = x;
  const { p } = d;
  const duration_ms = d.clock.now() - d.start;
  if (x.in_flight_checkpoint) {
    try {
      await x.in_flight_checkpoint;
    } catch {}
  }
  const activeConnector = d.state.activeConnector;
  if (activeConnector) {
    await recordDriverOutcome(
      p.ctx.db,
      activeConnector,
      requestFailureEvidence(err, d.timeout_ctrl.signal.aborted && !p.ctx.signal.aborted),
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
  const timedOut = {
    status: "timed_out" as const,
    retry_count: x.retry_counter.value,
    duration_ms,
    error: { code: "step_timeout", message: `request exceeded ${d.timeout_ms}ms` },
    request_meta: x.meta,
  };
  if (err instanceof RequestError && err.cause_kind === "abort") {
    if (d.timeout_ctrl.signal.aborted && !p.ctx.signal.aborted) return timedOut;
    return {
      status: "aborted",
      retry_count: x.retry_counter.value,
      duration_ms,
      error: { code: "aborted", message: "execution aborted" },
      request_meta: x.meta,
    };
  }
  if (err instanceof RequestError && err.cause_kind === "timeout") return timedOut;
  return {
    status: "failed",
    retry_count: x.retry_counter.value,
    duration_ms,
    error: buildStepErrorDetail({
      code: governanceCode(err) ?? (err instanceof RequestError ? err.cause_kind : "request_error"),
      err,
      request_meta: x.meta,
    }),
    request_meta: x.meta,
  };
}

async function runHttp(d: RequestDispatch, paged: boolean): Promise<StepResult> {
  const prepared = await prepareHttp(d);
  if ("result" in prepared) return prepared.result;
  const x = prepared.exchange;
  try {
    return paged ? await runHttpPages(x) : await runHttpSinglePage(x);
  } catch (err) {
    return httpFailure(x, err);
  }
}

export const httpRequestDriver: RequestStepDriver & { readonly kind: "http" } = {
  kind: "http",
  capabilities: {
    retry: "http_status",
    pagination: "http_strategy",
    response_filters: "page",
    circuit_close: "success",
    step_timer: true,
    owns_setup_errors: true,
    failure_code: "request_error",
  },
  retryPolicy: resolveRetryPolicy,
  classifySideEffects: (step, method, baseUrl) =>
    classifyRequestStepSideEffects(step, "http", method, baseUrl),
  execute: (d) => runHttp(d, false),
  paginate: (d) => runHttp(d, true),
};
