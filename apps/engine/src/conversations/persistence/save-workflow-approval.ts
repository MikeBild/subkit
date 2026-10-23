import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { conversationElicitations } from "../../db/schema/index.ts";

export interface PriorSaveWorkflowApproval {
  id: string;
  status: string;
  created_at: Date | null;
}

export function rowAuthorizesSaveWorkflow(row: {
  status: string;
  input: unknown;
  output: unknown;
}): boolean {
  if (row.status !== "resolved") return false;
  const output = row.output;
  if (typeof output !== "object" || output === null) return false;
  if ((output as { confirmed?: unknown }).confirmed !== true) return false;
  const input = row.input;
  if (typeof input !== "object" || input === null) return false;
  const commitIntent = (input as { commit_intent?: unknown }).commit_intent;
  if (typeof commitIntent !== "object" || commitIntent === null) return false;
  return (commitIntent as { kind?: unknown }).kind === "save_workflow_draft";
}

export async function findPriorSaveWorkflowApproval(
  exec: Db,
  tenant_id: string,
  conversation_id: string,
): Promise<PriorSaveWorkflowApproval | null> {
  const rows = await exec
    .select({
      id: conversationElicitations.id,
      status: conversationElicitations.status,
      input: conversationElicitations.input,
      output: conversationElicitations.output,
      created_at: conversationElicitations.created_at,
    })
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, tenant_id),
        eq(conversationElicitations.conversation_id, conversation_id),
        eq(conversationElicitations.tool_name, "ask_user_confirm"),
      ),
    )
    .orderBy(desc(conversationElicitations.created_at));
  for (const row of rows) {
    if (rowAuthorizesSaveWorkflow(row)) {
      return { id: row.id, status: row.status, created_at: row.created_at };
    }
  }
  return null;
}

export async function saveApprovalReadiness(ctx: {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  permission_mode?: string | null | undefined;
}): Promise<"fresh" | "missing" | "not_required"> {
  if (ctx.permission_mode === "auto") return "not_required";
  const approval = await findPriorSaveWorkflowApproval(ctx.db, ctx.tenant_id, ctx.conversation_id);
  return approval ? "fresh" : "missing";
}
