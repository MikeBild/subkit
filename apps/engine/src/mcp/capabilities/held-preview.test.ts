// Unit tests for buildResultEnvelope — the pure MCP result-envelope
// shaper. Pins the honest-preview contract without a live MCP handler.

import { describe, expect, test } from "bun:test";
import type { RunResult } from "../../execution/types.ts";
import { buildResultEnvelope } from "./held-preview.ts";

function base(
  overrides: Partial<RunResult>,
): Pick<RunResult, "warnings" | "output" | "execution_id" | "status"> {
  return {
    execution_id: "exec-1",
    status: "succeeded",
    output: { hello: "world" },
    ...overrides,
  };
}

describe("buildResultEnvelope", () => {
  test("clean run → bare output, no preview, no _meta", () => {
    const env = buildResultEnvelope(base({}));
    expect(env.isHeldPreview).toBe(false);
    expect(env.rawBody).toEqual({ hello: "world" });
    expect(env.previewMeta).toEqual({});
  });

  test("non-held warnings → output+warnings wrapper, still no preview", () => {
    const warnings = [{ code: "unresolved_identifier" as const, message: "x", step_key: "s" }];
    const env = buildResultEnvelope(base({ warnings }));
    expect(env.isHeldPreview).toBe(false);
    expect(env.rawBody).toEqual({ output: { hello: "world" }, warnings });
    expect(env.previewMeta).toEqual({});
  });

  test("held_preview_no_writes → preview envelope + _meta.subkit.execution.preview", () => {
    const warnings = [
      {
        code: "held_preview_no_writes" as const,
        message: "Preview run (hold_writes): 1 write step(s) held — NOTHING was written.",
        step_key: "$holds",
        details: {
          held_steps: ["send"],
          skipped_steps: ["confirm"],
          would_write: [{ step: "send", method: "POST", url: "https://api/send" }],
        },
      },
    ];
    const env = buildResultEnvelope(base({ warnings }));
    expect(env.isHeldPreview).toBe(true);
    expect(env.heldMessage).toContain("NOTHING was written");
    const body = env.rawBody as Record<string, unknown>;
    // MCP names its OWN remedy — confirm_tool_call, never execute_writes
    // (which this surface does not publish).
    expect(String(body.remedy)).not.toContain("execute_writes");
    expect(body.preview).toBe(true);
    expect(body.writes_held).toBe(true);
    expect(body.held_steps).toEqual(["send"]);
    expect(body.would_write).toEqual([{ step: "send", method: "POST", url: "https://api/send" }]);
    expect(body.output).toEqual({ hello: "world" });
    const meta = env.previewMeta as {
      _meta?: { subkit?: { execution?: { preview?: boolean; held_steps?: unknown } } };
    };
    expect(meta._meta?.subkit?.execution?.preview).toBe(true);
    expect(meta._meta?.subkit?.execution?.held_steps).toEqual(["send"]);
  });

  test("confirm_required → prose names the approval_url and never tells the model to approve", () => {
    const env = buildResultEnvelope(base({ warnings: heldWarnings() }), {
      kind: "confirm_required",
      tool: "wf_send-invoice",
      confirm_id: "11111111-1111-1111-1111-111111111111",
      approval_url: "https://engine.example.test/v1/tool-approvals/decide?grant=skag_abc",
      reason: "portal_grant_required",
    });
    const body = env.rawBody as Record<string, unknown>;
    expect(body.awaiting_human_approval).toBe(true);
    expect(body.approval_url).toBe(
      "https://engine.example.test/v1/tool-approvals/decide?grant=skag_abc",
    );
    const remedy = String(body.remedy);
    expect(remedy).toContain("Nothing was written. 1 write step is held.");
    expect(remedy).toContain("A person must approve before they run.");
    expect(remedy).toContain(
      "Send this link to the person who must approve: https://engine.example.test/v1/tool-approvals/decide?grant=skag_abc",
    );
    expect(remedy).toContain(
      'call confirm_tool_call({ tool: "wf_send-invoice", confirm_id: "11111111-1111-1111-1111-111111111111" })',
    );
    // The model is told the trigger performs writes — never that it approves them.
    expect(remedy).toContain("it cannot approve them");
    // Portal-only: no in-band prompt exists, so nothing is ever described as
    // unanswered or declined.
    expect(remedy).not.toContain("did not answer");
    expect(remedy).not.toContain("declined");
  });

  test("confirm_required without a public origin → says no link exists, hands out none", () => {
    const env = buildResultEnvelope(base({ warnings: heldWarnings() }), {
      kind: "confirm_required",
      tool: "wf_send-invoice",
      confirm_id: "33333333-3333-3333-3333-333333333333",
      approval_url: null,
      reason: "portal_grant_required",
    });
    const body = env.rawBody as Record<string, unknown>;
    expect(body.approval_url).toBeNull();
    const remedy = String(body.remedy);
    expect(remedy).toContain("no approval portal configured");
    expect(remedy).not.toContain("Send this link");
    expect(remedy).toContain("confirm_tool_call cannot grant it");
  });
});

function heldWarnings(): NonNullable<RunResult["warnings"]> {
  return [
    {
      code: "held_preview_no_writes" as const,
      message: "Preview run (hold_writes): 1 write step(s) held — NOTHING was written.",
      step_key: "$holds",
      details: {
        held_steps: ["send"],
        would_write: [{ step: "send", method: "POST", url: "https://api/send" }],
      },
    },
  ];
}
