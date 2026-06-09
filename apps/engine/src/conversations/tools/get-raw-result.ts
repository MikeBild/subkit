// get_raw_result — fetch the full untruncated payload of a prior
// tool result by its `raw_ref`.

import { z } from "@hono/zod-openapi";
import type { ConversationTool } from "./index.ts";
import { getRawResult } from "./truncate.ts";

const Input = z.object({ ref: z.string().min(1) }).openapi("GetRawResultToolInput");

export const getRawResultTool: ConversationTool = {
  name: "get_raw_result",
  description:
    "Retrieve the full, untruncated payload of a prior tool result by its `raw_ref`. Use when a previous tool output was truncated for context reasons and you need specific fields.",
  inputSchema: Input,
  category: "tenant_read",
  async execute(_ctx, rawArgs) {
    const args = Input.parse(rawArgs);
    const raw = getRawResult(args.ref);
    if (raw === undefined) {
      return {
        ok: false,
        data: {
          error: "raw_ref_not_found",
          hint: "This is NOT a permission or security block — the in-memory raw_ref simply expired or was evicted (refs are short-lived and capped). Re-run the original tool call to get a fresh raw_ref, then call get_raw_result again right away.",
        },
      };
    }
    return { ok: true, data: { raw } };
  },
};
