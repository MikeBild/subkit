// Ink-component coverage for ApprovalRouter — the elicitation
// dispatcher that routes on `ask_user_confirm { kind }`.

import { describe, expect, test } from "bun:test";
import type { PendingElicitation } from "@cli-core/index.ts";
import { ApprovalRouter } from "../repl/approval/router.tsx";
import { renderInk } from "./helpers/ink.tsx";

function el(overrides: Partial<PendingElicitation>): PendingElicitation {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    tool_name: "ask_user_confirm",
    summary: "Summary line",
    input: {},
    ...overrides,
  };
}

describe("ApprovalRouter (component)", () => {
  test("save_workflow_draft kind routes to CommitDraftApproval", async () => {
    const ui = renderInk(
      <ApprovalRouter
        approval={el({
          summary: "Commit 1-step workflow?",
          input: { kind: "save_workflow_draft", diff: { slug: "demo", steps: 1 } },
        })}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("confirm: save_workflow_draft"));
      const txt = ui.text();
      expect(txt).toContain("input needed: confirm: save_workflow_draft");
      expect(txt).toContain("Commit 1-step workflow?");
    } finally {
      ui.unmount();
    }
  });

  test("external_write kind routes to ExternalWriteApproval", async () => {
    const ui = renderInk(
      <ApprovalRouter
        approval={el({
          summary: "Write to GitHub?",
          input: { kind: "external_write", target: "https://api.github.com/repos/x/y/issues" },
        })}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("external_write"));
      const txt = ui.text();
      expect(txt).toContain("confirm: external_write");
      expect(txt).toContain("https://api.github.com/repos/x/y/issues");
    } finally {
      ui.unmount();
    }
  });

  test("external_write renders structured tool targets", async () => {
    const ui = renderInk(
      <ApprovalRouter
        approval={el({
          summary: "Run the workflow in prod?",
          input: {
            kind: "external_write",
            target: { tool: "run_workflow", args: { environment: "prod" } },
          },
        })}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("run_workflow"));
      const txt = ui.text();
      expect(txt).toContain("confirm: external_write");
      expect(txt).toContain("target:");
      expect(txt).toContain("run_workflow");
      expect(txt).toContain("args:");
      expect(txt).toContain("environment");
      expect(txt).toContain("prod");
    } finally {
      ui.unmount();
    }
  });

  test("falls back to the canonical payload summary when approval.summary is blank", async () => {
    const ui = renderInk(
      <ApprovalRouter
        approval={el({
          summary: "",
          input: {
            kind: "save_workflow_draft",
            question: "Save the workflow?",
            commit_intent: {
              kind: "save_workflow_draft",
              description: "Save the DigitalOcean projects workflow",
              payload: {},
            },
          },
        })}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("DigitalOcean projects workflow"));
      const txt = ui.text();
      expect(txt).toContain("input needed: confirm: save_workflow_draft");
      expect(txt).toContain("Save the DigitalOcean projects workflow");
    } finally {
      ui.unmount();
    }
  });

  test("unknown kind falls back to GenericApproval with target+diff", async () => {
    const ui = renderInk(
      <ApprovalRouter
        approval={el({
          summary: "approve a custom op",
          input: { kind: "mystery", diff: { foo: 1 }, target: "something" },
        })}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("confirm: mystery"));
      const txt = ui.text();
      expect(txt).toContain("target:");
      expect(txt).toContain("diff:");
    } finally {
      ui.unmount();
    }
  });

  test("header shows the raw tool_name for non-confirm tools", async () => {
    const ui = renderInk(
      <ApprovalRouter
        approval={el({
          tool_name: "ask_user_choice",
          summary: "Pick one",
          input: {},
        })}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("ask_user_choice"));
      expect(ui.text()).toContain("input needed: ask_user_choice");
    } finally {
      ui.unmount();
    }
  });

  test("footer exposes a short id and the /respond hint", async () => {
    const ui = renderInk(
      <ApprovalRouter
        approval={el({
          summary: "s",
          input: { kind: "generic" },
        })}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("/respond"));
      expect(ui.text()).toContain("id: 11111111");
    } finally {
      ui.unmount();
    }
  });
});
