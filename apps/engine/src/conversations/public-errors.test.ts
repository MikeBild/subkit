import { describe, expect, test } from "bun:test";
import * as contracts from "./errors.ts";
import * as publicTypes from "./types.ts";

describe("public conversation errors", () => {
  test("exports the same error constructors through the public contract", () => {
    expect(publicTypes.ConversationNotFoundError).toBe(contracts.ConversationNotFoundError);
    expect(publicTypes.PendingElicitationBlockedError).toBe(
      contracts.PendingElicitationBlockedError,
    );
    expect(publicTypes.ElicitationAlreadyResolvedError).toBe(
      contracts.ElicitationAlreadyResolvedError,
    );
    expect(publicTypes.ElicitationActorMismatchError).toBe(contracts.ElicitationActorMismatchError);
    expect(publicTypes.ElicitationAnswerActorUnavailableError).toBe(
      contracts.ElicitationAnswerActorUnavailableError,
    );
    expect(publicTypes.ElicitationNotFoundError).toBe(contracts.ElicitationNotFoundError);
    expect(publicTypes.ElicitationValidationError).toBe(contracts.ElicitationValidationError);
    expect(publicTypes.ConversationTurnInProgressError).toBe(
      contracts.ConversationTurnInProgressError,
    );
  });

  test("removes approval handles from blocked and invalid dialog payloads without mutation", () => {
    const input = {
      commit_intent: { kind: "run_workflow", payload: { approval_id: "private", value: 7 } },
    };
    const pending = { id: "dialog", tool_name: "ask_user_form", summary: "Answer", input };
    const blocked = new publicTypes.PendingElicitationBlockedError(pending);
    const invalid = new publicTypes.ElicitationValidationError(
      "dialog",
      [{ name: "field", message: "required" }],
      pending,
    );
    expect(blocked.pending_elicitation.input).toEqual({
      commit_intent: { kind: "run_workflow", payload: { value: 7 } },
    });
    expect(invalid.pending_elicitation.input).toEqual(blocked.pending_elicitation.input);
    expect(input.commit_intent.payload.approval_id).toBe("private");
    expect(invalid.code).toBe("ELICITATION_VALIDATION_FAILED");
    expect(invalid.message).toBe("elicitation answer failed validation: field: required");
    expect(blocked.code).toBe("pending_elicitation_blocked");
  });

  test("preserves resolved-dialog details and tenant lookup failure contracts", () => {
    const previous_output = { answer: "yes" };
    const resolved = new publicTypes.ElicitationAlreadyResolvedError({
      elicitation_id: "dialog",
      status: "resolved",
      previous_output,
      previous_decision_reason: "confirmed",
    });
    expect(resolved.previous_output).toBe(previous_output);
    expect(resolved.previous_decision_reason).toBe("confirmed");
    expect(resolved.status).toBe("resolved");
    expect(new publicTypes.ConversationNotFoundError("conversation").code).toBe(
      "CONVERSATION_NOT_FOUND",
    );
    expect(new publicTypes.ElicitationActorMismatchError("conversation", null).message).toBe(
      "actor (anon) is not the owner of conversation conversation",
    );
  });
});
