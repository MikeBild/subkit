import type { ResolvedPrincipal } from "../auth/types.ts";
import type { ApprovalGrantVia } from "../tools/approval.ts";

export type AnswerActor =
  | {
      readonly kind: "human";
      readonly user_id: string;
      readonly via: ApprovalGrantVia;
    }
  | {
      readonly kind: "relay";
      readonly reason: "model_tool_call" | "machine_principal";
    };

export function humanChatAnswer(principal: ResolvedPrincipal | null | undefined): AnswerActor {
  if (principal?.kind !== "user") return { kind: "relay", reason: "machine_principal" };
  return { kind: "human", user_id: principal.id, via: "chat" };
}

export function humanInBandAnswer(principal: ResolvedPrincipal | null | undefined): AnswerActor {
  if (principal?.kind !== "user") return { kind: "relay", reason: "machine_principal" };
  return { kind: "human", user_id: principal.id, via: "in_band_elicitation" };
}

export function humanPortalAnswer(user_id: string | null | undefined): AnswerActor {
  if (!user_id) return { kind: "relay", reason: "machine_principal" };
  return { kind: "human", user_id, via: "portal" };
}

export const MODEL_RELAYED_ANSWER: AnswerActor = { kind: "relay", reason: "model_tool_call" };
