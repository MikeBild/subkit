import { describe, expect, test } from "bun:test";
import { assistantIntakeRequestId, decideIntakeConfirmer } from "./intake-policy.ts";

const ada = { kind: "user", id: "u-ada" };
const bob = { kind: "user", id: "u-bob" };

describe("decideIntakeConfirmer", () => {
  test("without the pair policy a person confirms their own proposal", () => {
    expect(decideIntakeConfirmer({ policy: "single", proposer: ada, confirmer: ada })).toBe(
      "allowed",
    );
  });

  test("under the pair policy the proposer cannot confirm their own proposal", () => {
    expect(decideIntakeConfirmer({ policy: "pair", proposer: ada, confirmer: ada })).toBe(
      "own_proposal",
    );
  });

  test("under the pair policy a second person confirms", () => {
    expect(decideIntakeConfirmer({ policy: "pair", proposer: ada, confirmer: bob })).toBe(
      "allowed",
    );
  });

  test("the same id of a different kind is another party", () => {
    expect(
      decideIntakeConfirmer({
        policy: "pair",
        proposer: { kind: "system_account", id: "u-ada" },
        confirmer: ada,
      }),
    ).toBe("allowed");
  });

  test("a proposal without a known author does not block the reviewer", () => {
    expect(
      decideIntakeConfirmer({
        policy: "pair",
        proposer: { kind: "user", id: null },
        confirmer: ada,
      }),
    ).toBe("allowed");
  });
});

describe("assistantIntakeRequestId", () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  test("is a stable uuid for the same request", () => {
    const a = assistantIntakeRequestId(["conv-1", "inline", "Refunds", "text"]);
    expect(a).toMatch(UUID);
    expect(assistantIntakeRequestId(["conv-1", "inline", "Refunds", "text"])).toBe(a);
  });

  test("changes with the conversation, the title or the content", () => {
    const base = assistantIntakeRequestId(["conv-1", "inline", "Refunds", "text"]);
    expect(assistantIntakeRequestId(["conv-2", "inline", "Refunds", "text"])).not.toBe(base);
    expect(assistantIntakeRequestId(["conv-1", "inline", "Refund", "text"])).not.toBe(base);
    expect(assistantIntakeRequestId(["conv-1", "inline", "Refunds", "text2"])).not.toBe(base);
    expect(assistantIntakeRequestId(["conv-1", "inlineRefunds", "", "text"])).not.toBe(base);
  });
});
