import { redactKnownValues } from "@shared/redaction.ts";
import { filenameFromResponse } from "../../../../connectors/drivers/file-promotion.ts";
import { extractCreatedResourceId, withEgressAudit } from "../../../../connectors/egress.ts";
import { classifyConnectorHealth } from "../../../../connectors/health.ts";
import { isLlmProviderUrl } from "../../../../llm/accounting/enforce.ts";
import { logger } from "../../../../logging/index.ts";
import { inspectContentRevisionResponse } from "../../../../workflows/content-publication-boundary.ts";
import { applyResponseFilters, ResponseFilterFailError } from "../../../response-filter.ts";
import type { StepResult } from "../../../types.ts";
import { RequestError } from "../errors.ts";
import { promoteResponseToFile } from "../file-output.ts";
import { doOnePage } from "../http-attempt.ts";
import { checkRequired } from "../shape.ts";
import { egressScope, elapsed, failedStep } from "./context.ts";
import {
  attemptParams,
  type HttpExchange,
  recordedUrl,
  recordHttpShape,
  settleConnectorHealth,
} from "./http-exchange.ts";
import { accountProviderCall, providerCallRefusal } from "./provider-call.ts";

export async function runHttpSinglePage(x: HttpExchange): Promise<StepResult> {
  const { d, base_url: baseUrl } = x;
  const { p } = d;
  const activeConnector = d.state.activeConnector;
  const httpEgressInput = activeConnector
    ? {
        ...egressScope(d),
        connector_id: activeConnector.id,
        connector_slug: activeConnector.slug,
        driver: "http" as const,
        credential_id: x.active_credential_id,
        operation: p.step.method,
        url: redactKnownValues(recordedUrl(baseUrl, x.masked_query_keys), d.own_credentials),
      }
    : null;
  const providerCall = isLlmProviderUrl(baseUrl);
  if (providerCall) {
    const refusal = await providerCallRefusal(x);
    if (refusal) return refusal;
  }
  const callDoOnePage = () =>
    doOnePage({
      ...attemptParams(x, {
        url: baseUrl.toString(),
        body: d.parts.body ?? null,
        idempotency_page: 0,
      }),
      ...(x.multipart !== undefined ? { multipartBody: x.multipart } : {}),
      capture_binary: true,
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
  const contentRevisionReceipt = x.last_request
    ? inspectContentRevisionResponse({
        step_id: p.step.id,
        request: x.last_request,
        status: res.status,
        body: res.body,
      })
    : null;
  if (providerCall) await accountProviderCall(x, res.body);
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
  const expected = x.expected_statuses;
  if (expected && expected.length > 0 && !expected.includes(res.status)) {
    return failedStep(d, {
      code: "unexpected_status_code",
      message: `status ${res.status} not in expected [${expected.join(",")}]`,
    });
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
  if (x.response_schema && res.body_raw === undefined) {
    const respErrs = checkRequired(body, x.response_schema);
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
  await settleConnectorHealth(x, res.headers, {
    status: res.status,
    health: classifyConnectorHealth(res.status, res.headers),
    body,
  });
  if (res.status >= 200 && res.status < 300 && res.body_raw === undefined) {
    await recordHttpShape(x, res.body);
  }
  const producedExtras =
    producedFileId || contentRevisionReceipt
      ? {
          extras: {
            ...(producedFileId ? { produced_file_id: producedFileId } : {}),
            ...(contentRevisionReceipt ? { content_revision_receipt: contentRevisionReceipt } : {}),
          },
        }
      : {};
  const heldRequestBody = x.held_body;
  const sentBytes =
    heldRequestBody === undefined || heldRequestBody === null
      ? undefined
      : new TextEncoder().encode(
          typeof heldRequestBody === "string" ? heldRequestBody : JSON.stringify(heldRequestBody),
        ).byteLength;
  const shared = {
    url: recordedUrl(baseUrl, x.masked_query_keys),
    method: p.step.method ?? "GET",
    status: res.status,
    bytes_in: res.bytes_in,
    ...(sentBytes === undefined ? {} : { bytes_out: sentBytes }),
    ...(x.last_idempotency_key.value ? { idempotency_key: x.last_idempotency_key.value } : {}),
  };
  x.meta = d.connector_resolution
    ? {
        driver: "http",
        ...shared,
        connector: d.connector_resolution,
        digest: x.digest,
        ...producedExtras,
      }
    : {
        driver: "connectorless",
        ...shared,
        digest: x.digest,
        ...producedExtras,
      };
  return {
    status: "succeeded",
    output: body,
    retry_count: x.retry_counter.value,
    duration_ms: elapsed(d),
    request_meta: x.meta,
  };
}
