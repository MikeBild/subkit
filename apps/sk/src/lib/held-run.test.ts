import { describe, expect, test } from "bun:test";
import { heldRunBlock, heldRunBlockForExecution, heldStepKeys, isHeldRun } from "./held-run.ts";

const client = { base: "https://engine.example.test" };

const outcome = (kind: string, held = 1) =>
  ({
    kind,
    failed_step: null,
    cause_class: null,
    error_code: null,
    refusal_reason: null,
    connector: null,
    steps: { total: 2, succeeded: 1, failed: 0, held, skipped: 0 },
    output_contract: "none",
    rerun_safety: { mode: "prepare_only", reason: "fixture" },
  }) as never;

const steps = [
  { step_key: "load", status: "succeeded" },
  { step_key: "send_mail", status: "succeeded", request_meta: { extras: { held: true } } },
];

describe("heldRunBlock", () => {
  test("names the consequence, the held step and one full approval link", () => {
    const block = heldRunBlock(
      client,
      { outcome: outcome("held"), workflow_id: "wf-1", workflow_name: "Weekly mail" },
      steps,
    );
    expect(block).toBe(
      [
        "Held: nothing was written.",
        "The run only prepared its work. No data was changed anywhere. Writes need an approval for this workflow.",
        "Held steps: send_mail",
        "Approve “Weekly mail” here: https://engine.example.test/cockpit/workflows/wf-1",
      ].join("\n"),
    );
    expect(block).not.toContain("succeeded");
  });

  test("keeps an engine path prefix in the link", () => {
    const block = heldRunBlock(
      { base: "https://host.example.test/engine" },
      { outcome: outcome("held"), workflow_id: "wf-1" },
      steps,
    );
    expect(block).toContain(
      "Approve here: https://host.example.test/engine/cockpit/workflows/wf-1",
    );
  });

  test("a run that wrote normally has no block", () => {
    expect(heldRunBlock(client, { outcome: outcome("succeeded", 0), workflow_id: "wf-1" })).toBe(
      null,
    );
  });

  test("without an outcome the run response decides", () => {
    expect(isHeldRun({ hold_writes: true }, steps)).toBe(true);
    expect(isHeldRun({ hold_writes: true }, [{ step_key: "a" }])).toBe(false);
    expect(isHeldRun({ hold_writes: false }, steps)).toBe(false);
  });

  test("held step keys come from the step rows", () => {
    expect(heldStepKeys([{ step_key: "a", held: true }, ...steps])).toEqual(["a", "send_mail"]);
  });
});

describe("heldRunBlockForExecution", () => {
  test("reads the finished run and returns the block", async () => {
    const block = await heldRunBlockForExecution(
      {
        ...client,
        getExecution: async () => ({ outcome: outcome("held"), workflow_id: "wf-1" }),
        executionSteps: async () => ({ items: steps }),
      },
      "ex-1",
    );
    expect(block).toContain("/cockpit/workflows/wf-1");
  });

  test("a read failure never hides the run result", async () => {
    const block = await heldRunBlockForExecution(
      {
        ...client,
        getExecution: async () => {
          throw new Error("down");
        },
        executionSteps: async () => ({ items: [] }),
      },
      "ex-1",
    );
    expect(block).toBe(null);
  });
});
