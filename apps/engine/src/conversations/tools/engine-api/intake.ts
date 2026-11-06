import {
  type DiscardItemsInput,
  DiscardItemsToolInput,
  discardIntakeItemsOperationWith,
  getIntakeItemOperation,
  INTAKE_DISCARD_NEXT_ACTIONS,
  INTAKE_WRITE,
  intakeSourcesReadAtCurrentVersion,
  listIntakeCategoriesOperation,
  listIntakeItemsOperation,
  moveIntakeItemOperation,
  restoreIntakeItemOperation,
  selectedIntakeIds,
  setIntakeDefaultCategoryOperation,
} from "../../../api/operations/intake.ts";
import {
  createIntakeProposalOperation,
  reviseIntakeProposalOperation,
} from "../../../api/operations/intake-proposals.ts";
import { toConversationTool } from "../../../api/operations/tool.ts";
import type { ConversationTool, ToolContext, ToolPrecheck, ToolResult } from "../index.ts";
import { checkTenantPermission } from "../permission-gate.ts";
import { resolveGateSubjects, unresolvedGateSubjects } from "../sdk-wrap/gate-subjects.ts";

function discardRefusal(
  error: string,
  message: string,
  extra: Record<string, unknown> = {},
): ToolPrecheck {
  return {
    ok: false,
    result: {
      ok: false,
      error_code: error,
      message,
      data: { error, message, ...extra },
      next_best_actions: INTAKE_DISCARD_NEXT_ACTIONS,
    },
  };
}

async function discardPrecheck(ctx: ToolContext, rawArgs: unknown): Promise<ToolPrecheck> {
  const parsed = DiscardItemsToolInput.safeParse(rawArgs);
  if (!parsed.success) return { ok: true };
  if (!ctx.principal)
    return discardRefusal("human_actor_required", "Discarding intake items needs a person.");
  const ids = [...new Set(parsed.data.item_ids)];
  const selected = selectedIntakeIds(ctx);
  if (ctx.getDraft().session?.intake_review_locked && ids.some((id) => !selected.has(id)))
    return discardRefusal(
      "intake_item_not_selected",
      "Nothing ran. Only the items the person selected for this review can be discarded.",
    );
  const card = await resolveGateSubjects(
    "discard_intake_items",
    parsed.data,
    ctx.tenant_id,
    ctx.db,
  );
  if (card) {
    const { not_found, already_decided } = unresolvedGateSubjects("discard_intake_items", card);
    if (not_found.length > 0 || already_decided.length > 0) {
      const parts: string[] = [];
      if (not_found.length > 0)
        parts.push(`These intake item ids do not exist in this tenant: ${not_found.join(", ")}.`);
      if (already_decided.length > 0)
        parts.push(
          `These intake items are already discarded or admitted: ${already_decided.join(", ")}.`,
        );
      return discardRefusal(
        not_found.length > 0 ? "intake_item_not_found" : "intake_item_not_discardable",
        `Nothing ran and nobody was asked to confirm it. ${parts.join(" ")} Look the items up with list_intake_items and retry only with collected items you have read.`,
        { not_found, not_discardable: already_decided },
      );
    }
  }
  if (!(await intakeSourcesReadAtCurrentVersion(ctx, ids)))
    return discardRefusal(
      "intake_items_must_be_read",
      "Nothing ran. Read every item with get_intake_item at its current version before discarding it.",
    );
  return { ok: true };
}

async function discardGuard(
  { items }: DiscardItemsInput,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  if (!ctx.principal) return { ok: false, data: { error: "human_actor_required" } };
  for (const { id } of items) {
    const gate = await checkTenantPermission(ctx, INTAKE_WRITE, { type: "intake", id });
    if (!gate.allow)
      return {
        ok: false,
        data: { error: "permission_denied", permission: gate.permission, reason: gate.reason },
      };
  }
  return null;
}

function discardIntakeItemsTool(): ConversationTool {
  return toConversationTool(
    discardIntakeItemsOperationWith({ precheck: discardPrecheck, guard: discardGuard }),
  );
}

export const intakeTools: ConversationTool[] = [
  toConversationTool(listIntakeCategoriesOperation),
  toConversationTool(listIntakeItemsOperation),
  toConversationTool(getIntakeItemOperation),
  discardIntakeItemsTool(),
  toConversationTool(restoreIntakeItemOperation),
  toConversationTool(moveIntakeItemOperation),
  toConversationTool(setIntakeDefaultCategoryOperation),
  toConversationTool(createIntakeProposalOperation),
  toConversationTool(reviseIntakeProposalOperation),
];
