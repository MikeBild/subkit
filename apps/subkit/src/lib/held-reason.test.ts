import { describe, expect, test } from "bun:test";
import { HELD_REASONS, heldReasonLine } from "./held-reason.ts";

describe("heldReasonLine", () => {
  test("every held reason has its own plain sentence", () => {
    const lines = HELD_REASONS.map((reason) => heldReasonLine(reason));
    expect(HELD_REASONS).toEqual([
      "execution_authority_required",
      "execution_authority_expired",
      "execution_authority_exhausted",
      "execution_authority_revoked",
      "execution_authority_changed",
      "input_required",
    ]);
    expect(new Set(lines).size).toBe(HELD_REASONS.length);
    for (const line of lines) expect(line?.endsWith(".")).toBe(true);
  });

  test("an unknown, inherited or missing reason has no sentence", () => {
    expect(heldReasonLine("made_up")).toBeNull();
    expect(heldReasonLine("toString")).toBeNull();
    expect(heldReasonLine(null)).toBeNull();
    expect(heldReasonLine(undefined)).toBeNull();
  });
});
