import { describe, expect, it } from "bun:test";
import { type ConfirmationState, isTerminalState } from "../confirmation.ts";

describe("confirmation state machine", () => {
  it("recognises terminal states", () => {
    const terminal: ConfirmationState[] = [
      "confirmed",
      "partial",
      "declined",
      "auto_declined",
      "oauth_success",
      "oauth_failure",
    ];
    for (const s of terminal) {
      expect(isTerminalState(s)).toBe(true);
    }
  });

  it("identifies proposed and tested as non-terminal", () => {
    expect(isTerminalState("proposed")).toBe(false);
    expect(isTerminalState("tested")).toBe(false);
  });
});
