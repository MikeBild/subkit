import type { ToolPart } from "@/components/ai-elements/tool";
import { asToolPart, toolNameOf, withToolResult } from "@/lib/tool-parts";
import { toolTier } from "@/lib/tool-presentation";

// How one assistant turn's parts become rows on screen.
//
// A turn is a flat list of text, tool calls and tool results. Rendered
// one-to-one it reads as a wall of identical cards, because most of those calls
// are reads the agent made to orient itself. Grouping consecutive background
// reads into a single run is what turns that wall back into a story: the agent
// looked around, then it did the thing.

export type TranscriptGroup =
  | { kind: "part"; part: unknown; index: number }
  | { kind: "tool"; tool: ToolPart; index: number }
  | { kind: "background"; tools: readonly ToolPart[]; index: number };

/**
 * Walk a message's parts in order and emit render groups.
 *
 * Order is preserved exactly — a background run is collapsed only across
 * *adjacent* background calls, so a read that happens after a write still
 * appears after it. Anything that is not a tool call passes through untouched.
 */
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
      // A `tool_result` part is merged into its call, never rendered on its
      // own — it carries no text a person can read.
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

/**
 * Collapse a background run into one line per distinct action.
 *
 * Six `get_workflow` calls are one fact — the agent read six workflows — and
 * six identical lines is the same wall the cards were, just quieter.
 */
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
