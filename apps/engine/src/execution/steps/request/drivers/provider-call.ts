import { AuditAction, auditAwait } from "../../../../audit/index.ts";
import {
  estimateLlmCallTokens,
  extractModelHint,
  LlmBudgetExceededError,
  parseLlmUsage,
  recordUsage,
  spendRefusalDetails,
  spendVerdict,
} from "../../../../llm/index.ts";
import { logger } from "../../../../logging/index.ts";
import type { StepResult } from "../../../types.ts";
import { elapsed, failedStep } from "./context.ts";
import type { HttpExchange } from "./http-exchange.ts";

const SPEND_LIMIT_MESSAGE =
  "This month's AI budget is reached, so this call to a model provider did not run. Use a model step, raise the limit or continue this month under Settings › Usage, then run the workflow again.";

function runCapRefusal(x: HttpExchange): StepResult | null {
  const { d } = x;
  try {
    d.p.ctx.llm_budget.checkPreCall(estimateLlmCallTokens(d.parts.body));
    return null;
  } catch (err) {
    if (!(err instanceof LlmBudgetExceededError)) throw err;
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
}

export async function providerCallRefusal(x: HttpExchange): Promise<StepResult | null> {
  const capped = runCapRefusal(x);
  if (capped) return capped;
  const { d } = x;
  const verdict = await spendVerdict(
    d.p.ctx.tenant_id,
    { kind: "workflow_step", calls_model_provider: true },
    d.p.ctx.db,
  );
  if (verdict.ok) return null;
  return failedStep(d, {
    code: "llm_spend_limit_reached",
    message: SPEND_LIMIT_MESSAGE,
    details: spendRefusalDetails(verdict.reading),
  });
}

export async function accountProviderCall(x: HttpExchange, responseBody: unknown): Promise<void> {
  const { d, base_url: baseUrl } = x;
  const { p } = d;
  const usage = parseLlmUsage(responseBody);
  if (!usage) return;
  p.ctx.llm_budget.account(usage);
  const model = extractModelHint(d.parts.body, responseBody);
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
        model,
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
      msg: "a provider call succeeded but its usage row could not be written",
      execution_id: p.ctx.execution_id,
      step_id: p.step.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
