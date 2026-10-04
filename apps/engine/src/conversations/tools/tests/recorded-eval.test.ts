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
  test("reports a compile error for a bad JS transform body", async () => {
    const report = await runRecordedEval(
      {
        steps: [
          fetchStep(),
          { id: "shape", kind: "transform", language: "javascript", expression: "return items[;" },
        ],
      },
      { latest_preview: null },
    );
    const finding = report.expressions.find((f) => f.site === "steps.shape.expression");
    expect(finding?.status).toBe("compile_error");
    expect(typeof finding?.message).toBe("string");
    expect((finding?.message ?? "").length).toBeGreaterThan(0);
    expect(report.ok).toBe(false);
    expect(report.next_actions).toContain("edit_workflow_patch");
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
            language: "javascript",
            expression: "return input.scope.fetch.data.items.map((i) => i.name);",
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
            language: "javascript",
            expression: "return input.scope.fetch.data.wrong_field;",
          },
        ],
      },
      {
        latest_preview: evidenceFor(fetch, { items: [{ name: "Ada" }] }),
      },
    );
    const finding = report.expressions.find((f) => f.site === "steps.shape.expression");
    expect(finding?.status).toBe("empty_result");
    expect(finding?.path_candidates).toContain("input.scope.fetch.data.items");
    expect(report.ok).toBe(false);
    expect(report.next_actions).toContain("dry_run_transform");
    expect(report.next_actions).not.toContain("suggest_jsonata_paths");
  });

  test("stale evidence (fingerprint mismatch) is reported and blocks evaluation", async () => {
    const fetch = fetchStep();
    const staleEvidence = evidenceFor(
      { ...fetch, url: "https://example.com/OLD" },
      { items: [{ name: "Ada" }] },
    );
    const report = await runRecordedEval(
      {
        steps: [
          fetch,
          {
            id: "shape",
            kind: "transform",
            language: "javascript",
            expression: "return input.scope.fetch.data.items;",
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
  });
});

describe("runRecordedEval — bare-iteration-identifier lint", () => {
  test("a bare iteration identifier in a `branch.when` JSONata slot is still linted", async () => {
    const fetch = fetchStep();
    const report = await runRecordedEval(
      {
        steps: [
          fetch,
          { id: "iter", kind: "loop", over: "$scope.fetch.data.items", body: ["gate"] },
          {
            id: "gate",
            kind: "branch",
            when: "item.active = true",
            then_steps: [],
          },
        ],
      },
      { latest_preview: evidenceFor(fetch, { items: [{ name: "Ada" }] }) },
    );
    const finding = report.expressions.find((f) => f.site === "steps.gate.when");
    expect(finding?.status).toBe("eval_error");
    expect(finding?.message).toContain("`item`");
    expect(finding?.message).toContain("$item");
    expect(report.ok).toBe(false);
    expect(report.next_actions).toContain("edit_workflow_patch");
  });

  test("a JavaScript loop-body transform is unaffected by the JSONata lint", async () => {
    const fetch = fetchStep();
    const report = await runRecordedEval(
      {
        steps: [
          fetch,
          { id: "iter", kind: "loop", over: "$scope.fetch.data.items", body: ["shape"] },
          {
            id: "shape",
            kind: "transform",
            language: "javascript",
            expression: "const item = input.item; return item;",
          },
        ],
      },
      { latest_preview: evidenceFor(fetch, { items: [{ name: "Ada" }] }) },
    );
    const finding = report.expressions.find((f) => f.site === "steps.shape.expression");
    expect(finding?.status).toBe("not_evaluated");
  });
});

describe("runRecordedEval — gate verdicts as outcomes", () => {
  test("loop referencing un-previewed step yields gate blocks + missing_evidence + dry_run next action", async () => {
    const report = await runRecordedEval(
      {
        steps: [
          fetchStep(),
          { id: "iter", kind: "loop", over: "$scope.fetch.data", body: ["b"] },
          {
            id: "b",
            kind: "transform",
            language: "javascript",
            expression: "return input.scope.$item;",
          },
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
          { id: "iter", kind: "loop", over: "$scope.fetch.data.items", body: ["b"] },
          {
            id: "b",
            kind: "transform",
            language: "javascript",
            expression:
              'return input.scope.$item.name + " / " + input.scope.fetch.data.items[0].name;',
          },
        ],
      },
      { latest_preview: evidenceFor(fetch, { items: [{ name: "Ada" }] }) },
    );
    const finding = report.expressions.find((f) => f.site === "steps.b.expression");
    expect(finding?.status).toBe("not_evaluated");
    const over = report.expressions.find((f) => f.site === "steps.iter.over");
    expect(over?.status).toBe("ok");
  });
});
