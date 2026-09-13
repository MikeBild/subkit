// `list_draft_snapshots` — show the operator the snapshot history for
// the active conversation. Read-only; pairs with
// `restore_draft_snapshot` for the rollback flow.

import { z } from "@hono/zod-openapi";

import { listDraftSnapshots } from "../draft-checkpoints.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    limit: z.number().int().min(1).max(50).default(10),
  })
  .openapi("ListDraftSnapshotsToolInput");

export const listDraftSnapshotsTool: ConversationTool = {
  name: "list_draft_snapshots",
  description:
    "List draft snapshots captured for this conversation, newest first. Use before `restore_draft_snapshot` to pick a target.",
  inputSchema,
  category: "tenant_read" as const,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const snapshots = await listDraftSnapshots(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        limit: args.limit,
      },
      ctx.db,
    );
    return {
      ok: true,
      data: {
        count: snapshots.length,
        snapshots: snapshots.map((s) => ({
          id: s.id,
          turn_index: s.turn_index,
          label: s.label,
          snapshot_at: s.snapshot_at,
        })),
      },
    };
  },
};
