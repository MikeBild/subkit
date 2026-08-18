import type { ToolPart } from "@/components/ai-elements/tool";

/** Tools whose pending approval is a proposed workflow patch worth rendering as a diff. */
const PATCH_TOOLS = new Set(["approve_patch_candidate", "dry_run_patch_candidate"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The engine's persisted verdicts, carried onto the part so the transcript can
 *  say how a call ended rather than only that it stopped. */
export interface ToolPartVerdict {
  confirmationState: string | null;
  outcome: string | null;
}

const VERDICT_KEY = "__skVerdict";

/** Read back whatever `asToolPart`/`withToolResult` learned about the ending. */
export function toolPartVerdict(tool: ToolPart): ToolPartVerdict {
  const carried = (tool as unknown as Record<string, unknown>)[VERDICT_KEY];
  if (!isRecord(carried)) return { confirmationState: null, outcome: null };
  return {
    confirmationState:
      typeof carried.confirmationState === "string" ? carried.confirmationState : null,
    outcome: typeof carried.outcome === "string" ? carried.outcome : null,
  };
}

/**
 * Accepts both the streamed AI-SDK part shape and the persisted
 * `tool_call` / `tool_result` pair the detail endpoint returns, so a proposal
 * stays visible and decidable after a reload.
 */
export function asToolPart(
  part: unknown,
  pendingApprovalId: string | null = null,
): ToolPart | null {
  if (!isRecord(part) || typeof part.type !== "string") return null;
  if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) return part as ToolPart;
  if (part.type !== "tool_call") return null;

  const callId = typeof part.call_id === "string" ? part.call_id : null;
  const toolName = typeof part.tool === "string" ? part.tool : null;
  if (!callId || !toolName) return null;

  const awaitingDecision = pendingApprovalId === callId;
  return {
    type: "dynamic-tool",
    toolName,
    toolCallId: callId,
    state: awaitingDecision ? "approval-requested" : "input-available",
    input: part.input,
    ...(awaitingDecision ? { approval: { id: callId } } : {}),
  } as ToolPart;
}

/**
 * Merges the persisted result part into the call part it belongs to.
 *
 * The presence of a `tool_result` part is NOT evidence that the call produced
 * one: the engine emits the part alongside every call, `output` included or
 * not. Promoting on presence alone put the green tick and the word "completed"
 * on every running, declined and abandoned call in the transcript. The result
 * has to actually carry an output before the call counts as finished.
 */
export function withToolResult(tool: ToolPart, parts: readonly unknown[]): ToolPart {
  const result = parts.find(
    (part) => isRecord(part) && part.type === "tool_result" && part.call_id === tool.toolCallId,
  );
  if (!isRecord(result) || tool.state === "approval-requested") return tool;
  const verdict: ToolPartVerdict = {
    confirmationState:
      typeof result.confirmation_state === "string" ? result.confirmation_state : null,
    outcome: typeof result.outcome === "string" ? result.outcome : null,
  };
  const hasOutput = result.output !== null && result.output !== undefined;
  if (!hasOutput) return { ...tool, [VERDICT_KEY]: verdict } as unknown as ToolPart;
  return {
    ...tool,
    state: verdict.outcome === "error" ? "output-error" : "output-available",
    output: result.output,
    [VERDICT_KEY]: verdict,
  } as unknown as ToolPart;
}

/** The patch candidate a pending approval decides on, when the tool names one. */
export function patchCandidateId(tool: ToolPart): string | null {
  const toolName = tool.type === "dynamic-tool" ? tool.toolName : tool.type.replace(/^tool-/, "");
  if (!PATCH_TOOLS.has(toolName)) return null;
  if (!isRecord(tool.input)) return null;
  const id = tool.input.candidate_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** The registered name of a tool part, whichever shape it arrived in. */
export function toolNameOf(tool: ToolPart): string {
  return tool.type === "dynamic-tool" ? tool.toolName : tool.type.replace(/^tool-/, "");
}
