import {
  invoke,
  LlmBudgetExceededError,
  LlmError,
  LlmSpendLimitReached,
  resolvePlaceholdersTypePreserving,
} from "../../llm/index.ts";
import {
  MODEL_STEP_DEFAULT_OUTPUT_TOKENS,
  type ModelStep,
  modelStepPlaceholderRefusal,
  modelStepPlaceholders,
  parsePlaceholders,
} from "../../workflows/index.ts";
import { combineSignals } from "../abort.ts";
import { SYSTEM_CLOCK } from "../clock.ts";
import {
  type ModelStepFailure,
  modelStepFrameText,
  modelStepOutcome,
  modelStepTokenEstimate,
  modelStepUserText,
} from "../core/model-step.ts";
import { resolveScopeForJsonata } from "../jsonata-bindings.ts";
import type { StepResult, StepRunContext } from "../types.ts";

interface RunModelStepParams {
  ctx: StepRunContext;
  step: ModelStep;
  scope: Record<string, unknown>;
}

const SPEND_LIMIT_MESSAGE =
  "This month's AI budget is reached, so this model step did not run. Raise the limit or continue this month under Settings › Usage, then run the workflow again.";

function failed(start: number, now: number, failure: ModelStepFailure): StepResult {
  return {
    status: "failed",
    retry_count: 0,
    duration_ms: Math.max(0, now - start),
    error: {
      code: failure.code,
      message: failure.message,
      ...(failure.details ? { details: failure.details } : {}),
    },
  };
}

function parseErrorsOf(texts: ReadonlyArray<string | undefined>) {
  return texts.flatMap((text) =>
    text === undefined
      ? []
      : parsePlaceholders(text).errors.map((error) => ({
          token: text.slice(error.span.start, error.span.end),
          code: "parse_error" as const,
          message: `${error.code}: ${error.message}`,
        })),
  );
}

function invokeFailure(err: unknown): ModelStepFailure | null {
  if (err instanceof LlmSpendLimitReached) {
    return {
      code: err.code,
      message: SPEND_LIMIT_MESSAGE,
      ...(err.details ? { details: err.details } : {}),
    };
  }
  if (err instanceof LlmBudgetExceededError) {
    return {
      code: err.code,
      message: err.message,
      details: {
        running_total: err.running_total,
        estimated_call_tokens: err.estimated_call_tokens,
        cap: err.cap,
      },
    };
  }
  if (err instanceof LlmError) {
    return {
      code: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    };
  }
  return null;
}

export async function runModelStep(p: RunModelStepParams): Promise<StepResult> {
  const clock = p.ctx.clock ?? SYSTEM_CLOCK;
  const start = clock.now();
  const placeholders = modelStepPlaceholders(p.step);
  const refusal = modelStepPlaceholderRefusal(placeholders);
  if (refusal) return failed(start, clock.now(), refusal);

  const scope = await resolveScopeForJsonata(p.ctx.db, p.ctx.tenant_id, p.scope, p.ctx.signal);
  const resolverCtx = {
    tenant_id: p.ctx.tenant_id,
    environment: p.ctx.execution_mode,
    db: p.ctx.db,
    input: scope.$input,
    scope,
    ...(p.ctx.principal ? { principal: p.ctx.principal } : {}),
  };
  const tokens = [
    ...new Set(
      placeholders
        .filter((placeholder) => placeholder.field === "prompt" || placeholder.field === "system")
        .map((placeholder) => placeholder.token),
    ),
  ];
  const data = await resolvePlaceholdersTypePreserving(
    { tokens, input: p.step.input },
    resolverCtx,
  );
  const unresolved = [...parseErrorsOf([p.step.prompt, p.step.system]), ...data.unresolved];
  if (unresolved.length > 0) {
    return failed(start, clock.now(), {
      code: "placeholder_unresolved",
      message: `The model step references values that do not exist: ${unresolved
        .map((u) => u.token)
        .join(", ")}`,
      details: { unresolved },
    });
  }
  const values = new Map(tokens.map((token, index) => [token, data.value.tokens[index]]));
  const frame = (template: string) =>
    modelStepFrameText(template, parsePlaceholders(template).tokens, values);
  const system = p.step.system ? frame(p.step.system) : undefined;
  const userText = modelStepUserText(frame(p.step.prompt), data.value.input);
  const maxOutputTokens = p.step.max_output_tokens ?? MODEL_STEP_DEFAULT_OUTPUT_TOKENS;
  const timeout = new AbortController();
  const timer =
    p.step.timeout_ms !== undefined
      ? setTimeout(() => timeout.abort("timeout"), p.step.timeout_ms)
      : undefined;
  try {
    p.ctx.llm_budget.checkPreCall(modelStepTokenEstimate([system, userText], maxOutputTokens));
    const answer = await invoke(
      {
        flow: "workflow_step",
        tenant_id: p.ctx.tenant_id,
        user_turns: [{ role: "user", content: userText }],
        ...(system ? { system } : {}),
        max_output_tokens: maxOutputTokens,
        output_json_schema: p.step.output_schema,
        principal: p.ctx.principal ?? null,
        telemetry_metadata: {
          execution_id: p.ctx.execution_id,
          workflow_id: p.ctx.workflow_id,
          step_id: p.step.id,
        },
        signal: combineSignals([p.ctx.signal, timeout.signal]),
      },
      p.ctx.db,
    );
    p.ctx.llm_budget.account({
      prompt_tokens: answer.usage.input_tokens,
      completion_tokens: answer.usage.output_tokens,
      total_tokens: answer.usage.input_tokens + answer.usage.output_tokens,
      cache_read_tokens: answer.usage.cache_read_tokens,
      cache_creation_tokens: answer.usage.cache_creation_tokens,
    });
    const outcome = modelStepOutcome(answer, p.step.output_schema);
    if (!outcome.ok) return failed(start, clock.now(), outcome.failure);
    return {
      status: "succeeded",
      output: outcome.output,
      retry_count: 0,
      duration_ms: Math.max(0, clock.now() - start),
    };
  } catch (err) {
    if (timeout.signal.aborted) {
      return {
        status: "timed_out",
        retry_count: 0,
        duration_ms: Math.max(0, clock.now() - start),
        error: {
          code: "model_step_timeout",
          message: `model step exceeded ${p.step.timeout_ms}ms`,
        },
      };
    }
    if (p.ctx.signal.aborted) {
      return {
        status: "aborted",
        retry_count: 0,
        duration_ms: Math.max(0, clock.now() - start),
        error: { code: "aborted", message: "the run was stopped" },
      };
    }
    const failure = invokeFailure(err);
    if (!failure) throw err;
    return failed(start, clock.now(), failure);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
