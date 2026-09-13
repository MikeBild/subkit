// Regression: the dry_run_workflow card showed only "Preview
// complete · workflow · ok · 290ms / Ran 4 steps with no errors." —
// no preview output was rendered, so the operator had to ask the LLM
// "display results" to actually see what the workflow produced. The
// card reads from `step_outputs` and `last_step.output_preview` so the
// produced data is always visible.

import type { ToolCallState } from "@cli-core/index.ts";
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";

import { renderAuthoringCard } from "./authoring-cards.tsx";

function snapshot(s: ReturnType<typeof render>): string {
  return (s.lastFrame() ?? "").replace(/\[[0-9;]*m/g, "");
}

/** `renderAuthoringCard` returns `React.ReactNode | null`; ink-testing-library's
 *  `render` is typed for `ReactElement`. Cast to satisfy the API at the
 *  test boundary — every call site here passes a non-null call so the
 *  returned node is always a real element. */
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
    // Some signal of the preview output, not just the bare summary.
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

  // The run_workflow card must show the ACTUAL warning, never the
  // hardcoded "Loop body produced no rows" — that text was wrong for
  // every non-loop workflow (e.g. a request + transform that filtered
  // to empty).
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

  // A repair-required preview (an empty transform, an unresolved ref)
  // must NOT read as a clean "Preview complete · ok". Pre-fix the card
  // showed "ok · Ran N steps with no errors" while the workflow
  // produced broken output, and the authoring agent kept iterating
  // against a false green.
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

// ---------------------------------------------------------------------------
// Preview-judge verdict block — dry_run_workflow may carry
// `judge: { verdict, reason, missing[] }`. A blocking verdict (partial /
// failed) is WHY the preview did not auto-commit, so the card must say
// so prominently; `passes` is one quiet line; `skipped` renders nothing.
// ---------------------------------------------------------------------------

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
    // Judge block joins the needs_repair path — never a clean green.
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

// ---------------------------------------------------------------------------
// Held write steps — hold-writes previews resolve a write step's request
// (URL/headers/body materialized) but never dispatch it. The step rides
// the trace as `held: true` + `held_request` and must NOT look like a
// normal green step: the materialized body is the operator's review
// artifact.
// ---------------------------------------------------------------------------

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
    // The held step must not render as a checked success line.
    expect(frame).not.toContain("✓ send_email");
    // The non-held sibling still renders normally.
    expect(frame).toContain("✓ fetch_projects");
    r.unmount();
  });

  test("a held step shows the materialized request: METHOD url + body excerpt", () => {
    const call = makeCall("dry_run_workflow", heldEnvelope);
    const r = renderCard(call);
    const frame = snapshot(r);
    expect(frame).toContain("POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    // The held email body is the review artifact — it must be visible.
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
