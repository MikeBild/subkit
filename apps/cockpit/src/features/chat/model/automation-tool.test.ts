import { expect, test } from "bun:test";
import type { ToolPart } from "@/components/ai-elements/tool";
import { chatAutomationTool, liveAutomationReviews } from "./automation-tool";
import { groupMessageParts } from "./transcript";

const id = "00000000-0000-4000-8000-000000000001";
const data = {
  kind: "workflow_automation_review",
  workflow_id: id,
  schedules: [{ workflow_id: id, environment: "prod" }],
};
const part = (output: unknown) =>
  ({
    type: "dynamic-tool",
    toolName: "review_workflow_automation",
    toolCallId: "review",
    state: "output-available",
    input: { workflow_id: id },
    output,
  }) as ToolPart;
test("a webhook-only workflow is a card", () => {
  const hook = {
    workflow_id: id,
    slug: "findings",
    environment: "prod",
    state: "approval_required",
    ready: false,
    review: { eligible_for_repeated_runs: false },
  };
  const output = (row: Record<string, unknown>) =>
    part({ ok: true, data: { ...data, schedules: [], inbound_hooks: [row] } });
  expect(chatAutomationTool(output(hook))).toEqual({ workflowId: id, environments: ["prod"] });
});
test("server review stays actionable in the transcript and uses the bound workflow", () => {
  for (const output of [data, { ok: true, data }]) {
    expect(chatAutomationTool(part(output))).toEqual({ workflowId: id, environments: ["prod"] });
    expect(groupMessageParts([part(output)])[0]?.kind).toBe("tool");
  }
});
test("failed and mismatched review results cannot create permission buttons", () => {
  expect(chatAutomationTool(part({ ok: false, data }))).toBeNull();
  expect(chatAutomationTool(part({ ...data, workflow_id: "bad" }))).toBeNull();
  expect(
    chatAutomationTool(
      part({ ...data, schedules: [{ workflow_id: "other", environment: "prod" }] }),
    )?.environments,
  ).toEqual([]);
});
test("a saved change without schedule or webhook is a card in the run's environment", () => {
  const review = {
    ok: true,
    data: {
      ...data,
      schedules: [],
      inbound_hooks: [],
      saved_change: { environment: "dev", review: { eligible_for_repeated_runs: true } },
    },
  };
  expect(chatAutomationTool(part(review))).toEqual({ workflowId: id, environments: ["dev"] });
  expect(
    chatAutomationTool(part({ ok: true, data: { ...data, schedules: [], saved_change: null } }))
      ?.environments,
  ).toEqual([]);
});
test("the run refusal that promises the review dialog carries it", () => {
  const automation_review = {
    ...data,
    schedules: [],
    saved_change: { environment: "dev", review: { eligible_for_repeated_runs: false } },
  };
  const refusal = (output: unknown) =>
    ({
      type: "dynamic-tool",
      toolName: "run_workflow",
      toolCallId: "run",
      state: "output-available",
      input: { workflow: id },
      output,
    }) as ToolPart;
  const refused = refusal({
    ok: false,
    data: { error_code: "workflow_activation_required", automation_review },
  });
  expect(chatAutomationTool(refused)).toEqual({ workflowId: id, environments: ["dev"] });
  expect(
    chatAutomationTool(
      refusal({ ok: false, data: { error_code: "workflow_not_found", automation_review } }),
    ),
  ).toBeNull();
  expect(chatAutomationTool(refusal({ ok: true, data: { automation_review } }))).toBeNull();
});

test("only the newest review of a workflow is a live card", () => {
  const other = "00000000-0000-4000-8000-000000000002";
  const call = (toolCallId: string, workflowId: string) => ({
    ...part({
      ...data,
      workflow_id: workflowId,
      schedules: [{ workflow_id: workflowId, environment: "prod" }],
    }),
    toolCallId,
  });
  const live = liveAutomationReviews([
    call("first", id),
    call("other", other),
    part({ ok: false, error: { code: "not_found" } }),
    call("second", id),
  ]);
  expect([...live]).toEqual([
    [id, "second"],
    [other, "other"],
  ]);
});
