// Unit tests for the recorded-evaluation pass (Fix 9, session
// 784c1b02). `runRecordedEval` is pure compute over the candidate
// workflow + recorded evidence: JSONata compile with caret errors,
// fingerprint-checked scope-ref resolution, transform evaluation
// against recorded scope, and the loop/transform gate verdicts — all
// as OUTCOMES in one report, never as call-bouncing preconditions and
// never with live HTTP.

import { describe, expect, test } from "bun:test";
import { runRecordedEval } from "../../recorded-eval.ts";
import { stepFingerprint } from "../../step-fingerprint.ts";
import type { DraftDocument } from "../../types.ts";

const fetchStep = () => ({
  id: "fetch",
  kind: "request",
  method: "GET",
  url: "https://example.com/items",
});

function evidenceFor(
  step: Record<string, unknown>,
  output_preview: unknown,
): DraftDocument["latest_preview"] {
  return {
    ok: true,
    step_id: String(step.id),
    summary: "ok",
    step_traces: [
      {
        step_id: String(step.id),
        kind: String(step.kind),
        status: "succeeded",
        fingerprint: stepFingerprint(step),
        output_preview,
        scope_at_step: {
          available_paths: ["items"],
          shape_summary: "object{items}",
          primary_data_path: "items",
        },
      },
    ],
  };
}

describe("runRecordedEval — compile findings", () => {
  test("reports a caret-pointed compile error for a bad expression", async () => {
    const report = await runRecordedEval(
      {
        steps: [
          fetchStep(),
          { id: "shape", kind: "transform", language: "jsonata", expression: "items[" },
        ],
      },
      { latest_preview: null },
    );
    const finding = report.expressions.find((f) => f.site === "steps.shape.expression");
    expect(finding?.status).toBe("compile_error");
    // The engine's formatError embeds a caret marker into the message.
    expect(finding?.message).toContain("█");
    expect(typeof finding?.position).toBe("number");
    expect(report.ok).toBe(false);
    expect(report.next_actions).toContain("update_param");
  });
});

describe("runRecordedEval — evaluation against recorded evidence", () => {
  test("evaluates a transform against fingerprint-valid recorded scope", async () => {
    const fetch = fetchStep();
    const report = await runRecordedEval(
      {
        steps: [
          fetch,
          {
            id: "shape",
            kind: "transform",
            language: "jsonata",
            expression: "$scope.fetch.data.items.name",
          },
        ],
      },
      {
        latest_preview: evidenceFor(fetch, { items: [{ name: "Ada" }, { name: "Grace" }] }),
      },
    );
    const finding = report.expressions.find((f) => f.site === "steps.shape.expression");
    expect(finding?.status).toBe("ok");
    expect(finding?.value_preview).toEqual(["Ada", "Grace"]);
    expect(report.ok).toBe(true);
    expect(report.gates.transform.ok).toBe(true);
    expect(report.next_actions).toEqual([]);
  });

  test("empty result over non-empty evidence yields path candidates", async () => {
    const fetch = fetchStep();
    const report = await runRecordedEval(
      {
        steps: [
          fetch,
          {
            id: "shape",
            kind: "transform",
            language: "jsonata",
            expression: "$scope.fetch.data.wrong_field",
          },
        ],
      },
      {
        latest_preview: evidenceFor(fetch, { items: [{ name: "Ada" }] }),
      },
    );
    const finding = report.expressions.find((f) => f.site === "steps.shape.expression");
    expect(finding?.status).toBe("empty_result");
    expect(finding?.path_candidates).toContain("$scope.fetch.data.items");
    expect(report.ok).toBe(false);
    expect(report.next_actions).toContain("suggest_jsonata_paths");
  });

  test("stale evidence (fingerprint mismatch) is reported and blocks evaluation", async () => {
    const fetch = fetchStep();
    const staleEvidence = evidenceFor(
      { ...fetch, url: "https://example.com/OLD" },
      { items: [{ name: "Ada" }] },
    );
    // The trace's step_id is still "fetch" but its fingerprint was
    // recorded against a different definition.
    const report = await runRecordedEval(
      {
        steps: [
          fetch,
          {
            id: "shape",
            kind: "transform",
            language: "jsonata",
            expression: "$scope.fetch.data.items",
          },
        ],
      },
      { latest_preview: staleEvidence },
    );
    const ref = report.scope_refs.find(
      (r) => r.site === "steps.shape.expression" && r.referenced_step_id === "fetch",
    );
    expect(ref?.evidence).toBe("stale");
    const finding = report.expressions.find((f) => f.site === "steps.shape.expression");
    expect(finding?.status).toBe("not_evaluated");
    // The gate verdict mirrors the staleness.
    expect(report.gates.transform.ok).toBe(false);
    expect(report.gates.transform.blocks[0]?.reason).toBe("preview_stale_for_referenced_step");
  });
});

describe("runRecordedEval — gate verdicts as outcomes", () => {
  test("loop referencing un-previewed step yields gate blocks + missing_evidence + dry_run next action", async () => {
    const report = await runRecordedEval(
      {
        steps: [
          fetchStep(),
          { id: "iter", kind: "loop", over: "$scope.fetch.data", item_var: "x", body: ["b"] },
          { id: "b", kind: "transform", language: "jsonata", expression: "$x" },
        ],
      },
      { latest_preview: null },
    );
    expect(report.ok).toBe(false);
    expect(report.gates.loop.ok).toBe(false);
    expect(report.missing_evidence.map((m) => m.step_id)).toContain("fetch");
    expect(report.missing_evidence[0]?.next_action).toBe("dry_run_workflow");
    expect(report.next_actions).toContain("dry_run_workflow");
  });

  test("loop-body transforms are compile-only (no $item context to evaluate against)", async () => {
    const fetch = fetchStep();
    const report = await runRecordedEval(
      {
        steps: [
          fetch,
          { id: "iter", kind: "loop", over: "$scope.fetch.data.items", item_var: "x", body: ["b"] },
          {
            id: "b",
            kind: "transform",
            language: "jsonata",
            expression: "$x.name & ' / ' & $scope.fetch.data.items[0].name",
          },
        ],
      },
      { latest_preview: evidenceFor(fetch, { items: [{ name: "Ada" }] }) },
    );
    const finding = report.expressions.find((f) => f.site === "steps.b.expression");
    expect(finding?.status).toBe("not_evaluated");
    // The loop's own `over` IS evaluable against the recorded scope.
    const over = report.expressions.find((f) => f.site === "steps.iter.over");
    expect(over?.status).toBe("ok");
  });
});
