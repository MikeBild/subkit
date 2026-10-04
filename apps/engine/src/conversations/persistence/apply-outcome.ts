import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import type { AnswerActor } from "../answer-actor.ts";
import { recordDeniedIntentIfDeclined } from "../declined-intent.ts";
import {
  type AutoPersistDispatch,
  maybeAutoPersistFromElicitation,
  maybeCacheDraftCredentialFromElicitation,
} from "./auto-persist.ts";

export interface ApplyElicitationOutcomeInput {
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  principal?: ResolvedPrincipal | null;
  answer_actor: AnswerActor;
  elicitation: {
    id: string;
    tool_name: string;
    input: unknown;
  };
  output: unknown;
  surface?: "sk_headless" | "sk_interactive" | "mcp" | "web" | "chat";
  db: Db;
}

export async function applyElicitationOutcome(
  p: ApplyElicitationOutcomeInput,
): Promise<AutoPersistDispatch> {
  await maybeCacheDraftCredentialFromElicitation({
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    elicitation_output: p.output,
    elicitation: { tool_name: p.elicitation.tool_name },
    db: p.db,
  });
  await recordDeniedIntentIfDeclined({
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    elicitation: { tool_name: p.elicitation.tool_name, input: p.elicitation.input },
    output: p.output,
    db: p.db,
  });
  return maybeAutoPersistFromElicitation({
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    actor_id: p.actor_id,
    answer_actor: p.answer_actor,
    ...(p.principal !== undefined ? { principal: p.principal } : {}),
    ...(p.surface ? { surface: p.surface } : {}),
    elicitation_output: p.output,
    elicitation: {
      id: p.elicitation.id,
      tool_name: p.elicitation.tool_name,
      input: p.elicitation.input,
    },
    db: p.db,
  });
}
