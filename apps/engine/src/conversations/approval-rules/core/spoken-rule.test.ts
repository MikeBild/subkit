import { describe, expect, test } from "bun:test";
import { describeBoundAction } from "../../instruction-cover/bound-action.ts";
import { scopeOf } from "./rule-scope.ts";
import { ruleFromWords } from "./spoken-rule.ts";

function send(to: string[]) {
  return describeBoundAction(
    "call_connector",
    { connector_id: "mail", method: "POST", path: "/v1/messages/send", body: { to } },
    to,
  );
}

const JANE = "jane@example.test";

describe("a rule a person states in their own words", () => {
  test("a standing permission that names the action and the recipient becomes its scope", () => {
    const action = send([JANE]);
    expect(
      ruleFromWords(
        `From now on you can send the weekly report to ${JANE} without asking.`,
        action,
      ),
    ).toEqual(scopeOf(action));
    expect(ruleFromWords(`Always email ${JANE} the report.`, action)).toEqual(scopeOf(action));
  });

  test("the scope is the action's, with recipients sorted and without duplicates", () => {
    const action = send(["zoe@example.test", JANE, JANE]);
    expect(
      ruleFromWords(`Always send it to zoe@example.test and ${JANE}.`, action)?.recipients,
    ).toEqual([JANE, "zoe@example.test"]);
  });

  test("a single request is not a rule", () => {
    expect(ruleFromWords(`Send the weekly report to ${JANE}.`, send([JANE]))).toBeNull();
    expect(ruleFromWords(`Please send it to ${JANE} today.`, send([JANE]))).toBeNull();
  });

  test("words that keep the question are not a rule", () => {
    for (const spoken of [
      `Always ask me before you send anything to ${JANE}.`,
      `Never send to ${JANE} without asking.`,
      `Send it to ${JANE}, just this once, without asking.`,
      `From now on send to ${JANE}, but ask first.`,
    ])
      expect(ruleFromWords(spoken, send([JANE]))).toBeNull();
  });

  test("a recipient the person did not name is not covered", () => {
    expect(
      ruleFromWords(`Always send the report to ${JANE}.`, send([JANE, "eve@example.test"])),
    ).toBeNull();
    expect(ruleFromWords("Always send the report.", send([JANE]))).toBeNull();
  });

  test("a name inside a longer address does not count", () => {
    expect(
      ruleFromWords("Always send the report to mary-jane@example.test.", send([JANE])),
    ).toBeNull();
  });

  test("words about another kind of action are not a rule for this one", () => {
    expect(ruleFromWords(`Always delete what ${JANE} asks for.`, send([JANE]))).toBeNull();
  });

  test("an action that never runs without a question gets no rule", () => {
    const remove = describeBoundAction(
      "call_connector",
      { connector_id: "mail", method: "DELETE", path: "/v1/messages/42" },
      [],
    );
    expect(ruleFromWords("Always delete that message without asking.", remove)).toBeNull();
  });

  test("an action without a target gets no rule", () => {
    const action = { ...send([JANE]), target: null };
    expect(ruleFromWords(`Always send the report to ${JANE}.`, action)).toBeNull();
  });

  test("empty words are not a rule", () => {
    expect(ruleFromWords("", send([JANE]))).toBeNull();
  });
});
