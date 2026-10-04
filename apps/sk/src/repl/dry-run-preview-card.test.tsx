import { describe, expect, test } from "bun:test";
import type { ToolCallState } from "@cli-core/index.ts";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { renderAuthoringCard } from "./authoring-cards.tsx";

function snapshot(s: ReturnType<typeof render>): string {
  return (s.lastFrame() ?? "").replace(/\[[0-9;]*m/g, "");
}

function renderCard(call: ToolCallState): ReturnType<typeof render> {
  return render(renderAuthoringCard(call, "chat") as ReactElement);
}

function makeCall(name: string, output: unknown): ToolCallState {
  return {
    id: `tc-${name}`,
    name,
    args: {},
    status: "done",
    result: { ok: true, data: output },
  };
}

describe("dry_run_workflow card · output rendering (bug C / 86de186b)", () => {
  test("surfaces last_step.output_preview when present", () => {
    const call = makeCall("dry_run_workflow", {
      ok: true,
      summary: "Ran 4 steps with no errors.",
      last_step: {
        step_id: "format_output",
        kind: "transform",
        output_preview: [
          { project_id: "p1", project_name: "alpha" },
          { project_id: "p2", project_name: "beta" },
        ],
      },
    });
    const r = renderCard(call);
    const frame = snapshot(r);
    expect(frame).toContain("Preview complete");
    expect(frame).toMatch(/alpha|project_name|p1/);
    r.unmount();
  });

  test("surfaces step_outputs[].output_preview for dry_run_workflow", () => {
    const call = makeCall("dry_run_workflow", {
      ok: true,
      summary: "Ran 5 steps with no errors.",
      step_outputs: [
        { step_id: "fetch_projects", kind: "request", output_preview: { projects: [] } },
        {
          step_id: "format_output",
          kind: "transform",
          output_preview: [{ project_id: "p1", project_name: "alpha", resources: ["r1", "r2"] }],
        },
      ],
    });
    const r = renderCard(call);
    const frame = snapshot(r);
    expect(frame).toContain("Preview complete");
    expect(frame).toMatch(/alpha|resources/);
    r.unmount();
  });

  test("falls back to summary-only when no preview data is present", () => {
    const call = makeCall("dry_run_workflow", {
      ok: true,
      summary: "Ran 1 step with no errors.",
    });
    const r = renderCard(call);
    const frame = snapshot(r);
    expect(frame).toContain("Preview complete");
    expect(frame).toContain("Ran 1 step with no errors");
    r.unmount();
  });

  test("a partial_success run renders the real warning, not the loop-body boilerplate", () => {
    const call: ToolCallState = {
      id: "tc-run-partial",
      name: "run_workflow",
      args: {},
      status: "done",
      result: {
        ok: false,
        data: {
          status: "partial_success",
          diagnosis_available: true,
          warnings: [
            {
              code: "transform_empty_extraction",
              message:
                'transform "filter_connected" produced an empty result while upstream scope had data — either the JSONata path is wrong, or a filter/predicate matched no rows.',
            },
          ],
        },
      },
    };
    const r = renderCard(call);
    const frame = snapshot(r);
    expect(frame).not.toContain("Loop body produced no rows");
    expect(frame).toContain("filter_connected");
    expect(frame).toMatch(/filter\/predicate matched no rows|JSONata path is wrong/);
    r.unmount();
  });

  test("a needs_repair preview renders 'Preview needs repair', never a clean 'ok'", () => {
    const call: ToolCallState = {
      id: "tc-needs-repair",
      name: "dry_run_workflow",
      args: {},
      status: "done",
      result: {
        ok: false,
        data: {
          ok: false,
          classification: "needs_repair",
          summary:
            "Ran 2 steps, but the preview needs repair — 1 blocking warning. Fix the flagged step before committing.",
          warnings: [{ code: "transform_empty_extraction", step_key: "filter_connected" }],
        },
      },
    };
    const r = renderCard(call);
    const frame = snapshot(r);
    expect(frame).toContain("Preview needs repair");
    expect(frame).not.toContain("Preview complete");
    expect(frame).not.toContain("with no errors");
    expect(frame).toContain("needs repair");
    r.unmount();
  });
});

describe("dry_run_workflow card · judge verdict block", () => {
  test("a partial verdict renders the verdict, reason, missing bullets, and the repair hint", () => {
    const call: ToolCallState = {
      id: "tc-judge-partial",
      name: "dry_run_workflow",
      args: {},
      status: "done",
      result: {
        ok: false,
        data: {
          ok: false,
          classification: "needs_repair",
          summary: "Ran 3 steps without errors, but the preview does not satisfy the user's goal.",
          judge: {
            verdict: "partial",
            reason:
              "The email body lists project names but omits the droplet specs the goal asks for.",
            missing: ["droplet specs (CPU/memory/disk) absent", "project names are empty strings"],
          },
        },
      },
    };
    const r = renderCard(call);
    const frame = snapshot(r);
    expect(frame).toContain("judge: partial");
    expect(frame).toContain("omits the droplet specs");
    expect(frame).toContain("• droplet specs (CPU/memory/disk) absent");
    expect(frame).toContain("• project names are empty strings");
    expect(frame).toContain("edit_workflow_patch");
    expect(frame).toContain("save_workflow_draft");
    expect(frame).toContain("Preview needs repair");
    r.unmount();
  });

  test("a failed verdict renders the same block with the failed verdict", () => {
    const call: ToolCallState = {
      id: "tc-judge-failed",
      name: "dry_run_workflow",
      args: {},
      status: "done",
      result: {
        ok: false,
        data: {
          ok: false,
          classification: "needs_repair",
          summary: "Preview output does not match the goal.",
          judge: {
            verdict: "failed",
            reason: "The output is an empty array; the goal asks for a ranked list of repos.",
            missing: ["ranked repo list"],
          },
        },
      },
    };
    const r = renderCard(call);
    const frame = snapshot(r);
    expect(frame).toContain("judge: failed");
    expect(frame).toContain("empty array");
    expect(frame).toContain("• ranked repo list");
    r.unmount();
  });

  test("a passes verdict renders a single quiet 'judge: passes' line, no repair hint", () => {
    const call = makeCall("dry_run_workflow", {
      ok: true,
      summary: "Ran 3 steps with no errors.",
      auto_committed: true,
      judge: { verdict: "passes", reason: "Output matches the goal.", missing: [] },
    });
    const r = renderCard(call);
    const frame = snapshot(r);
    expect(frame).toContain("judge: passes");
    expect(frame).not.toContain("edit_workflow_patch");
    expect(frame).not.toContain("does not satisfy");
    r.unmount();
  });

  test("a skipped verdict renders no judge line at all", () => {
    const call = makeCall("dry_run_workflow", {
      ok: true,
      summary: "Ran 2 steps with no errors.",
      judge: { verdict: "skipped", reason: "no_goal" },
    });
    const r = renderCard(call);
    const frame = snapshot(r);
    expect(frame).not.toContain("judge");
    r.unmount();
  });
});

describe("dry_run_workflow card · held write steps", () => {
  const heldEnvelope = {
    ok: false,
    classification: "needs_repair",
    summary: "Ran 2 steps; the send step was held.",
    step_trace: [
      {
        step_id: "fetch_projects",
        kind: "request",
        status: "succeeded",
        duration_ms: 120,
        output_preview: { projects: [{ name: "alpha" }] },
      },
      {
        step_id: "send_email",
        kind: "request",
        status: "succeeded",
        held: true,
        held_request: {
          method: "POST",
          url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
          headers_redacted: { authorization: "[redacted]" },
          body: { raw: "To: ops@example.com\nSubject: Daily DO resources\n\nalpha: 2 droplets" },
        },
      },
    ],
  };

  test("a held step renders the HELD label, never a bare success icon", () => {
    const call = makeCall("dry_run_workflow", heldEnvelope);
    const r = renderCard(call);
    const frame = snapshot(r);
    expect(frame).toContain("⏸ HELD");
    expect(frame).toContain("resolved, not dispatched");
    expect(frame).toContain("send_email");
    expect(frame).not.toContain("✓ send_email");
    expect(frame).toContain("✓ fetch_projects");
    r.unmount();
  });

  test("a held step shows the materialized request: METHOD url + body excerpt", () => {
    const call = makeCall("dry_run_workflow", heldEnvelope);
    const r = renderCard(call);
    const frame = snapshot(r);
    expect(frame).toContain("POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect(frame).toContain("body:");
    expect(frame).toContain("Daily DO resources");
    r.unmount();
  });

  test("held body longer than the excerpt budget is clipped, not dropped", () => {
    const longBody = "x".repeat(500);
    const call = makeCall("dry_run_workflow", {
      ok: false,
      classification: "needs_repair",
      summary: "Held send.",
      step_trace: [
        {
          step_id: "send",
          kind: "request",
          status: "succeeded",
          held: true,
          held_request: {
            method: "POST",
            url: "https://api.example.com/send",
            headers_redacted: {},
            body: longBody,
          },
        },
      ],
    });
    const r = renderCard(call);
    const frame = snapshot(r);
    expect(frame).toContain("⏸ HELD");
    expect(frame).toContain("body:");
    expect(frame).toContain("…");
    r.unmount();
  });

  test("step_trace without held steps renders the per-step lines (step_id key)", () => {
    const call = makeCall("dry_run_workflow", {
      ok: true,
      summary: "Ran 1 step with no errors.",
      step_trace: [
        { step_id: "fetch", kind: "request", status: "succeeded", output_preview: { n: 1 } },
      ],
    });
    const r = renderCard(call);
    const frame = snapshot(r);
    expect(frame).toContain("✓ fetch (request)");
    r.unmount();
  });
});
