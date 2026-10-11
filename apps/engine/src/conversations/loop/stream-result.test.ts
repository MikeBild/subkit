import { describe, expect, it } from "bun:test";
import { throwForStreamError } from "./stream-result.ts";

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
});
