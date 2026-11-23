import { describe, expect, test } from "bun:test";
import { knowledgePreloadPlan, withinTokenBudget } from "./grounding.ts";

describe("knowledgePreloadPlan", () => {
  test("a chat question of three words pre-loads three hits within three percent", () => {
    expect(
      knowledgePreloadPlan({
        flow: "converse",
        latest_user_text: "  how do   refunds work? ",
        cap_tokens: 100_000,
      }),
    ).toEqual({ query: "how do refunds work?", limit: 3, token_budget: 3000 });
  });

  test("a short message is not worth a search", () => {
    expect(
      knowledgePreloadPlan({ flow: "converse", latest_user_text: "thanks !", cap_tokens: 100_000 }),
    ).toBeNull();
    expect(
      knowledgePreloadPlan({ flow: "converse", latest_user_text: "yes - ok", cap_tokens: 100_000 }),
    ).toBeNull();
    expect(
      knowledgePreloadPlan({ flow: "converse", latest_user_text: null, cap_tokens: 100_000 }),
    ).toBeNull();
  });

  test("other flows keep their own corpus loading", () => {
    expect(
      knowledgePreloadPlan({
        flow: "generate",
        latest_user_text: "build me a weekly report",
        cap_tokens: 100_000,
      }),
    ).toBeNull();
  });

  test("a cap too small for any budget pre-loads nothing", () => {
    expect(
      knowledgePreloadPlan({ flow: "converse", latest_user_text: "one two three", cap_tokens: 20 }),
    ).toBeNull();
  });

  test("a very long message is cut to the search length", () => {
    const plan = knowledgePreloadPlan({
      flow: "converse",
      latest_user_text: "word ".repeat(400),
      cap_tokens: 100_000,
    });
    expect(plan?.query.length).toBe(512);
  });
});

describe("withinTokenBudget", () => {
  test("keeps leading items until the budget is used up", () => {
    const items = [{ tokens: 40 }, { tokens: 50 }, { tokens: 20 }];
    expect(withinTokenBudget(items, 100)).toEqual([{ tokens: 40 }, { tokens: 50 }]);
    expect(withinTokenBudget(items, 30)).toEqual([]);
    expect(withinTokenBudget(items, 110)).toEqual(items);
  });
});
