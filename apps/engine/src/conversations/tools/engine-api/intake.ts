import { z } from "@hono/zod-openapi";
import {
  getIntakeItemOperation,
  intakeReadVersions,
  intakeSourcesReadAtCurrentVersion,
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
import * as intake from "../../../knowledge/index.ts";
import type { ConversationTool, ToolPrecheck, ToolResult } from "../index.ts";
import { checkTenantPermission } from "../permission-gate.ts";
import { resolveGateSubjects, unresolvedGateSubjects } from "../sdk-wrap/gate-subjects.ts";
import { toolActor } from "../tool-actor.ts";

const ListCategoriesInput = z.object({}).openapi("ListIntakeCategoriesToolInput");
const MAX_DISCARD_BATCH = 100;
const DiscardItemsInput = z
  .object({ item_ids: z.array(z.string().uuid()).min(1).max(MAX_DISCARD_BATCH) })
  .openapi("DiscardIntakeItemsToolInput");
function actor(ctx: Parameters<ConversationTool["execute"]>[0]) {
  return toolActor(ctx);
}

const listIntakeItemsTool: ConversationTool = toConversationTool(listIntakeItemsOperation);

const listIntakeCategoriesTool: ConversationTool = {
  name: "list_intake_categories",
  description:
    "List shared categories that contain collected clips and the caller's personal default category. Categories organize intake; they do not make a clip regular knowledge.",
  inputSchema: ListCategoriesInput,
  category: "tenant_read",
  permission: { action: "intake:read", resourceType: "intake" },
  async execute(ctx) {
    const caller = actor(ctx);
    if (!caller) return { ok: false, data: { error: "human_actor_required" } };
    return {
      ok: true,
      data: await intake.listIntakeCategories({ tenant_id: ctx.tenant_id, actor: caller }, ctx.db),
    };
  },
};

type DiscardOutcome = "discarded" | "not_found" | "not_discardable" | "changed";

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
      next_best_actions: ["list_intake_items", "get_intake_item"],
    },
  };
}

async function discardPrecheck(
  ctx: Parameters<ConversationTool["execute"]>[0],
  rawArgs: unknown,
): Promise<ToolPrecheck> {
  const parsed = DiscardItemsInput.safeParse(rawArgs);
  if (!parsed.success) return { ok: true };
  if (!actor(ctx))
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

const discardIntakeItemsTool: ConversationTool = {
  name: "discard_intake_items",
  description:
    "Discard one or more collected intake items you have read (1-100 ids; one confirmation covers the batch and shows each item's stored title). Discarding keeps the original source and can be undone with restore_intake_item; it never deletes or publishes knowledge or skills. Unknown, already discarded, admitted or unread items fail the whole call before anyone is asked to confirm. Returns one outcome per item.",
  inputSchema: DiscardItemsInput,
  category: "tenant_write",
  permission: {
    action: "intake:write",
    resourceType: "intake",
    resolveResourceId: async (_ctx, rawArgs) => {
      const ids = rawArgs.item_ids;
      return Array.isArray(ids) && typeof ids[0] === "string" ? ids[0] : null;
    },
  },
  requires_draft: true,
  precheck: discardPrecheck,
  async execute(ctx, args: z.infer<typeof DiscardItemsInput>): Promise<ToolResult> {
    const caller = actor(ctx);
    if (!caller) return { ok: false, data: { error: "human_actor_required" } };
    const ids = [...new Set(args.item_ids)];
    for (const id of ids) {
      const gate = await checkTenantPermission(ctx, "intake:write", { type: "intake", id });
      if (!gate.allow)
        return {
          ok: false,
          data: { error: "permission_denied", permission: gate.permission, reason: gate.reason },
        };
    }
    const reads = intakeReadVersions(ctx);
    const results: Array<{ id: string; title: string | null; outcome: DiscardOutcome }> = [];
    for (const id of ids) {
      const current = await intake.getIntakeItem(ctx.tenant_id, id, ctx.db);
      if (!current) {
        results.push({ id, title: null, outcome: "not_found" });
        continue;
      }
      if (current.state === "discarded" || current.state === "admitted") {
        results.push({ id, title: current.title, outcome: "not_discardable" });
        continue;
      }
      const expected = reads[id];
      if (expected !== current.version) {
        results.push({ id, title: current.title, outcome: "changed" });
        continue;
      }
      try {
        const item = await intake.patchIntakeItem(
          {
            tenant_id: ctx.tenant_id,
            actor: caller,
            id,
            expected_version: expected,
            state: "discarded",
          },
          ctx.db,
        );
        results.push({
          id,
          title: item?.title ?? current.title,
          outcome: item ? "discarded" : "not_found",
        });
      } catch (error) {
        if (!(error instanceof intake.IntakeConflictError)) throw error;
        results.push({ id, title: current.title, outcome: "changed" });
      }
    }
    const count = (outcome: DiscardOutcome) => results.filter((r) => r.outcome === outcome).length;
    const data = {
      results,
      discarded: count("discarded"),
      not_found: count("not_found"),
      not_discardable: count("not_discardable"),
      changed: count("changed"),
    };
    if (data.discarded > 0) return { ok: true, data };
    const message = `Nothing was discarded. The confirmed items changed before the discard ran: ${data.not_found} no longer exist, ${data.not_discardable} were already discarded or admitted, and ${data.changed} changed since they were read. Read them again before retrying.`;
    return {
      ok: false,
      error_code: "intake_items_changed",
      message,
      data: { ...data, error: "intake_items_changed", message },
      next_best_actions: ["list_intake_items", "get_intake_item"],
    };
  },
};

const restoreIntakeItemTool: ConversationTool = toConversationTool(restoreIntakeItemOperation);

const moveIntakeItemTool: ConversationTool = toConversationTool(moveIntakeItemOperation);

const getIntakeItemTool: ConversationTool = toConversationTool(getIntakeItemOperation);

const setDefaultIntakeCategoryTool: ConversationTool = toConversationTool(
  setIntakeDefaultCategoryOperation,
);

const createIntakeProposalTool: ConversationTool = toConversationTool(
  createIntakeProposalOperation,
);

const reviseIntakeProposalTool: ConversationTool = toConversationTool(
  reviseIntakeProposalOperation,
);

export const intakeTools: ConversationTool[] = [
  listIntakeCategoriesTool,
  listIntakeItemsTool,
  getIntakeItemTool,
  discardIntakeItemsTool,
  restoreIntakeItemTool,
  moveIntakeItemTool,
  setDefaultIntakeCategoryTool,
  createIntakeProposalTool,
  reviseIntakeProposalTool,
];
