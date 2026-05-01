import { describe, expect, test } from "bun:test";
import type { ToolCallState } from "@cli-core/index.ts";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { renderAuthoringCard } from "./authoring-cards.tsx";

function snapshot(ui: ReturnType<typeof render>): string {
  return (ui.lastFrame() ?? "").replace(/\[[0-9;]*m/g, "");
}

function renderCard(call: ToolCallState): ReturnType<typeof render> {
  return render(renderAuthoringCard(call, "inspect") as ReactElement);
}

function makeApprovalCall(args: Record<string, unknown>): ToolCallState {
  return {
    id: "tc-approval",
    name: "ask_user_confirm",
    args,
    status: "done",
    result: { ok: true, data: { confirmed: true } },
  };
}

describe("ApprovalCard", () => {
  test("surfaces commit_intent.description when summary is absent", () => {
    const ui = renderCard(
      makeApprovalCall({
        kind: "commit_draft",
        question: "Save the workflow?",
        commit_intent: {
          kind: "commit_workflow_draft",
          description: "Save the DigitalOcean projects workflow",
          payload: {},
        },
      }),
    );
    const frame = snapshot(ui);
    expect(frame).toContain("approved: commit_draft");
    expect(frame).toContain("Save the DigitalOcean projects workflow");
    ui.unmount();
  });

  test("falls back to target summaries for external writes", () => {
    const ui = renderCard(
      makeApprovalCall({
        kind: "external_write",
        target: {
          tool: "run_workflow",
          args: { environment: "prod" },
        },
      }),
    );
    const frame = snapshot(ui);
    expect(frame).toContain("approved: external_write");
    expect(frame).toContain("run_workflow env=prod");
    ui.unmount();
  });
});
