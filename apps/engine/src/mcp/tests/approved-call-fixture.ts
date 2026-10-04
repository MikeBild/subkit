import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import { grantApproval } from "../../tools/approval.ts";
import type { McpTestSuite } from "./setup.ts";

export async function replayHumanGrantedMcpCall(
  suite: McpTestSuite,
  client: Client,
  pending: Awaited<ReturnType<Client["callTool"]>>,
) {
  const content = pending.content as Array<{ type: string; text: string }>;
  const boundary = z
    .object({
      status: z.literal("needs_confirm"),
      tool: z.string().min(1),
      tool_call_id: z.string().uuid(),
    })
    .parse(JSON.parse(content[0]?.text ?? "{}"));
  const granted = await grantApproval({
    db: suite.http.db,
    tenant_id: suite.http.tenantId,
    approval_id: boundary.tool_call_id,
    granted_by_user_id: suite.http.userId,
    via: "portal",
  });
  if (!granted.ok) throw new Error(`human fixture grant failed: ${granted.code}`);
  return client.callTool({
    name: "confirm_tool_call",
    arguments: { tool: boundary.tool, confirm_id: boundary.tool_call_id },
  });
}
