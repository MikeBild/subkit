import type { streamText, ToolSet } from "ai";
import { runOutputGuardStream } from "../../llm/output-guard/index.ts";
import { createStreamScrubber } from "../../llm/output-guard/stream-scrub.ts";
import { logger } from "../../logging/index.ts";
import { recordLlmStepTimeout } from "../../observability/instrumentation.ts";
import { now } from "../../utils/clock.ts";
import {
  composingLabel,
  outputGuardContext,
  type ProseScan,
  scanProseChunk,
  streamErrorTimeoutBudget,
} from "../core/loop.ts";
import { LlmTimeoutError, timeoutBudgetOf, timeoutPhaseOf } from "../turn-failure.ts";
import { answeredDespiteToolChoice, throwForStreamError } from "./stream-result.ts";
import type { Attempt, TurnEnv } from "./types.ts";

type StreamResult = ReturnType<typeof streamText<ToolSet>>;

async function forwardTextStream(env: TurnEnv, result: StreamResult): Promise<void> {
  const { events, p } = env;
  const composingStart = now();
  let heartbeat: ReturnType<typeof setInterval> | null = setInterval(() => {
    events.push({
      type: "activity",
      phase: "composing",
      label: composingLabel(now() - composingStart),
    });
  }, 5_000);
  const stopHeartbeat = () => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };
  const deltaScrubber = createStreamScrubber();
  try {
    let scan: ProseScan = { tail: "", scanFrom: 0, paragraphs: 0 };
    for await (const chunk of result.textStream) {
      if (chunk.length === 0) continue;
      stopHeartbeat();
      const safeDelta = deltaScrubber.push(chunk);
      if (safeDelta) events.push({ type: "text_delta", text: safeDelta });
      const step = scanProseChunk(scan, chunk);
      scan = step.scan;
      if (step.progressLabel) {
        events.push({ type: "activity", phase: "composing", label: step.progressLabel });
      }
      if (step.paragraph) {
        runOutputGuardStream(
          step.paragraph,
          outputGuardContext(env.engineUrl, p.runtime_context?.tenant_slug),
        );
      }
    }
  } catch {
  } finally {
    const tailDelta = deltaScrubber.flush();
    if (tailDelta) events.push({ type: "text_delta", text: tailDelta });
    stopHeartbeat();
  }
}

export async function consumeAttemptStream(
  env: TurnEnv,
  attempt: Attempt,
  result: StreamResult,
): Promise<void> {
  try {
    await forwardTextStream(env, result);
    const finishReason = await result.finishReason;
    if (finishReason === "error" && answeredDespiteToolChoice(attempt.capturedError)) {
      logger.warn({
        module: "llm",
        action: "converse.tool_choice_ignored",
        msg: "model answered in text although a tool call was required; keeping the answer",
        conversation_id: env.p.conversation_id,
        tenant_id: env.p.tenant_id,
        provider: attempt.provider,
        model: attempt.modelId,
      });
    }
    throwForStreamError(finishReason, attempt.capturedError);
  } catch (err) {
    if (attempt.timeoutError) throw attempt.timeoutError;
    const thrown = attempt.capturedError ?? err;
    const phase = thrown instanceof LlmTimeoutError ? null : timeoutPhaseOf(thrown);
    if (phase) {
      recordLlmStepTimeout({ phase });
      const timeoutBudget = streamErrorTimeoutBudget({
        phase,
        reportedBudget: timeoutBudgetOf(thrown),
        turnBudgetMs: attempt.turnBudgetMs,
        firstChunkMs: attempt.firstChunkTimeoutMs,
      });
      if (timeoutBudget !== null)
        throw new LlmTimeoutError(phase, timeoutBudget, { cause: thrown });
    }
    throw thrown;
  }
  if (attempt.timeoutError) throw attempt.timeoutError;
}
