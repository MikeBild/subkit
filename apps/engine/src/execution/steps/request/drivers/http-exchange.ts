import { parseDeprecation } from "../../../../connectors/health.ts";
import {
  clearConnectorHealthOnSuccess,
  flagConnectorContractFailure,
} from "../../../../connectors/health-state.ts";
import { clearReauthIfProved } from "../../../../connectors/reauth.ts";
import { logger } from "../../../../logging/logger.ts";
import { recordSuccessShape } from "../../../../schema-versions/service.ts";
import type { pagedBodyGuard } from "../../../../workflows/request-boundary.ts";
import type { MaterializedRequest } from "../../../prepared-request.ts";
import type { RequestMeta } from "../../../types.ts";
import { RequestError } from "../errors.ts";
import type { DoOnePageParams } from "../http-attempt.ts";
import { resolveRetryPolicy } from "../retry.ts";
import { classifyRequestStepSideEffects } from "../side-effects.ts";
import { type RequestDispatch, recordDriverOutcome } from "./context.ts";

export { recordedUrl } from "../../../../connectors/recorded-url.ts";

export interface HttpExchange {
  d: RequestDispatch;
  base_url: URL;
  headers: Record<string, string>;
  query: Record<string, string | number | boolean>;
  active_credential_id: string | null;
  signed_jwt: DoOnePageParams["signed_jwt"];
  stored_credential_used: boolean;
  body_schema: Record<string, unknown> | null;
  response_schema: Record<string, unknown> | null;
  expected_statuses: number[] | null;
  retry_total: { value: number };
  retry_counter: { value: number };
  idempotency_base: string | null;
  last_idempotency_key: { value: string | null };
  digest: { header_keys: string[]; query_keys: string[]; body_kind: string };
  meta: RequestMeta;
  held_body: unknown;
  multipart: FormData | undefined;
  last_request: MaterializedRequest | undefined;
  in_flight_checkpoint: Promise<void> | null;
  paged_body_guard: ReturnType<typeof pagedBodyGuard>;
  masked_query_keys: readonly string[];
  before_dispatch: (request: MaterializedRequest) => ReturnType<RequestDispatch["before_dispatch"]>;
}

export function materializePaginatedBody(
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

export function requestIsReadOnly(d: RequestDispatch): boolean {
  return (
    classifyRequestStepSideEffects(
      d.p.step,
      undefined,
      undefined,
      d.state.activeConnector?.base_url,
    ) === "read"
  );
}

export function attemptParams(
  x: HttpExchange,
  page: { url: string; body: unknown; idempotency_page: number },
): DoOnePageParams {
  const { d } = x;
  return {
    ...d.rate_limit,
    clock: d.clock,
    db: d.p.ctx.db,
    before_dispatch: x.before_dispatch,
    ...(x.signed_jwt ? { signed_jwt: x.signed_jwt } : {}),
    url: page.url,
    method: d.p.step.method,
    headers: x.headers,
    body: page.body,
    max_attempts: d.max_attempts,
    signal: d.signal,
    retry_total_ms: x.retry_total,
    retry_counter: x.retry_counter,
    connector_id: d.p.step.connector_id ?? null,
    connector_slug: d.state.activeConnector?.slug ?? null,
    retry_policy: resolveRetryPolicy(d.p.step),
    retry_safe: requestIsReadOnly(d),
    ...(x.expected_statuses ? { accepted_statuses: new Set(x.expected_statuses) } : {}),
    last_idempotency_key: x.last_idempotency_key,
    tenant_id: d.p.ctx.tenant_id,
    ...(x.idempotency_base
      ? { idempotency_key_base: `${x.idempotency_base}:${page.idempotency_page}` }
      : {}),
  };
}

export async function settleConnectorHealth(
  x: HttpExchange,
  headers: Record<string, string>,
  proof: Omit<Parameters<typeof clearReauthIfProved>[2], "stored_credential_used">,
): Promise<void> {
  const { d } = x;
  const activeConnector = d.state.activeConnector;
  if (!activeConnector) return;
  await recordDriverOutcome(d.p.ctx.db, activeConnector, "answered");
  void clearReauthIfProved(d.p.ctx.db, activeConnector, {
    ...proof,
    stored_credential_used: x.stored_credential_used,
  });
  const deprecation = parseDeprecation(headers);
  if (deprecation && activeConnector.health_state !== "needs_update") {
    logger.warn({
      module: "connectors",
      action: "connector.endpoint.deprecated",
      msg: "vendor announced endpoint deprecation on a successful response",
      tenant_id: d.p.ctx.tenant_id,
      connector_id: activeConnector.id,
      step_id: d.p.step.id,
      sunset: deprecation.sunset,
      successor_uri: deprecation.successor_uri,
    });
    await flagConnectorContractFailure(d.p.ctx.db, activeConnector, {
      error_code: "endpoint_deprecated",
      reason: `vendor announced deprecation of an endpoint this connector uses${deprecation.sunset ? ` (sunset: ${deprecation.sunset})` : ""}`,
      deprecation,
      workflow_id: d.p.ctx.workflow_id ?? null,
    });
  } else if (
    !deprecation &&
    (activeConnector.health_state === "degraded" || activeConnector.health_state === "needs_reauth")
  ) {
    await clearConnectorHealthOnSuccess(d.p.ctx.db, activeConnector);
  }
}

export async function recordHttpShape(x: HttpExchange, value: unknown): Promise<void> {
  const { d } = x;
  const activeConnector = d.state.activeConnector;
  if (!activeConnector) return;
  try {
    await recordSuccessShape(
      {
        tenant_id: d.p.ctx.tenant_id,
        connector_id: activeConnector.id,
        endpoint_key: `${d.p.step.method ?? "GET"} ${x.base_url.pathname}`,
        workflow_id: d.p.ctx.workflow_id,
        step_id: d.p.step.id,
        value,
      },
      d.p.ctx.db,
    );
  } catch {}
}
