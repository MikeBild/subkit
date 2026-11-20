import { and, eq, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { conversationElicitations, conversations } from "../../db/schema/index.ts";
import { hasBuiltinAdminRole } from "../../rbac/evaluator.ts";
import { resolveElicitationAndReactivate } from "../elicitations.ts";
import { normalizeConfirmOutput } from "../tools/ask-user/interpret-confirm.ts";
import { TaskRunWriteForbiddenError } from "./task-run-errors.ts";

export async function answerElicitationAsPerson(
  db: Db,
  p: {
    tenant_id: string;
    conversation_id: string;
    elicitation_id: string;
    principal: ResolvedPrincipal;
    output: unknown;
  },
): Promise<boolean> {
  const [conversation] = await db
    .select({ owner_id: conversations.owner_id })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)))
    .limit(1);
  if (!conversation) return false;
  if (
    p.principal.kind !== "user" ||
    p.principal.tenant_id !== p.tenant_id ||
    (conversation.owner_id !== p.principal.id && !hasBuiltinAdminRole(p.principal))
  )
    throw new TaskRunWriteForbiddenError();
  const [pending] = await db
    .select({ id: conversationElicitations.id })
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, p.tenant_id),
        eq(conversationElicitations.conversation_id, p.conversation_id),
        eq(conversationElicitations.id, p.elicitation_id),
        eq(conversationElicitations.status, "pending"),
        eq(conversationElicitations.tool_name, "ask_user_confirm"),
        sql`${conversationElicitations.input}->'commit_intent' IS NULL`,
      ),
    )
    .limit(1);
  if (!pending) return false;
  const resolution = await resolveElicitationAndReactivate(
    {
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      id: p.elicitation_id,
      output: normalizeConfirmOutput(p.output),
      decided_by: { id: p.principal.id, kind: "user" },
    },
    db,
  );
  return resolution.kind === "resolved";
}
