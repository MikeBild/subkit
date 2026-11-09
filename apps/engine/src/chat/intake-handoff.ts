import { resolvePublicBaseUrl } from "../conversations/public/tool-contract.ts";
import type { RunLoopResult } from "../conversations/types.ts";

const INTAKE_REVIEW_TOOLS = new Set(["list_intake_items", "get_intake_item"]);

function completedIntakeRead(output: unknown, tool: string): boolean {
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  const record = output as Record<string, unknown>;
  return tool === "list_intake_items"
    ? Array.isArray(record.items)
    : record.item !== null && typeof record.item === "object";
}

export function intakeReviewHandoff(
  outcome: RunLoopResult,
  conversationId: string,
  publicBaseUrl: string | null = resolvePublicBaseUrl(),
): string | null {
  const reviewed = outcome.events.some(
    (event) =>
      event.type === "tool_result" &&
      INTAKE_REVIEW_TOOLS.has(event.tool) &&
      completedIntakeRead(event.output, event.tool),
  );
  if (!reviewed) return null;
  const path = `/cockpit/chat/${encodeURIComponent(conversationId)}`;
  const url = publicBaseUrl ? `${publicBaseUrl.replace(/\/+$/, "")}${path}` : path;
  return `Continue this review in SubKit: ${url}\nReview the exact proposal and confirm it before it becomes knowledge or a skill.`;
}
