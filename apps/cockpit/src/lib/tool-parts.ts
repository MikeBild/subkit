import type { ToolPart } from "@/components/ai-elements/tool";

const PATCH_TOOLS = new Set(["approve_patch_candidate", "dry_run_patch_candidate"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ToolPartVerdict {
  confirmationState: string | null;
  outcome: string | null;
}

const VERDICT_KEY = "__skVerdict";

export function toolPartVerdict(tool: ToolPart): ToolPartVerdict {
  const carried = (tool as unknown as Record<string, unknown>)[VERDICT_KEY];
  if (!isRecord(carried)) return { confirmationState: null, outcome: null };
  return {
    confirmationState:
      typeof carried.confirmationState === "string" ? carried.confirmationState : null,
    outcome: typeof carried.outcome === "string" ? carried.outcome : null,
  };
}

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
    state:
      verdict.outcome === "error"
        ? "output-error"
        : verdict.outcome === "denied"
          ? "output-denied"
          : "output-available",
    output: result.output,
    [VERDICT_KEY]: verdict,
  } as unknown as ToolPart;
}

export function patchCandidateId(tool: ToolPart): string | null {
  const toolName = tool.type === "dynamic-tool" ? tool.toolName : tool.type.replace(/^tool-/, "");
  if (!PATCH_TOOLS.has(toolName)) return null;
  if (!isRecord(tool.input)) return null;
  const id = tool.input.candidate_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function toolNameOf(tool: ToolPart): string {
  return tool.type === "dynamic-tool" ? tool.toolName : tool.type.replace(/^tool-/, "");
}
