import { describe, expect, it } from "bun:test";
import { ToolChoiceViolationError } from "ai";
import { answeredDespiteToolChoice, throwForStreamError } from "./stream-result.ts";

function violation(content: ToolChoiceViolationError["content"]): ToolChoiceViolationError {
  return new ToolChoiceViolationError({
    toolChoice: { type: "required" },
    finishReason: "stop",
    provider: "mock",
    modelId: "mock",
    content,
  });
}

describe("throwForStreamError", () => {
  it("surfaces an error captured from a failed model stream", () => {
    const error = new Error("context length exceeded");
    expect(() => throwForStreamError("error", error)).toThrow(error);
  });

  it("surfaces a failure when the stream omitted its error detail", () => {
    expect(() => throwForStreamError("error", null)).toThrow(
      "Conversation model stream failed without an error detail.",
    );
  });

  it("does not reject a completed stream", () => {
    expect(() => throwForStreamError("stop", new Error("recovered retry"))).not.toThrow();
  });

  it("keeps a text answer when the model ignored a required tool choice", () => {
    const answered = violation([{ type: "text", text: "Here is the answer." }]);
    expect(answeredDespiteToolChoice(answered)).toBe(true);
    expect(() => throwForStreamError("error", answered)).not.toThrow();
  });

  it("still fails when the model ignored the tool choice without any text", () => {
    const silent = violation([{ type: "text", text: "  " }]);
    expect(answeredDespiteToolChoice(silent)).toBe(false);
    expect(() => throwForStreamError("error", silent)).toThrow(silent);
    expect(answeredDespiteToolChoice(violation([]))).toBe(false);
  });

  it("does not keep text when the model called a different tool than the one required", () => {
    const otherTool = violation([
      { type: "text", text: "I'll save that now." },
      { type: "tool-call", toolCallId: "call-1", toolName: "ask_user_confirm", input: "{}" },
    ]);
    expect(answeredDespiteToolChoice(otherTool)).toBe(false);
    expect(() => throwForStreamError("error", otherTool)).toThrow(otherTool);
  });

  it("does not treat other stream errors as an answer", () => {
    expect(answeredDespiteToolChoice(new Error("Here is the answer."))).toBe(false);
  });
});
