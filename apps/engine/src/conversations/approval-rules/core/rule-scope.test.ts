import { describe, expect, test } from "bun:test";
import type { BoundAction } from "../../instruction-cover/bound-action.ts";
import { MAX_RULE_RECIPIENTS, ruleEligible, scopeOf } from "./rule-scope.ts";

function action(over: Partial<BoundAction> = {}): BoundAction {
  return {
    tool: "call_connector",
    verb: "send",
    verbs: ["send"],
    effect_class: "ordinary",
    target: "POST /v1/messages/send",
    account: "mail",
    recipients: ["b@example.test", "a@example.test", "b@example.test"],
    content_summary: null,
    draft: false,
    ...over,
  };
}

describe("the scope a rule is limited to", () => {
  test("names tool, verb, account, target and the sorted distinct recipients", () => {
    expect(scopeOf(action())).toEqual({
      tool: "call_connector",
      verb: "send",
      account: "mail",
      target: "POST /v1/messages/send",
      recipients: ["a@example.test", "b@example.test"],
    });
  });
});

describe("which actions can get a rule at all", () => {
  test("an ordinary action with a target and few recipients can", () => {
    expect(ruleEligible(action())).toBe(true);
  });

  test("an action that always asks cannot", () => {
    expect(ruleEligible(action({ effect_class: "deletion" }))).toBe(false);
    expect(ruleEligible(action({ verbs: [] }))).toBe(false);
  });

  test("an action without a target cannot", () => {
    expect(ruleEligible(action({ target: null }))).toBe(false);
  });

  test("the recipient limit is inclusive", () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) => `p${index}@example.test`);
    expect(ruleEligible(action({ recipients: many(MAX_RULE_RECIPIENTS) }))).toBe(true);
    expect(ruleEligible(action({ recipients: many(MAX_RULE_RECIPIENTS + 1) }))).toBe(false);
  });
});
