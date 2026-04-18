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
          hint: "The ref may have been evicted or expired. Re-run the original tool call.",
        },
      };
    }
    return { ok: true, data: { raw } };
  },
};
