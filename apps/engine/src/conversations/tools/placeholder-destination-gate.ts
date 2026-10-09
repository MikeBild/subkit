import { recordAuthoringGateBlock } from "../../observability/instrumentation.ts";
import type { DestinationPlaceholderViolation } from "../../workflows/destination-placeholders.ts";
import type { DraftDocument } from "../types.ts";
import { buildGateError } from "./authoring-contract.ts";
import type { ToolResult } from "./index.ts";

export const PLACEHOLDER_DESTINATION_ERROR_CODE = "workflow_placeholder_destination";

export const PLACEHOLDER_DESTINATION_NEXT_ACTIONS: readonly string[] = [
  "ask_user_text",
  "ask_user_form",
  "author_workflow",
];

export type PlaceholderDestinationGateTool =
  | "author_workflow"
  | "edit_workflow_patch"
  | "dry_run_workflow"
  | "save_workflow_draft";

const SHOWN_VIOLATIONS = 3;

export function describePlaceholderDestinations(
  violations: ReadonlyArray<DestinationPlaceholderViolation>,
): string {
  const shown = violations
    .slice(0, SHOWN_VIOLATIONS)
    .map((v) => v.message)
    .join("; ");
  const more =
    violations.length > SHOWN_VIOLATIONS ? ` (+${violations.length - SHOWN_VIOLATIONS} more)` : "";
  return `${violations.length} destination value(s) are placeholders: ${shown}${more} Reserved example or placeholder values cannot be delivered, even when the user typed them — ask the user for the real value with ask_user_text or ask_user_form, then apply the answer. The engine never previews, patches or saves a placeholder destination.`;
}

export function placeholderDestinationGateResult(
  draft: DraftDocument,
  violations: ReadonlyArray<DestinationPlaceholderViolation>,
  tool: PlaceholderDestinationGateTool,
): ToolResult {
  recordAuthoringGateBlock({ code: PLACEHOLDER_DESTINATION_ERROR_CODE, tool });
  const message = describePlaceholderDestinations(violations);
  return {
    ok: false,
    error_code: PLACEHOLDER_DESTINATION_ERROR_CODE,
    message,
    next_best_actions: [...PLACEHOLDER_DESTINATION_NEXT_ACTIONS],
    data: buildGateError(draft, {
      error_code: PLACEHOLDER_DESTINATION_ERROR_CODE,
      message,
      recommended_mode: "workflow",
      requires_user_input: true,
      next_best_actions: [...PLACEHOLDER_DESTINATION_NEXT_ACTIONS],
      extra: { placeholder_destinations: [...violations] },
    }),
  };
}
