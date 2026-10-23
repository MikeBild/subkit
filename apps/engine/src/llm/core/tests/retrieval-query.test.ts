import { describe, expect, test } from "bun:test";
import { buildPriorWorkflowRankingQuery } from "../context-assembler/loaders.ts";
import { buildQuery } from "../context-assembler.ts";

const goal = "Send overdue invoice reminders every Monday";
const generationPrompt = [
  "Generate ONE complete sk workflow definition that satisfies the goal below.",
  "x".repeat(600),
  goal,
].join("\n");

describe("llm/context — retrieval query", () => {
  test("an explicit retrieval query replaces the turn text", () => {
    expect(buildQuery([{ role: "user", content: generationPrompt }], goal)).toBe(goal);
  });

  test("without a retrieval query the turn tail is used", () => {
    const query = buildQuery([{ role: "user", content: generationPrompt }]);
    expect(query.length).toBe(512);
    expect(query).not.toContain("invoice");
  });

  test("a blank retrieval query falls back to the turns", () => {
    expect(buildQuery([{ role: "user", content: "list users" }], "   ")).toBe("list users");
  });

  test("prior-workflow ranking uses the retrieval query", () => {
    expect(
      buildPriorWorkflowRankingQuery(
        undefined,
        [{ role: "user", content: generationPrompt }],
        goal,
      ),
    ).toBe(goal);
  });
});
