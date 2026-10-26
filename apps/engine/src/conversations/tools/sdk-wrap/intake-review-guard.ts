import type { Executor } from "../../../db/client.ts";
import { getIntakeItem } from "../../../knowledge/intake.ts";
import type { DraftDocument } from "../../types.ts";

export const INTAKE_REVIEW_REMOVED_TOOLS: readonly string[] = [
  "create_knowledge_source",
  "update_knowledge_source",
  "analyze_knowledge_source",
];

export const INTAKE_REVIEW_BLOCKED_WRITES = new Set([
  ...INTAKE_REVIEW_REMOVED_TOOLS,
  "delete_knowledge_source",
  "save_learning",
  "approve_skill_candidate",
  "reject_skill_candidate",
  "update_skill",
  "delete_skill",
]);

export function intakeReviewInProgress(draft: DraftDocument | null | undefined): boolean {
  return Boolean(draft?.session?.intake_review_active || draft?.session?.intake_item_ids?.length);
}

export function intakeReviewBlocksWrite(draft: DraftDocument, tool: string): boolean {
  return intakeReviewInProgress(draft) && INTAKE_REVIEW_BLOCKED_WRITES.has(tool);
}

export function removeIntakeReviewTools(
  tools: Record<string, unknown>,
  draft: DraftDocument,
): string[] {
  if (!intakeReviewInProgress(draft)) return [];
  const removed: string[] = [];
  for (const name of INTAKE_REVIEW_REMOVED_TOOLS) {
    if (name in tools) {
      delete tools[name];
      removed.push(name);
    }
  }
  return removed;
}

export type IntakeSelectionStatus = "open" | "all_decided" | "unknown";

export async function intakeSelectionStatus(
  db: Executor,
  tenant_id: string,
  draft: DraftDocument,
): Promise<IntakeSelectionStatus> {
  const ids = draft.session?.intake_item_ids ?? [];
  if (ids.length === 0) return "unknown";
  try {
    const items = await Promise.all(ids.map((id) => getIntakeItem(tenant_id, id, db)));
    if (items.some((item) => item === null)) return "unknown";
    return items.every((item) => item?.state === "admitted" || item?.state === "discarded")
      ? "all_decided"
      : "open";
  } catch {
    return "unknown";
  }
}

export const INTAKE_REVIEW_KNOWLEDGE_EDIT_NOTE =
  "This conversation is an intake review. Tools that create, edit or analyze knowledge sources directly are not available here, and connector, workflow and playbook tools never edit knowledge. Existing knowledge is edited in a normal chat: offer the person to open a new chat for that change. Here you can only read the selected items and create or revise intake proposals, which a person confirms in the review. Answer in the language of the person's latest message; the first message of a review can be an English prompt written by a tool, so switch as soon as the person writes in another language.";

const ALL_DECIDED_NOTE =
  "Every item selected for this review is already admitted or discarded, so there is nothing left to propose from them. Say so plainly. If the person wants to change knowledge that came from them, offer a normal chat for that edit.";

export function intakeReviewNote(status: IntakeSelectionStatus): string {
  return status === "all_decided"
    ? `${INTAKE_REVIEW_KNOWLEDGE_EDIT_NOTE} ${ALL_DECIDED_NOTE}`
    : INTAKE_REVIEW_KNOWLEDGE_EDIT_NOTE;
}
