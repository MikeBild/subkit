import type { ToolPart } from "@/components/ai-elements/tool";
import { asToolPart, toolNameOf, withToolResult } from "@/lib/tool-parts";
import { toolTier } from "@/lib/tool-presentation";

export type TranscriptGroup =
  | { kind: "part"; part: unknown; index: number }
  | { kind: "tool"; tool: ToolPart; index: number }
  | { kind: "background"; tools: readonly ToolPart[]; index: number };

export function groupMessageParts(
  parts: readonly unknown[],
  pendingApprovalId: string | null = null,
): TranscriptGroup[] {
  const groups: TranscriptGroup[] = [];
  let background: ToolPart[] = [];

  const flush = (index: number) => {
    if (background.length === 0) return;
    groups.push({ kind: "background", tools: background, index });
    background = [];
  };

  parts.forEach((part, index) => {
    const called = asToolPart(part, pendingApprovalId);
    if (!called) {
      if (isToolResultPart(part)) return;
      flush(index);
      groups.push({ kind: "part", part, index });
      return;
    }
    const tool = withToolResult(called, parts);
    if (toolTier(toolNameOf(tool)) === "background") {
      background.push(tool);
      return;
    }
    flush(index);
    groups.push({ kind: "tool", tool, index });
  });

  flush(parts.length);
  return groups;
}

function isToolResultPart(part: unknown): boolean {
  return (
    typeof part === "object" && part !== null && (part as { type?: unknown }).type === "tool_result"
  );
}

export function dedupeBackground(
  tools: readonly ToolPart[],
): Array<{ toolName: string; count: number; running: boolean }> {
  const byName = new Map<string, { toolName: string; count: number; running: boolean }>();
  for (const tool of tools) {
    const toolName = toolNameOf(tool);
    const running = tool.state === "input-available" || tool.state === "input-streaming";
    const existing = byName.get(toolName);
    if (existing) {
      existing.count += 1;
      existing.running = existing.running || running;
      continue;
    }
    byName.set(toolName, { toolName, count: 1, running });
  }
  return [...byName.values()];
}
