import { describe, expect, test } from "bun:test";
import { confirmationSummary } from "@/features/usage/model/operations-figures";

describe("confirmation figures", () => {
  const envelope = {
    confirmations: {
      asked: 7,
      covered: 3,
      per_turn: { turns: 20, turns_with_ask: 5, asked_per_turn: 0.35 },
      per_task_run: { runs: 4, asked: 3, median_per_run: 0.5 },
      tools: [
        { tool: "send_email", asked: 5, covered: { rule: 2, instruction: 0, authority: 0 } },
        { tool: "run_workflow", asked: 2, covered: { rule: 0, instruction: 0, authority: 1 } },
        { tool: "", asked: 1 },
      ],
    },
  };

  test("reads the rates per turn and per task run and the asks per tool", () => {
    expect(confirmationSummary(envelope)).toEqual({
      asked: 7,
      covered: 3,
      turns: 20,
      perTurn: 0.35,
      runs: 4,
      medianPerRun: 0.5,
      tools: [
        { tool: "send_email", asked: 5, covered: 2 },
        { tool: "run_workflow", asked: 2, covered: 1 },
      ],
    });
  });

  test("an answer without the block is unreadable, and missing rates stay null", () => {
    expect(confirmationSummary({ runs: {} })).toBeNull();
    expect(confirmationSummary({ confirmations: { per_turn: {} } })).toBeNull();
    expect(
      confirmationSummary({
        confirmations: {
          asked: 0,
          covered: 0,
          per_turn: { turns: 0, asked_per_turn: null },
          per_task_run: { runs: 0, median_per_run: null },
          tools: [],
        },
      }),
    ).toEqual({
      asked: 0,
      covered: 0,
      turns: 0,
      perTurn: null,
      runs: 0,
      medianPerRun: null,
      tools: [],
    });
  });
});
