import { describe, expect, test } from "bun:test";

import type { PatchProposal } from "../../llm/flows/repair.ts";
import { applyPatchToStep, runFixtureDryRun } from "../fixture-runner.ts";
import type { DryRunStep } from "../types.ts";

function makeProposal(patch: Record<string, unknown>): PatchProposal {
  return {
    classification: "safe",
    kind: "update_field_path",
    description: "rename",
    patch,
    reasoning: "t",
  };
}

describe("self-healing/fixture-runner", () => {
  test("applyPatchToStep rewrites a data_selector on a request step", () => {
    const step: DryRunStep = {
      id: "step-1",
      kind: "request",
      data_selector: "data.id",
    };
    const patched = applyPatchToStep(
      step,
      makeProposal({ op: "replace", path: "/data/id", value: "data/result/id" }),
    );
    expect(patched.data_selector).toBe("data.result.id");
    // Original must be untouched.
    expect(step.data_selector).toBe("data.id");
  });

  test("applyPatchToStep rewrites a transform expression", () => {
    const step: DryRunStep = {
      id: "step-2",
      kind: "transform",
      expression: "data.id",
    };
    const patched = applyPatchToStep(
      step,
      makeProposal({ op: "replace", path: "/data/id", value: "data/result/id" }),
    );
    expect(patched.expression).toBe("data.result.id");
  });

  test("dry-run passes when the patched selector resolves against the fixture", async () => {
    const step: DryRunStep = {
      id: "step-1",
      kind: "request",
      data_selector: "data.id",
    };
    const patch = makeProposal({
      op: "replace",
      path: "/data/id",
      value: "data/result/id",
    });
    const fixture = {
      request: { url: "/users/1" },
      response: { data: { result: { id: 42, name: "Ada" } } },
    };
    const out = await runFixtureDryRun({ step, patch, fixture });
    expect(out.ok).toBe(true);
    expect(out.value).toBe(42);
  });

  test("dry-run fails when the patched selector still misses", async () => {
    const step: DryRunStep = {
      id: "step-1",
      kind: "request",
      data_selector: "data.id",
    };
    const patch = makeProposal({
      op: "replace",
      path: "/data/id",
      value: "data/missing/path",
    });
    const fixture = {
      request: {},
      response: { data: { other: 1 } },
    };
    const out = await runFixtureDryRun({ step, patch, fixture });
    expect(out.ok).toBe(false);
    expect(out.error).toBeDefined();
  });

  test("transform dry-run evaluates against the recorded response", async () => {
    const step: DryRunStep = {
      id: "step-t",
      kind: "transform",
      expression: "data.id",
    };
    const patch = makeProposal({
      op: "replace",
      path: "/data/id",
      value: "data/result/id",
    });
    const out = await runFixtureDryRun({
      step,
      patch,
      fixture: { request: null, response: { data: { result: { id: 7 } } } },
    });
    expect(out.ok).toBe(true);
    expect(out.value).toBe(7);
  });
});
