import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { type AttentionV1, buildAttention } from "../../operator/attention.ts";

export const ATTENTION_TOOL_NAME = "get_attention";

export const attentionMcpTool: Tool = {
  name: ATTENTION_TOOL_NAME,
  description:
    "What needs the caller's attention now: own waiting conversations, held schedules and webhooks (a held item's `trigger` names which — a schedule or the webhook's slug), failing scheduled workflows with their open fixes, connectors and connections needing sign-in, prepared secret versions, skill proposals, a critical budget or risk signal. One item per thing to act on, filtered by the caller's permissions; `sources` says which parts could not be read.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: {
    title: "Attention",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export async function handleAttention(ctx: {
  db: Db;
  principal: ResolvedPrincipal;
}): Promise<{ ok: true; data: AttentionV1 }> {
  return { ok: true, data: await buildAttention(ctx.db, ctx.principal) };
}
