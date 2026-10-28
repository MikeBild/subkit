import type { Executor } from "../../../db/client.ts";
import { getIntakeItem } from "../../../knowledge/intake.ts";
import type { DraftDocument } from "../../types.ts";

export const INTAKE_REVIEW_REMOVED_TOOLS: readonly string[] = [
  "create_knowledge_source",
  "update_knowledge_source",
  "analyze_knowledge_source",
];

export const INTAKE_ITEM_DEPENDENT_TOOLS: ReadonlySet<string> = new Set([
  "create_intake_proposal",
  "revise_intake_proposal",
  "discard_intake_items",
  "restore_intake_item",
  "move_intake_item",
]);

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
  "This conversation is an intake review. Tools that create, edit or analyze knowledge sources directly are not available here, and connector, workflow and playbook tools never edit knowledge. To add material from a selected open item to an existing knowledge bundle, create an intake proposal whose target is {knowledge_source_id} (an id from list_knowledge_sources or get_knowledge_source, never an intake item id); a person confirms it in the review. Any other change to existing knowledge, including material from items someone decided earlier, is edited in a normal chat: offer the person to open a new chat for that change. Answer in the language of the person's latest message; the first message of a review can be an English prompt written by a tool, so switch as soon as the person writes in another language.";

const ALL_DECIDED_NOTE =
  "Every item selected for this review is already admitted or discarded, so there is nothing left to propose from them. Say so plainly. If the person wants to change knowledge that came from them, offer a normal chat for that edit.";

const GERMAN_WORDS = new Set([
  "der",
  "die",
  "das",
  "den",
  "dem",
  "ein",
  "eine",
  "einen",
  "und",
  "oder",
  "nicht",
  "bitte",
  "ich",
  "mit",
  "für",
  "fuer",
  "ist",
  "sind",
  "zu",
  "auf",
  "wie",
  "was",
  "wissen",
  "quelle",
  "wissensquelle",
  "eintrag",
  "schlage",
  "lege",
  "dafür",
  "dafuer",
  "ergänze",
  "ergaenze",
  "aktualisiere",
  "beschreibung",
  "doch",
  "neue",
  "neuen",
  "namen",
]);

export function writesGerman(text: string | null | undefined): boolean {
  if (!text) return false;
  const words = text.toLowerCase().match(/[a-zäöüß]+/g) ?? [];
  return words.filter((word) => GERMAN_WORDS.has(word)).length >= 2;
}

const GERMAN_REPLY_NOTE = "Write your reply in German.";

export function intakeReviewNote(
  status: IntakeSelectionStatus,
  latestUserMessage?: string | null,
  locale?: "de" | "en",
): string {
  const base =
    status === "all_decided"
      ? `${INTAKE_REVIEW_KNOWLEDGE_EDIT_NOTE} ${ALL_DECIDED_NOTE}`
      : INTAKE_REVIEW_KNOWLEDGE_EDIT_NOTE;
  return locale === "de" || writesGerman(latestUserMessage) ? `${base} ${GERMAN_REPLY_NOTE}` : base;
}
