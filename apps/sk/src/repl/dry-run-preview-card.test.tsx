// Bug C regression: the dry_run_workflow card showed only "Preview
// complete · workflow · ok · 290ms / Ran 4 steps with no errors."
// in session 86de186b — no preview output was rendered, so the
// operator had to ask the LLM "display results" to actually see what
// the workflow produced. Post-fix the card reads from `step_outputs`
// (#22) and `last_step.output_preview` so the produced data is
// always visible.

import { describe, expect, test } from "bun:test";
import type { ToolCallState } from "@cli-core/index.ts";
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
