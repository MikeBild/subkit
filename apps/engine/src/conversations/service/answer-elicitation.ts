import { and, eq, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { conversationElicitations } from "../../db/schema/index.ts";
import { canWriteConversation, conversationViewerOf } from "../core/access.ts";
import { resolveElicitationAndReactivate } from "../elicitations.ts";
import { loadConversationAccess } from "../persistence/conversation-access.ts";
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
  const facts = await loadConversationAccess(db, p.tenant_id, p.conversation_id);
  if (!facts) return false;
  if (
    p.principal.kind !== "user" ||
    !canWriteConversation(conversationViewerOf(p.principal), facts.row)
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
