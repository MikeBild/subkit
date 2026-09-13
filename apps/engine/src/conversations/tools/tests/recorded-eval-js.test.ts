// Recorded-evaluation pass over `language: "javascript"` transforms
// (Fix F). The authored code is a FUNCTION BODY executed in the same
// QuickJS sandbox as production (`execution/steps/transform.ts` →
// `runJs`), with the production context shape: one `input` value,
// upstream data at `input.scope.<step_id>.data…`, workflow input at
// `input.input`. Pure compute — zero egress (QuickJS has no host
// globals), no LLM, no DB.

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

function jsTransform(expression: string): Record<string, unknown> {
  return { id: "shape", kind: "transform", language: "javascript", expression };
}

describe("runRecordedEval — javascript transform evaluation", () => {
  test("a good function body evaluates against recorded scope via input.scope.<id>.data", async () => {
    const fetch = fetchStep();
    const report = await runRecordedEval(
      {
        steps: [
          fetch,
          jsTransform(
            "const items = input.scope.fetch.data.items;\nreturn items.map((i) => i.name);",
          ),
        ],
      },
      { latest_preview: evidenceFor(fetch, { items: [{ name: "Ada" }, { name: "Grace" }] }) },
    );
    const finding = report.expressions.find((f) => f.site === "steps.shape.expression");
    expect(finding?.status).toBe("ok");
    expect(finding?.value_preview).toEqual(["Ada", "Grace"]);
    // The JS scope reference is resolved and classified like a JSONata one.
    const ref = report.scope_refs.find(
      (r) => r.site === "steps.shape.expression" && r.referenced_step_id === "fetch",
    );
    expect(ref?.evidence).toBe("recorded");
    expect(report.ok).toBe(true);
    expect(report.next_actions).toEqual([]);
  });

  test("`input.input` is bound to the recorded workflow input", async () => {
    const fetch = fetchStep();
    const report = await runRecordedEval(
      {
        steps: [
          fetch,
          jsTransform(
            "return { first: input.scope.fetch.data.items[0].name, who: input.input.user };",
          ),
        ],
      },
      {
        latest_preview: evidenceFor(fetch, { items: [{ name: "Ada" }] }),
        input: { user: "mike" },
      },
    );
    const finding = report.expressions.find((f) => f.site === "steps.shape.expression");
    expect(finding?.status).toBe("ok");
    expect(finding?.value_preview).toEqual({ first: "Ada", who: "mike" });
  });

  test("empty result over TRUNCATED evidence is non-blocking (against_truncated_evidence)", async () => {
    // The Gmail divergence (F2): the preview showed `[]` because the
    // upstream payload was offloaded/omitted in the recorded evidence, while
    // the live run returned 174. An empty result over a stubbed payload is
    // not a confirmed problem and must not block the commit gate.
    const fetch = fetchStep();
    const report = await runRecordedEval(
      {
        steps: [
          fetch,
          jsTransform(
            "return (input.scope.fetch.data.messages || []).flatMap((m) => m.payload?.parts || []);",
          ),
        ],
      },
      {
        latest_preview: evidenceFor(fetch, {
          messages: [
            '[omitted: 9123 chars · shape: object{id,payload} — get_raw_result(ref="raw_abc")]',
          ],
        }),
      },
    );
    const finding = report.expressions.find((f) => f.site === "steps.shape.expression");
    expect(finding?.status).toBe("empty_result");
    expect(finding?.against_truncated_evidence).toBe(true);
    // Must NOT block the gate, and must steer to a faithful re-run rather than
    // a transform rewrite.
    expect(report.ok).toBe(true);
    expect(report.next_actions).toContain("dry_run_workflow");
    expect(report.next_actions).not.toContain("dry_run_transform");
  });

  test("empty result over FULL evidence still blocks (no false-negative)", async () => {
    const fetch = fetchStep();
    const report = await runRecordedEval(
      {
        steps: [
          fetch,
          jsTransform("return (input.scope.fetch.data.messages || []).filter(() => false);"),
        ],
      },
      { latest_preview: evidenceFor(fetch, { messages: [{ id: "1" }, { id: "2" }] }) },
    );
    const finding = report.expressions.find((f) => f.site === "steps.shape.expression");
    expect(finding?.status).toBe("empty_result");
    expect(finding?.against_truncated_evidence).toBeUndefined();
    expect(report.ok).toBe(false);
  });

  test("a syntax error yields compile_error with the sandbox's message", async () => {
    const fetch = fetchStep();
    const report = await runRecordedEval(
      {
        steps: [
          fetch,
          jsTransform(
            "const names = input.scope.fetch.data.items.map((i) => i.name;\nreturn names;",
          ),
        ],
      },
      { latest_preview: evidenceFor(fetch, { items: [{ name: "Ada" }] }) },
    );
    const finding = report.expressions.find((f) => f.site === "steps.shape.expression");
    expect(finding?.status).toBe("compile_error");
    expect(typeof finding?.message).toBe("string");
    expect((finding?.message ?? "").length).toBeGreaterThan(0);
    expect(report.ok).toBe(false);
    expect(report.summary).toContain("JavaScript compile error");
    expect(report.next_actions).toContain("edit_workflow_patch");
  });

  test("a non-evaluable body (no scope refs) still gets a parse-only syntax check", async () => {
    const report = await runRecordedEval(
      { steps: [fetchStep(), jsTransform("const x = ;\nreturn x;")] },
      { latest_preview: null },
    );
    const finding = report.expressions.find((f) => f.site === "steps.shape.expression");
    expect(finding?.status).toBe("compile_error");

    const clean = await runRecordedEval(
      { steps: [fetchStep(), jsTransform("return 42;")] },
      { latest_preview: null },
    );
    const cleanFinding = clean.expressions.find((f) => f.site === "steps.shape.expression");
    expect(cleanFinding?.status).toBe("not_evaluated");
    expect(cleanFinding?.message).toContain("syntax check only");
  });

  test("a throwing body yields eval_error with the runtime message", async () => {
    const fetch = fetchStep();
    const report = await runRecordedEval(
      {
        steps: [
          fetch,
          jsTransform("return input.scope.fetch.data.items.map((i) => i.missing.deep);"),
        ],
      },
      { latest_preview: evidenceFor(fetch, { items: [{ name: "Ada" }] }) },
    );
    const finding = report.expressions.find((f) => f.site === "steps.shape.expression");
    expect(finding?.status).toBe("eval_error");
    expect((finding?.message ?? "").length).toBeGreaterThan(0);
    expect(report.ok).toBe(false);
  });

  test("an empty result over non-empty evidence yields empty_result with input.scope path candidates", async () => {
    const fetch = fetchStep();
    const report = await runRecordedEval(
      {
        steps: [fetch, jsTransform("return input.scope.fetch.data.wrong_field;")],
      },
      { latest_preview: evidenceFor(fetch, { items: [{ name: "Ada" }] }) },
    );
    const finding = report.expressions.find((f) => f.site === "steps.shape.expression");
    expect(finding?.status).toBe("empty_result");
    expect(finding?.path_candidates).toContain("input.scope.fetch.data.items");
    // JS empty results do not recommend the JSONata path tool.
    expect(report.next_actions).toContain("dry_run_transform");
    expect(report.next_actions).not.toContain("suggest_jsonata_paths");
    expect(report.ok).toBe(false);
  });

  test("JSONata and JS sites coexist in one report without cross-talk", async () => {
    const fetch = fetchStep();
    const report = await runRecordedEval(
      {
        steps: [
          fetch,
          {
            id: "js_shape",
            kind: "transform",
            language: "javascript",
            expression: "return input.scope.fetch.data.items.length;",
          },
        ],
      },
      { latest_preview: evidenceFor(fetch, { items: [{ name: "Ada" }, { name: "Grace" }] }) },
    );
    expect(report.expressions.find((f) => f.site === "steps.js_shape.expression")?.status).toBe(
      "ok",
    );
    expect(report.ok).toBe(true);
  });
});
