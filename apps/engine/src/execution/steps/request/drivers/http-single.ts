import { redactKnownValues } from "@shared/redaction.ts";
import { auditAwait } from "../../../../audit/audit.ts";
import { AuditAction } from "../../../../audit/types.ts";
import { filenameFromResponse } from "../../../../connectors/drivers/file-promotion.ts";
import { extractCreatedResourceId, withEgressAudit } from "../../../../connectors/egress.ts";
import { classifyConnectorHealth } from "../../../../connectors/health.ts";
import { recordUsage } from "../../../../llm/accounting/budget.ts";
import {
  estimateLlmCallTokens,
  isLlmProviderUrl,
  LlmBudgetExceededError,
  parseLlmUsage,
} from "../../../../llm/accounting/index.ts";
import { spendRefusalDetails, spendVerdict } from "../../../../llm/accounting/spend.ts";
import { logger } from "../../../../logging/index.ts";
import { inspectContentRevisionResponse } from "../../../../workflows/content-publication-boundary.ts";
import { applyResponseFilters, ResponseFilterFailError } from "../../../response-filter.ts";
import type { StepResult } from "../../../types.ts";
import { RequestError } from "../errors.ts";
import { promoteResponseToFile } from "../file-output.ts";
import { doOnePage, type FetchAttemptResult } from "../http-attempt.ts";
import { checkRequired, extractModelHint } from "../shape.ts";
import { egressScope, elapsed, failedStep } from "./context.ts";
import {
  attemptParams,
  type HttpExchange,
  recordedUrl,
  recordHttpShape,
  settleConnectorHealth,
} from "./http-exchange.ts";

function llmBudgetRefusal(x: HttpExchange): StepResult | null {
  const { d } = x;
  const estimated = estimateLlmCallTokens(d.parts.body);
  try {
    d.p.ctx.llm_budget.checkPreCall(estimated);
    return null;
  } catch (err) {
    if (err instanceof LlmBudgetExceededError) {
      return failedStep(d, {
        code: err.code,
        message: err.message,
        details: {
          running_total: err.running_total,
          estimated_call_tokens: err.estimated_call_tokens,
          cap: err.cap,
        },
      });
    }
    throw err;
  }
}

async function spendRefusal(x: HttpExchange): Promise<StepResult | null> {
  const { d } = x;
  const verdict = await spendVerdict(
    d.p.ctx.tenant_id,
    { kind: "workflow_step", calls_model_provider: true },
    d.p.ctx.db,
  );
  if (verdict.ok) return null;
  return failedStep(d, {
    code: "llm_spend_limit_reached",
    message:
      "This month's AI budget is reached, so this model step did not run. Raise the limit or continue this month under Settings › Usage, then run the workflow again.",
    details: spendRefusalDetails(verdict.reading),
  });
}

async function accountLlmUsage(x: HttpExchange, res: FetchAttemptResult): Promise<void> {
  const { d, base_url: baseUrl } = x;
  const { p } = d;
  const usage = parseLlmUsage(res.body);
  if (!usage) return;
  p.ctx.llm_budget.account(usage);
  const model = extractModelHint(d.parts.body, res.body);
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
        latency_ms: elapsed(d),
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
  const llmCall = isLlmProviderUrl(baseUrl);
  if (llmCall) {
    const refusal = llmBudgetRefusal(x) ?? (await spendRefusal(x));
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
  if (llmCall) await accountLlmUsage(x, res);
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
