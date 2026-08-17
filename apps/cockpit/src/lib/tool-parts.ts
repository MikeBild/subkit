import type { ToolPart } from "@/components/ai-elements/tool";

/** Tools whose pending approval is a proposed workflow patch worth rendering as a diff. */
const PATCH_TOOLS = new Set(["approve_patch_candidate", "dry_run_patch_candidate"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/** Merges the persisted result part into the call part it belongs to. */
export function withToolResult(tool: ToolPart, parts: readonly unknown[]): ToolPart {
  const result = parts.find(
    (part) => isRecord(part) && part.type === "tool_result" && part.call_id === tool.toolCallId,
  );
  if (!isRecord(result) || tool.state === "approval-requested") return tool;
  return { ...tool, state: "output-available", output: result.output } as ToolPart;
}

/** The patch candidate a pending approval decides on, when the tool names one. */
export function patchCandidateId(tool: ToolPart): string | null {
  const toolName = tool.type === "dynamic-tool" ? tool.toolName : tool.type.replace(/^tool-/, "");
  if (!PATCH_TOOLS.has(toolName)) return null;
  if (!isRecord(tool.input)) return null;
  const id = tool.input.candidate_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
