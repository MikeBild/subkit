import { expect, test } from "bun:test";
import type { ToolPart } from "@/components/ai-elements/tool";
import { chatSensitiveTestRun } from "./chat-test-run";

const summary = {
  status: "succeeded",
  duration_ms: 42,
  content_withheld: true,
  steps: [
    {
      id: "read",
      kind: "request",
      status: "succeeded",
      duration_ms: 30,
      held: false,
      pagination: { strategy: "link", pages: 3, items: 120, complete: false, truncated: true },
    },
    { id: "shape", kind: "transform", status: "succeeded", duration_ms: 2, held: false },
    { id: "send", kind: "request", status: "succeeded", duration_ms: 0, held: true },
  ],
  counts: { total: 3, succeeded: 2, failed: 0, held: 1 },
  validation: "passed",
  output_schema: "passed",
  output: { names: { type: "array", length: 120 } },
  note: "Content is withheld because this workflow is sensitive.",
};

const part = (output: unknown, toolName = "dry_run_workflow", state = "output-available") =>
  ({ type: "dynamic-tool", toolName, toolCallId: "run", state, input: {}, output }) as ToolPart;

test("a sensitive test run reads status, step counts, reads and checks", () => {
  for (const output of [
    { ok: true, data: { sensitive_test_run: summary } },
    { sensitive_test_run: summary },
  ])
    expect(chatSensitiveTestRun(part(output))).toEqual({
      succeeded: true,
      steps: { succeeded: 2, failed: 0, held: 1 },
      reads: [{ step: "read", items: 120, complete: false }],
      checks: "passed",
    });
});

test("a failed run or failed check is reported as failed", () => {
  const failed = {
    ...summary,
    status: "failed",
    validation: "failed",
    counts: { total: 3, succeeded: 1, failed: 1, held: 1 },
  };
  expect(chatSensitiveTestRun(part({ ok: false, data: { sensitive_test_run: failed } }))).toEqual({
    succeeded: false,
    steps: { succeeded: 1, failed: 1, held: 1 },
    reads: [{ step: "read", items: 120, complete: false }],
    checks: "failed",
  });
  expect(
    chatSensitiveTestRun(
      part({ data: { sensitive_test_run: { ...summary, output_schema: "failed" } } }),
    )?.checks,
  ).toBe("failed");
});

test("undefined checks are not claimed as passed", () => {
  expect(
    chatSensitiveTestRun(
      part({
        data: {
          sensitive_test_run: { ...summary, validation: "not_defined", output_schema: "not_run" },
        },
      }),
    )?.checks,
  ).toBe("none");
});

test("other tools, ordinary previews and pending calls are not sensitive test runs", () => {
  expect(
    chatSensitiveTestRun(part({ data: { sensitive_test_run: summary } }, "run_workflow")),
  ).toBe(null);
  expect(chatSensitiveTestRun(part({ data: { step_trace: [] } }))).toBe(null);
  expect(
    chatSensitiveTestRun(
      part({ data: { sensitive_test_run: summary } }, undefined, "input-available"),
    ),
  ).toBe(null);
  expect(
    chatSensitiveTestRun(part({ data: { sensitive_test_run: { status: "succeeded" } } })),
  ).toBe(null);
});
