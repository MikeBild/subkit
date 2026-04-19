// Preview — read-only step executor used by dry_run_step / dry_run_workflow.
//
// Exercises the real drivers where they are pure (transform), and the
// classification path for unsupported or failing steps. The HTTP-driver
// path is covered indirectly by guided-authoring.e2e.test.ts where a
// real fetch is made against a running engine.

import { describe, expect, test } from "bun:test";
import { getDb } from "../../db/client.ts";
import type { StepDef } from "../../workflows/types.ts";
import { previewStep, previewWorkflow } from "../preview.ts";

describe("previewStep", () => {
  test("transform step returns classified ok with output preview", async () => {
    const step: StepDef = {
      id: "t1",
      kind: "transform",
      expression: "$input.n * 2",
      language: "jsonata",
    };
    const summary = await previewStep({
      db: getDb(),
      tenant_id: "preview-tenant",
      step,
      workflow_input: { n: 21 },
    });
    expect(summary.ok).toBe(true);
    expect(summary.classification).toBe("ok");
    expect(summary.output_preview).toBe(42);
    expect(summary.summary).toContain("Previewed step");
  });

  test("unsupported step kinds are classified as preview_unsupported", async () => {
    const step: StepDef = {
      id: "w1",
      kind: "wait",
      duration_ms: 0,
    };
    const summary = await previewStep({
      db: getDb(),
      tenant_id: "preview-tenant",
      step,
    });
    expect(summary.ok).toBe(false);
    expect(summary.classification).toBe("preview_unsupported");
  });

  test("unresolvable connector on a request step returns a classified failure", async () => {
    // With a real DB the unknown id surfaces `connector_not_found`, which
    // maps to `connector_missing`. Tests that spin up without the DB
    // auth can instead surface `auth_failed` / `driver_error` — the
    // contract we care about is simply that the preview reports a
    // classified failure rather than throwing.
    const step: StepDef = {
      id: "r1",
      kind: "request",
      method: "GET",
      path: "/health",
      connector_id: "00000000-0000-0000-0000-000000000000",
    };
    const summary = await previewStep({
      db: getDb(),
      tenant_id: "preview-tenant",
      step,
      budget_ms: 1000,
    });
    expect(summary.ok).toBe(false);
    expect(["connector_missing", "driver_error", "auth_failed", "unknown"]).toContain(
      summary.classification,
    );
  });
});

describe("previewWorkflow", () => {
  test("walks steps in order and returns ok when every step succeeds", async () => {
    // The engine's placeholder syntax (${scope.<step>}) is substituted by
    // the step executor before the driver sees it, so here we bind into
    // the jsonata data model directly: each step's output lands under
    // its id in the scope object that becomes the next step's root.
    const steps: StepDef[] = [
      {
        id: "t1",
        kind: "transform",
        expression: "$input.n",
        language: "jsonata",
      },
      {
        id: "t2",
        kind: "transform",
        expression: "t1 + 1",
        language: "jsonata",
      },
    ];
    const summary = await previewWorkflow({
      db: getDb(),
      tenant_id: "preview-tenant",
      steps,
      workflow_input: { n: 10 },
    });
    expect(summary.ok).toBe(true);
    expect(summary.steps_ran).toBe(2);
    expect(summary.classification).toBe("ok");
    expect(summary.last_step?.output_preview).toBe(11);
  });

  test("stops at the first failing step and carries its classification", async () => {
    const steps: StepDef[] = [
      {
        id: "t1",
        kind: "transform",
        expression: "input.n",
        language: "jsonata",
      },
      {
        id: "u1",
        kind: "wait",
        duration_ms: 0,
      },
    ];
    const summary = await previewWorkflow({
      db: getDb(),
      tenant_id: "preview-tenant",
      steps,
      workflow_input: { n: 1 },
    });
    expect(summary.ok).toBe(false);
    expect(summary.stopped_at_step_id).toBe("u1");
    expect(summary.classification).toBe("preview_unsupported");
    expect(summary.steps_ran).toBe(2);
  });

  test("empty workflow returns ok with zero steps_ran", async () => {
    const summary = await previewWorkflow({
      db: getDb(),
      tenant_id: "preview-tenant",
      steps: [],
    });
    expect(summary.ok).toBe(true);
    expect(summary.steps_ran).toBe(0);
  });
});
