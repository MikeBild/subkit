import { describe, expect, test } from "bun:test";

import {
  describeApprovalTarget,
  describeConfirmationPayload,
} from "../repl/approval/describe-confirmation.ts";

describe("describeApprovalTarget", () => {
  test("uses tool + workflow id when present", () => {
    expect(
      describeApprovalTarget({
        tool: "save_workflow_draft",
        args: { target_workflow_id: "wf_123" },
      }),
    ).toBe("save_workflow_draft wf_123");
  });

  test("falls back to tool + environment when there is no resource id", () => {
    expect(
      describeApprovalTarget({
        tool: "run_workflow",
        args: { environment: "prod" },
      }),
    ).toBe("run_workflow env=prod");
  });

  test("uses workflow slug and environment without including large workflow inputs", () => {
    expect(
      describeApprovalTarget({
        tool: "run_workflow",
        args: {
          workflow: "render-upload-slides",
          environment: "dev",
          markdown: `# Slides\n\n${"body\n".repeat(500)}`,
        },
      }),
    ).toBe("run_workflow render-upload-slides env=dev");
  });

  test("summarizes HTTP-style targets", () => {
    expect(
      describeApprovalTarget({
        method: "POST",
        url: "https://api.github.com/repos/x/y/issues",
      }),
    ).toBe("POST https://api.github.com/repos/x/y/issues");
  });
});

describe("describeConfirmationPayload", () => {
  test("prefers commit_intent.description", () => {
    expect(
      describeConfirmationPayload({
        question: "save?",
        commit_intent: { description: "Save the DigitalOcean projects workflow" },
      }),
    ).toBe("Save the DigitalOcean projects workflow");
  });

  test("falls back to target description when no commit_intent description exists", () => {
    expect(
      describeConfirmationPayload({
        target: { tool: "run_workflow", args: { environment: "prod" } },
      }),
    ).toBe("run_workflow env=prod");
  });

  test("falls back to summary/question", () => {
    expect(describeConfirmationPayload({ summary: "Run health check?" })).toBe("Run health check?");
    expect(describeConfirmationPayload({ question: "Proceed?" })).toBe("Proceed?");
  });
});
