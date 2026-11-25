import { describe, expect, test } from "bun:test";
import { median, summarizeConfirmations } from "./aggregate-confirmations.ts";

describe("summarizeConfirmations", () => {
  test("median takes the middle count, or the mean of the two middle counts", () => {
    expect(median([])).toBeNull();
    expect(median([3, 0, 1])).toBe(1);
    expect(median([0, 4, 1, 2])).toBe(1.5);
  });

  test("totals, rates per turn and per task run, and per-tool rows", () => {
    const figures = summarizeConfirmations({
      asks: [
        {
          tool: "send_email",
          kind: "policy_gate",
          outcome: "granted",
          in_task_run: true,
          asked: 3,
        },
        {
          tool: "send_email",
          kind: "policy_gate",
          outcome: "declined",
          in_task_run: false,
          asked: 1,
        },
        {
          tool: "ask_user_confirm",
          kind: "ask_user",
          outcome: "expired",
          in_task_run: false,
          asked: 1,
        },
      ],
      covers: [
        { tool: "send_email", reason: "standing_rule", covered: 2 },
        { tool: "run_workflow", reason: "authority_covered", covered: 1 },
        { tool: "run_workflow", reason: "something_else", covered: 9 },
      ],
      turns: 10,
      turns_with_ask: 3,
      asks_per_run: [3, 0, 0],
    });
    expect(figures).toMatchObject({
      asked: 5,
      covered: 3,
      kinds: { policy_gate: 4, ask_user: 1 },
      outcomes: { granted: 3, declined: 1, expired: 1, superseded: 0, cancelled: 0, open: 0 },
      covered_by: { rule: 2, instruction: 0, authority: 1 },
      per_turn: { turns: 10, turns_with_ask: 3, asked_per_turn: 0.5 },
      per_task_run: { runs: 3, runs_with_ask: 1, asked: 3, asked_per_run: 1, median_per_run: 0 },
    });
    expect(figures.tools.map((row) => [row.tool, row.asked, row.asked_in_task_runs])).toEqual([
      ["send_email", 4, 3],
      ["ask_user_confirm", 1, 0],
      ["run_workflow", 0, 0],
    ]);
    expect(figures.tools[0]?.covered).toEqual({ rule: 2, instruction: 0, authority: 0 });
  });

  test("nothing to count gives null rates, never zero", () => {
    const figures = summarizeConfirmations({
      asks: [],
      covers: [],
      turns: 0,
      turns_with_ask: 0,
      asks_per_run: [],
    });
    expect(figures.per_turn.asked_per_turn).toBeNull();
    expect(figures.per_task_run).toEqual({
      runs: 0,
      runs_with_ask: 0,
      asked: 0,
      asked_per_run: null,
      median_per_run: null,
    });
    expect(figures.tools).toEqual([]);
  });
});
