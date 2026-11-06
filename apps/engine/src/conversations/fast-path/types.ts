import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import type { AnswerActor } from "../answer-actor.ts";
import type { ConversationStatus, TurnEvent } from "../types.ts";

export type FastPathStatus = "active" | "awaiting_input";

export interface FastPathHit {
  status: ConversationStatus;
  events: TurnEvent[];
  pending_elicitation_id?: string;
  fast_path_tool: string;
  assistant_text: string | null;
}

export interface FastPathParams {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  principal: ResolvedPrincipal;
  user_message: string;
  answer_actor: AnswerActor;
  surface?: "sk_headless" | "sk_interactive" | "mcp" | "web" | "chat";
}
