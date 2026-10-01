import { describe, expect, test } from "bun:test";
import { executionOutcomeLine } from "./execution-outcome.ts";

const steps = { total: 3, succeeded: 1, failed: 1, held: 0, skipped: 1 };

describe("executionOutcomeLine", () => {
  test("a failed run names the step that stopped it and its cause", () => {
    expect(
      executionOutcomeLine({
        kind: "failed",
        failed_step: { step_key: "fetch", kind: "request" },
        cause_class: "auth_failed",
        error_code: "http_4xx",
        refusal_reason: null,
        connector: null,
        steps,
        output_contract: "none",
      }),
    ).toBe(
      "failed at step fetch (request) · auth_failed, http_4xx · steps 1/3 ok, 1 failed, 1 skipped",
    );
  });

  test("a held preview is not reported as a success", () => {
    const line = executionOutcomeLine({
      kind: "held",
      failed_step: null,
      cause_class: null,
      error_code: null,
      refusal_reason: null,
      connector: null,
      steps: { total: 2, succeeded: 1, failed: 0, held: 1, skipped: 0 },
      output_contract: "none",
    });
    expect(line).toStartWith("held — writes held, nothing written");
    expect(line).not.toContain("succeeded");
  });

  test("no outcome (older engine) prints nothing", () => {
    expect(executionOutcomeLine(undefined)).toBeNull();
  });
});
