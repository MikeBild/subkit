import { elicitationInputForClient } from "./tools/ask-user/commit-intent.ts";

export interface PendingElicitationSummary {
  id: string;
  tool_name: string;
  summary: string;
  tool_call_id?: string | null;
  input?: unknown;
}

export class ConversationNotFoundError extends Error {
  readonly code = "CONVERSATION_NOT_FOUND";
  constructor(public readonly conversation_id: string) {
    super(`conversation not found in this tenant: ${conversation_id}`);
  }
}

export class PendingElicitationBlockedError extends Error {
  readonly code = "pending_elicitation_blocked";
  readonly pending_elicitation: PendingElicitationSummary;

  constructor(pending: PendingElicitationSummary) {
    super("resolve the pending dialog before sending another prompt");
    this.name = "PendingElicitationBlockedError";
    this.pending_elicitation =
      "input" in pending
        ? { ...pending, input: elicitationInputForClient(pending.input) }
        : pending;
  }
}

export class ElicitationAlreadyResolvedError extends Error {
  readonly elicitation_id: string;
  readonly status: "resolved" | "cancelled" | "timeout";
  readonly previous_output: unknown;
  readonly previous_decision_reason: string | null;

  constructor(p: {
    elicitation_id: string;
    status: "resolved" | "cancelled" | "timeout";
    previous_output: unknown;
    previous_decision_reason: string | null;
  }) {
    super(`elicitation ${p.elicitation_id} is already ${p.status}`);
    this.name = "ElicitationAlreadyResolvedError";
    this.elicitation_id = p.elicitation_id;
    this.status = p.status;
    this.previous_output = p.previous_output;
    this.previous_decision_reason = p.previous_decision_reason;
  }
}

export class ElicitationActorMismatchError extends Error {
  readonly code = "ELICITATION_ACTOR_MISMATCH";
  constructor(
    public readonly conversation_id: string,
    public readonly actor_id: string | null,
  ) {
    super(`actor ${actor_id ?? "(anon)"} is not the owner of conversation ${conversation_id}`);
  }
}

export class ElicitationAnswerActorUnavailableError extends Error {
  readonly code = "ELICITATION_ANSWER_ACTOR_UNAVAILABLE";
  constructor(public readonly user_id: string) {
    super(`human answer actor ${user_id} is not an active user in this tenant`);
  }
}

export class ElicitationNotFoundError extends Error {
  readonly code = "ELICITATION_NOT_FOUND";
  constructor(public readonly elicitation_id: string) {
    super(`elicitation ${elicitation_id} not found in this tenant`);
  }
}

export class ElicitationValidationError extends Error {
  readonly pending_elicitation: {
    id: string;
    tool_name: string;
    summary: string;
    input: unknown;
  };
  readonly code = "ELICITATION_VALIDATION_FAILED";
  constructor(
    public readonly elicitation_id: string,
    public readonly field_errors: Array<{ name: string; message: string }>,
    pending_elicitation: {
      id: string;
      tool_name: string;
      summary: string;
      input: unknown;
    },
  ) {
    super(
      `elicitation answer failed validation: ${field_errors
        .map((e) => `${e.name}: ${e.message}`)
        .join("; ")}`,
    );
    this.pending_elicitation = {
      ...pending_elicitation,
      input: elicitationInputForClient(pending_elicitation.input),
    };
  }
}

export class ConversationTurnInProgressError extends Error {
  readonly code = "conversation_turn_in_progress";
  constructor() {
    super(
      "A response is already running for this conversation. Wait for it to finish before sending another message.",
    );
  }
}
