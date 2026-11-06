import { committedWorkflowIdFromResult } from "../../../core/tool-invoke.ts";
import { assertConversationTurn } from "../../../turns.ts";
import type { WrappedToolOutput } from "../state.ts";
import type { InvokeEnv } from "./env.ts";
import { executeTool } from "./execute.ts";
import { runGate } from "./gate.ts";
import { runGuards } from "./guards.ts";
import { forwardToolPause, markCommitted, pauseForReview } from "./pause.ts";
import { recordOutcome } from "./record.ts";
import { startCall } from "./start.ts";

export async function runInvocation(
  env: InvokeEnv,
  rawArgs: Record<string, unknown>,
): Promise<WrappedToolOutput> {
  await assertConversationTurn(env.ctx.abortSignal);
  const guarded = await runGuards(env, rawArgs);
  if ("blocked" in guarded) return guarded.blocked;
  const call = await startCall(env, rawArgs, guarded.argsHash);
  const gated = await runGate(env, call);
  if ("done" in gated) return gated.done;
  const ran = await executeTool(env, call, gated.passed);
  if ("done" in ran) return ran.done;
  const { executed } = ran;
  const { result } = executed;
  const committedWorkflowId = committedWorkflowIdFromResult(result);
  await recordOutcome(env, call, executed, committedWorkflowId);
  if (result.pause) await forwardToolPause(env, call, result.pause);
  if (committedWorkflowId) markCommitted(env, call, committedWorkflowId);
  if (
    gated.passed.resolvedMode === "confirm_after_execution" &&
    result.ok &&
    !result.pause &&
    !env.signals.pendingElicitation
  ) {
    return pauseForReview(env, call, executed, committedWorkflowId);
  }
  return {
    ok: result.ok,
    data: executed.modelVisibleOutput,
    ...(result.pause ? { pause: result.pause } : {}),
    ...(committedWorkflowId ? { committed_workflow_id: committedWorkflowId } : {}),
  };
}
