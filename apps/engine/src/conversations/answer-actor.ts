// WHO produced the answer that resumes a paused conversation.
//
// An approval is granted by a PERSON. Everything downstream of a resume —
// `grantApproval`, `declineApproval` — needs to know whether the answer it is
// about to act on came from one. The engine cannot read that off the principal:
// an MCP `conversation_respond_elicitation` call authenticates as the very same
// user principal the HTTP `/respond` route does, and the model is the one
// calling it. `principal.kind === "user"` says who the request runs as, never
// who answered.
//
// So the CHANNEL declares it, and the declaration is a required argument.
// `RespondElicitationParams.answer_actor` and `RunConversationTurnParams.answer_actor`
// have no default: a surface that forgets to say does not compile, and the only
// way to produce the `human` variant is to hand a user principal to one of the
// two constructors below. A `relay` can never grant.
//
// The two human channels, and why each is one:
//   - `humanChatAnswer` — a person clicked the approval card or typed the answer
//     in an authenticated session (HTTP `/respond`, the sk REPL behind it, a
//     Slack/Teams/Google Chat interaction). 244 of these resolved in production.
//   - `humanInBandAnswer` — an MCP client actually FULFILLED an
//     `elicitation/create` round-trip, which it can only do by showing a person
//     the prompt. Production has never once seen this on the MCP tool surface
//     (29 prompts, 29 timeouts, 0 answers), which is exactly why it is an
//     optimization and not the contract.
//
// Everything else is a `relay`: a machine carried an answer across a wire.
// A relay resume is not refused — it simply grants nothing, and `consumeApproval`
// then answers `approval_not_granted` because it claims only a granted row. That
// is the same trigger-not-gate shape `confirm_tool_call` has on MCP: every caller
// may try, and it succeeds only if a person already said yes.

import type { ResolvedPrincipal } from "../auth/types.ts";
import type { ApprovalGrantVia } from "../tools/approval.ts";

export type AnswerActor =
  | {
      readonly kind: "human";
      /** The person who answered. Recorded as `granted_by_user_id`. */
      readonly user_id: string;
      /** The human channel they answered through — `tool_approvals.granted_via`. */
      readonly via: Extract<ApprovalGrantVia, "chat" | "in_band_elicitation">;
    }
  | {
      readonly kind: "relay";
      /** Why no person is attributable. Structured-log only. */
      readonly reason: "model_tool_call" | "machine_principal";
    };

/** A person answering in an authenticated session — the chat card, the sk REPL,
 *  a Slack/Teams/Google Chat interaction. A non-user principal is a machine
 *  holding an API key, so it degrades to a relay rather than lying about who
 *  approved. */
export function humanChatAnswer(principal: ResolvedPrincipal | null | undefined): AnswerActor {
  if (principal?.kind !== "user") return { kind: "relay", reason: "machine_principal" };
  return { kind: "human", user_id: principal.id, via: "chat" };
}

/** A person answering an MCP `elicitation/create` prompt the client actually
 *  fulfilled. Only reachable from the in-process bridge, which is the only code
 *  that knows the round-trip returned an `accept`. */
export function humanInBandAnswer(principal: ResolvedPrincipal | null | undefined): AnswerActor {
  if (principal?.kind !== "user") return { kind: "relay", reason: "machine_principal" };
  return { kind: "human", user_id: principal.id, via: "in_band_elicitation" };
}

/** A model called the tool that carried this answer. Grants nothing. */
export const MODEL_RELAYED_ANSWER: AnswerActor = { kind: "relay", reason: "model_tool_call" };
