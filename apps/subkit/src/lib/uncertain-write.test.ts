import { describe, expect, test } from "bun:test";
import {
  ResolveWriteBodySchema,
  statusText,
  uncertainStepKeys,
  uncertainWriteBlock,
  uncertainWriteBlockForExecution,
} from "./uncertain-write.ts";

describe("uncertainStepKeys", () => {
  test("the run's own notice names the step", () => {
    expect(uncertainStepKeys({ error: { step_id: "send_mail" } })).toEqual(["send_mail"]);
    expect(uncertainStepKeys({ error: { step_keys: ["a", "b[2]"] } })).toEqual(["a", "b[2]"]);
  });

  test("without a notice the steps still in flight are the candidates", () => {
    expect(
      uncertainStepKeys({ error: null }, [
        { step_key: "load", status: "succeeded" },
        { step_key: "send_mail", status: "running" },
        { step_key: "post", status: "uncertain" },
      ]),
    ).toEqual(["send_mail", "post"]);
  });
});

describe("uncertainWriteBlock", () => {
  test("names the step and both exact commands", () => {
    expect(
      uncertainWriteBlock("ex-1", { status: "uncertain", error: { step_id: "send_mail" } }),
    ).toBe(
      [
        "Outcome unknown: the run stopped while a change was being sent.",
        "The change may or may not have reached its target. Nothing is sent again until you say which it was.",
        "Uncertain step: send_mail",
        "If it arrived:        subkit executions resolve-write ex-1 --step send_mail --outcome arrived",
        "If it did not arrive: subkit executions resolve-write ex-1 --step send_mail --outcome not_arrived",
      ].join("\n"),
    );
  });

  test("without a known step it says how to find it", () => {
    const block = uncertainWriteBlock("ex-1", { status: "uncertain" });
    expect(block).toContain("subkit executions steps ex-1");
    expect(block).toContain("--step <step_key> --outcome arrived|not_arrived");
  });

  test("any other status has no block", () => {
    expect(uncertainWriteBlock("ex-1", { status: "running", error: { step_id: "a" } })).toBeNull();
    expect(uncertainWriteBlock("ex-1", { status: "failed" })).toBeNull();
  });
});

describe("uncertainWriteBlockForExecution", () => {
  test("the stream frame's step wins over the stored notice", async () => {
    const block = await uncertainWriteBlockForExecution(
      {
        getExecution: async () => ({ status: "uncertain", error: { step_id: "old" } }) as never,
        executionSteps: async () => ({ items: [] }) as never,
      },
      "ex-1",
      { step_keys: ["send_mail"] },
    );
    expect(block).toContain("--step send_mail --outcome arrived");
    expect(block).not.toContain("old");
  });

  test("a read failure still prints the command", async () => {
    const block = await uncertainWriteBlockForExecution(
      {
        getExecution: async () => {
          throw new Error("down");
        },
        executionSteps: async () => ({ items: [] }) as never,
      },
      "ex-1",
    );
    expect(block).toContain("subkit executions resolve-write ex-1");
  });
});

describe("resolve-write contract", () => {
  test("the body carries exactly the step and one of two outcomes", () => {
    expect(ResolveWriteBodySchema.safeParse({ step_key: "a", outcome: "arrived" }).success).toBe(
      true,
    );
    expect(ResolveWriteBodySchema.safeParse({ step_key: "a", outcome: "maybe" }).success).toBe(
      false,
    );
    expect(ResolveWriteBodySchema.safeParse({ step_key: "", outcome: "arrived" }).success).toBe(
      false,
    );
    expect(
      ResolveWriteBodySchema.safeParse({ step_key: "a", outcome: "arrived", extra: 1 }).success,
    ).toBe(false);
  });

  test("the plain label sits beside the machine status", () => {
    expect(statusText("uncertain")).toBe("uncertain (Outcome unknown)");
    expect(statusText("running")).toBe("running");
  });
});
