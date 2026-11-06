import type { ResolvedPrincipal } from "../../../auth/types.ts";
import type { Db } from "../../../db/client.ts";
import type { AnswerActor } from "../../answer-actor.ts";
import type { CommitIntent } from "../../tools/ask-user/commit-intent.ts";
import type { ToolContext, ToolResult } from "../../tools/index.ts";
import type { SyntheticToolResult } from "./synthetic.ts";

export interface AutoPersistInput {
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  principal?: ResolvedPrincipal | null;
  answer_actor: AnswerActor;
  elicitation_output: unknown;
  elicitation: {
    id: string;
    tool_name: string;
    input: unknown;
    tool_call_id?: string | null;
  };
  surface?: "sk_headless" | "sk_interactive" | "mcp" | "web" | "chat";
  db: Db;
}

export interface AutoPersistDispatch {
  dispatched: boolean;
  synthetic_result?: SyntheticToolResult;
  synthetic_tool_call_id?: string;
}

export interface CommitEnv {
  p: AutoPersistInput;
  intent: CommitIntent;
  ctx: ToolContext;
}

export interface CommitOutcome {
  toolName: string;
  result: ToolResult;
}
