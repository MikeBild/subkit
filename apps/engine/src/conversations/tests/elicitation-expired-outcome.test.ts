import { describe, expect, test } from "bun:test";
import { type ElicitationExpiryReason, expiredToolCallUpdate } from "../elicitations.ts";

const REASONS: ElicitationExpiryReason[] = [
  "prompt_expired",
  "credential_setup_expired",
  "approval_expired",
  "approval_abandoned",
];

describe("expired elicitation tool call", () => {
  for (const reason of REASONS) {
    test(`${reason} is reported as expired, not as a refusal`, () => {
      const update = expiredToolCallUpdate(reason);
      expect(update.confirmation_state).toBe("expired");
      expect(update.output.outcome).toBe("expired");
      expect(update.output.reason).toBe(reason);
      expect(update.output.ok).toBe(false);
      expect(typeof update.output.note).toBe("string");
    });
  }

  test("the stored column records expiry separately from a refusal", () => {
    expect(expiredToolCallUpdate("prompt_expired").outcome).toBe("expired");
  });
});
