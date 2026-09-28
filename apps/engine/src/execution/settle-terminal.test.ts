import { describe, expect, test } from "bun:test";
import { settleTerminalOutcome } from "./settle-terminal.ts";

const base = {
  status: "succeeded" as const,
  timed_out: false,
  aborted: false,
  output_contract: "passed" as const,
  failure: null,
};

describe("settleTerminalOutcome", () => {
  test("a run the total timeout stopped after its contract passed does not record passed", () => {
    const settled = settleTerminalOutcome({ ...base, timed_out: true });
    expect(settled.status).toBe("timed_out");
    expect(settled.output_contract).toBe("none");
    expect(settled.failure?.code).toBe("execution_timeout");
  });

  test("an aborted run does not record passed either, and names why it stopped", () => {
    const settled = settleTerminalOutcome({ ...base, aborted: true });
    expect(settled.status).toBe("aborted");
    expect(settled.output_contract).toBe("none");
    expect(settled.failure?.code).toBe("execution_aborted");
  });

  test("a run that succeeded keeps its verdict and records no failure", () => {
    expect(settleTerminalOutcome(base)).toEqual({
      status: "succeeded",
      output_contract: "passed",
      failure: null,
    });
  });

  test("a failed run keeps its own failure and no verdict", () => {
    const failure = { code: "validation_failed", message: "returned false" };
    const settled = settleTerminalOutcome({ ...base, status: "failed", failure });
    expect(settled).toEqual({ status: "failed", output_contract: "none", failure });
  });
});
