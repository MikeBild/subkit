// patch-apply — the one patch semantic behind preview, dry-run and apply.
//
// Pins the properties the self-healing loop rests on:
//   - `update_field_path` rewrites the projection of the addressed step
//   - a proposal kind the engine cannot perform is refused, never silently
//     turned into a version that changes nothing
//   - every refusal names a reason, so an unapplied patch is never recorded
//     as a repair
//   - the input DAG is never mutated

import { describe, expect, test } from "bun:test";
import type { PatchProposal } from "../../llm/flows/repair.ts";
import {
  applyPatchToWorkflowDag,
  applyRewriteToSlots,
  diffStepPaths,
  type ProjectionSlots,
  resolvePathRewrite,
} from "../patch-apply.ts";

function proposal(over: Partial<PatchProposal> = {}): PatchProposal {
  return {
    classification: "safe",
    kind: "update_field_path",
    description: "field moved",
    patch: { op: "replace", path: "/data/id", value: "data/result/id" },
    reasoning: "connector nested the payload",
    ...over,
  } as PatchProposal;
}

function dag(step: Record<string, unknown>) {
  return { name: "wf", steps: [{ kind: "request", id: "req-1", ...step }] };
}

describe("resolvePathRewrite", () => {
  test("reads slash paths as dotted paths", () => {
    expect(resolvePathRewrite(proposal())).toEqual({ from: "data.id", to: "data.result.id" });
  });

  test("kinds without executable semantics resolve to null", () => {
    for (const kind of ["rename_param", "add_header", "change_type", "rate_limited", "other"]) {
      expect(resolvePathRewrite(proposal({ kind: kind as PatchProposal["kind"] }))).toBeNull();
    }
  });

  test("a proposal with no target value is not a rewrite", () => {
    expect(resolvePathRewrite(proposal({ patch: { op: "replace", path: "/data/id" } }))).toBeNull();
  });
});

describe("applyRewriteToSlots", () => {
  const rewrite = { from: "data.id", to: "data.result.id" };

  test("request: rewrites an existing selector", () => {
    const out = applyRewriteToSlots({ data_selector: "data.id" }, rewrite, "request");
    expect(out.data_selector).toBe("data.result.id");
  });

  test("request: introduces a selector when the step had none", () => {
    const bare: ProjectionSlots = {};
    expect(applyRewriteToSlots(bare, rewrite, "request").data_selector).toBe("data.result.id");
  });

  test("request: leaves an existing selector alone when the old path is unknown", () => {
    const out = applyRewriteToSlots(
      { data_selector: "data.id" },
      { from: null, to: "x.y" },
      "request",
    );
    expect(out.data_selector).toBe("data.id");
  });

  test("transform: rewrites the expression and never grows a selector", () => {
    const step: ProjectionSlots = { expression: "return input.scope.data.id;" };
    const out = applyRewriteToSlots(step, rewrite, "transform");
    expect(out.expression).toBe("return input.scope.data.result.id;");
    expect(out.data_selector).toBeUndefined();
  });
});

describe("applyPatchToWorkflowDag", () => {
  test("rewrites the addressed step and reports the changed path", () => {
    const before = dag({ data_selector: "data.id" });
    const out = applyPatchToWorkflowDag(before, "req-1", proposal());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect((out.dag.steps as Record<string, unknown>[])[0]?.data_selector).toBe("data.result.id");
    expect(out.changed_paths).toEqual(["data_selector"]);
    // The persisted row the caller holds must survive untouched.
    expect((before.steps[0] as Record<string, unknown>).data_selector).toBe("data.id");
  });

  test("keeps every other step and every other field", () => {
    const before = {
      name: "wf",
      steps: [
        { kind: "request", id: "req-0", data_selector: "data.id", method: "GET" },
        { kind: "request", id: "req-1", data_selector: "data.id", method: "POST" },
      ],
    };
    const out = applyPatchToWorkflowDag(before, "req-1", proposal());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const steps = out.dag.steps as Record<string, unknown>[];
    expect(steps[0]?.data_selector).toBe("data.id");
    expect(steps[1]?.method).toBe("POST");
    expect(out.dag.name).toBe("wf");
  });

  test("no step anchor — refused", () => {
    const out = applyPatchToWorkflowDag(dag({ data_selector: "data.id" }), null, proposal());
    expect(out).toEqual({ ok: false, reason: "no_step_anchor" });
  });

  test("anchor no longer in the definition — refused", () => {
    const out = applyPatchToWorkflowDag(dag({ data_selector: "data.id" }), "gone", proposal());
    expect(out).toEqual({ ok: false, reason: "step_not_found" });
  });

  test("a kind the engine cannot perform — refused, not applied", () => {
    const out = applyPatchToWorkflowDag(
      dag({ data_selector: "data.id" }),
      "req-1",
      proposal({ kind: "add_header" }),
    );
    expect(out).toEqual({ ok: false, reason: "patch_not_applicable" });
  });

  test("a step kind with no projection — refused", () => {
    const out = applyPatchToWorkflowDag(
      { name: "wf", steps: [{ kind: "wait", id: "req-1" }] },
      "req-1",
      proposal(),
    );
    expect(out).toEqual({ ok: false, reason: "unsupported_step_kind" });
  });

  test("a rewrite that changes nothing — refused", () => {
    const out = applyPatchToWorkflowDag(
      dag({ data_selector: "data.result.id" }),
      "req-1",
      proposal({ patch: { op: "replace", path: "/nowhere", value: "data/result/id" } }),
    );
    expect(out).toEqual({ ok: false, reason: "no_change" });
  });

  test("a DAG with no steps array — refused", () => {
    expect(applyPatchToWorkflowDag({ name: "wf" }, "req-1", proposal())).toEqual({
      ok: false,
      reason: "malformed_dag",
    });
  });
});

describe("diffStepPaths", () => {
  test("flags only the keys that changed, sorted", () => {
    expect(
      diffStepPaths(
        { id: "s1", kind: "request", data_selector: "data.id" },
        { id: "s1", kind: "request", data_selector: "data.result.id" },
      ),
    ).toEqual(["data_selector"]);
  });

  test("identical steps yield no paths", () => {
    const step = { id: "s1", kind: "transform", expression: "return input.scope.s0.data.x;" };
    expect(diffStepPaths(step, { ...step })).toEqual([]);
  });
});
