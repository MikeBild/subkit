// `restore_draft_snapshot` — roll the conversation draft back to a
// previously-captured snapshot. Snapshots are auto-created after every
// successful `draft_write` tool (see `sdk-wrap.ts`); this tool lets
// the LLM walk one back when an edit went wrong.
//
// Pure roll-back — does NOT delete forward history. The next
// draft-mutating tool will create a fresh snapshot, so the operator
// can step backwards then forwards if needed.

import { z } from "@hono/zod-openapi";
import { getDraftSnapshot, listDraftSnapshots } from "../draft-checkpoints.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    snapshot_id: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Snapshot id to restore. Omit to roll back to the most recent snapshot — the previous draft state.",
      ),
  })
  .openapi("RestoreDraftSnapshotToolInput");

export const restoreDraftSnapshotTool: ConversationTool = {
  name: "restore_draft_snapshot",
  description:
    "Roll the conversation draft back to a previously captured snapshot. Use after a bad edit — the snapshot history records every successful draft mutation. Omit `snapshot_id` to roll back to the most recent snapshot.",
  inputSchema,
  category: "draft_write" as const,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);

    let snapshotId = args.snapshot_id;
    if (!snapshotId) {
      // Default: most-recent snapshot (newest-first ordering).
      const recent = await listDraftSnapshots(
        {
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          limit: 1,
        },
        ctx.db,
      );
      const head = recent[0];
      if (!head) {
        return {
          ok: false,
          data: {
            error_code: "no_snapshot_available",
            message:
              "no draft snapshots exist for this conversation yet — make a draft edit first, then restore is meaningful.",
          },
        };
      }
      snapshotId = head.id;
    }

    const snapshot = await getDraftSnapshot(
      { tenant_id: ctx.tenant_id, snapshot_id: snapshotId },
      ctx.db,
    );
    if (!snapshot || snapshot.conversation_id !== ctx.conversation_id) {
      return {
        ok: false,
        data: {
          error_code: "snapshot_not_found",
          message: `snapshot ${snapshotId} not found for this conversation`,
        },
      };
    }

    await ctx.setDraft(snapshot.draft);

    return {
      ok: true,
      data: {
        snapshot_id: snapshot.id,
        snapshot_at: snapshot.snapshot_at,
        label: snapshot.label,
        turn_index: snapshot.turn_index,
        message: `draft restored to snapshot from ${snapshot.snapshot_at}${snapshot.label ? ` (${snapshot.label})` : ""}`,
      },
    };
  },
};
