import { expect, test } from "bun:test";
import type { ToolPart } from "@/components/ai-elements/tool";
import { chatAutomationSummary, chatAutomationTool } from "./chat-automation-tool";
import { groupMessageParts } from "./chat-transcript";

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
test("held steps do not invent a report failure or imply approval readiness", () => {
  const review = {
    eligible_for_repeated_runs: false,
    unavailable_steps: ["send_email"],
    preview_evidence: { status: "succeeded", steps: [{ step_id: "fetch_report", held: true }] },
  };
  const result = (row: Record<string, unknown>) =>
    part({ ...data, schedules: [{ workflow_id: id, environment: "prod", ...row }] });
  expect(chatAutomationSummary(result({ state: "repair_required", review }))).toBe("repair");
  expect(
    chatAutomationSummary(
      result({
        review: { ...review, preview_evidence: { steps: [{ step_id: "send_email", held: true }] } },
      }),
    ),
  ).toBe("repair");
  expect(
    chatAutomationSummary(
      result({ state: "approval_required", review: { eligible_for_repeated_runs: true } }),
    ),
  ).toBe("review");
  expect(chatAutomationSummary(result({ state: "authorized", ready: true }))).toBe("authorized");
  expect(chatAutomationSummary(result({ state: "authorized", ready: false }))).toBe("unknown");
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
