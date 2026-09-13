import { describe, expect, test } from "bun:test";

import type { PatchProposal } from "../../llm/flows/repair.ts";
import { classifyPatch } from "../classifier.ts";
import type { DriftSignal } from "../types.ts";

function makeProposal(over: Partial<PatchProposal>): PatchProposal {
  return {
    classification: "safe",
    kind: "update_field_path",
    description: "test",
    patch: {},
    reasoning: "t",
    ...over,
  };
}

describe("self-healing/classifier", () => {
  test("field rename + widening keeps patch safe", () => {
    const decision = classifyPatch(
      makeProposal({
        kind: "update_field_path",
        patch: { op: "replace", path: "/data/id", value: "data/result/id" },
      }),
      null,
    );
    expect(decision.classification).toBe("safe");
  });

  test("add_header is safe", () => {
    const decision = classifyPatch(
      makeProposal({ kind: "add_header", patch: { name: "X-Trace", value: "1" } }),
      null,
    );
    expect(decision.classification).toBe("safe");
  });

  test("LLM self-flagged unsafe is respected", () => {
    const decision = classifyPatch(makeProposal({ classification: "unsafe" }), null);
    expect(decision.classification).toBe("unsafe");
    expect(decision.reasons[0]).toContain("proposal.classification=unsafe");
  });

  test("patch that touches HTTP method is unsafe", () => {
    const decision = classifyPatch(
      makeProposal({ kind: "other", patch: { method: "POST" } }),
      null,
    );
    expect(decision.classification).toBe("unsafe");
  });

  test("patch that changes auth_type is unsafe", () => {
    const decision = classifyPatch(
      makeProposal({ kind: "update_field_path", patch: { auth_type: "bearer" } }),
      null,
    );
    expect(decision.classification).toBe("unsafe");
  });

  test("patch that removes required fields is unsafe", () => {
    const decision = classifyPatch(
      makeProposal({
        kind: "update_field_path",
        patch: { required_removed: ["email"] },
      }),
      null,
    );
    expect(decision.classification).toBe("unsafe");
  });

  test("patch that flips status semantics is unsafe", () => {
    const decision = classifyPatch(
      makeProposal({ kind: "update_field_path", patch: { status_semantics_change: true } }),
      null,
    );
    expect(decision.classification).toBe("unsafe");
  });

  test("patch with destination URL change beyond path is unsafe", () => {
    const decision = classifyPatch(
      makeProposal({ kind: "update_field_path", patch: { url_change_beyond_path: true } }),
      null,
    );
    expect(decision.classification).toBe("unsafe");
  });

  test("schema_diff signal that removes keys forces unsafe", () => {
    const signal: DriftSignal = {
      kind: "schema_diff",
      before: { type: "object", properties: { id: { type: "number" } } },
      after: { type: "object", properties: {} },
      added: [],
      removed: ["id"],
      widened: [],
    };
    const decision = classifyPatch(makeProposal({ kind: "update_field_path" }), signal);
    expect(decision.classification).toBe("unsafe");
  });

  test("kind outside safe palette is unsafe", () => {
    const decision = classifyPatch(makeProposal({ kind: "other" }), null);
    expect(decision.classification).toBe("unsafe");
  });
});
