import { describe, expect, test } from "bun:test";
import { effectChanges } from "../authority-changes.ts";
import type { ModelCallEffect } from "../core/model-call-effect.ts";
import { compileWorkflowEffectManifest, type WorkflowEffectManifest } from "../effect-manifest.ts";
import { modelCallReviewEffect, workflowReviewBoundaryDigest } from "../review-manifest.ts";

const TENANT = "00000000-0000-4000-8000-000000000001";
const WORKFLOW = "00000000-0000-4000-8000-000000000002";
const VERSION = "00000000-0000-4000-8000-000000000003";
const verdict = { type: "object", properties: { category: { type: "string" } } };
const shape = { id: "shape", kind: "transform", language: "javascript", expression: "return 1;" };

function compile(steps: unknown[]) {
  return compileWorkflowEffectManifest({
    tenant_id: TENANT,
    workflow_id: WORKFLOW,
    workflow_version_id: VERSION,
    execution_environment: "prod",
    execution_options_digest: "a".repeat(64),
    definition: { name: "plain", steps },
    bindings: [],
  }).manifest;
}

function modelCall(fields: Partial<ModelCallEffect> = {}): ModelCallEffect {
  return {
    step_id: "classify",
    flow: "workflow_step",
    effect: "read",
    max_output_tokens: 1024,
    repeated: false,
    data_paths: ["input.text"],
    ...fields,
  };
}

function withCalls(model_calls?: ModelCallEffect[]): WorkflowEffectManifest {
  const { model_calls: _calls, ...rest } = compile([shape]);
  return { ...rest, ...(model_calls ? { model_calls } : {}) };
}

describe("model calls in the workflow review", () => {
  test("the review digest of a workflow without model steps stays byte for byte", () => {
    expect(workflowReviewBoundaryDigest(compile([shape]))).toBe(
      "dfe740c4a920f26bf569d9b8fd367b2601749736b85d41467cb4d7190eac8ed8",
    );
  });

  test("a model step is part of the review digest", () => {
    const withModel = compile([
      shape,
      { id: "classify", kind: "model", prompt: "Sort ${input.text}", output_schema: verdict },
    ]);
    expect(workflowReviewBoundaryDigest(withModel)).not.toBe(
      workflowReviewBoundaryDigest({ ...withModel, model_calls: [modelCall({ repeated: true })] }),
    );
  });

  test("the review shows the AI model effect, its token cap, budget and data paths", () => {
    expect(modelCallReviewEffect(modelCall())).toEqual({
      step_id: "classify",
      connector_name: "AI model",
      connector_slug: null,
      effect: "read",
      target: "workspace AI model",
      details: [
        "Sends step data to the workspace AI model",
        "At most 1024 output tokens per call",
        "Counts against the AI budget",
        "Data paths: input.text",
      ],
    });
    expect(
      modelCallReviewEffect(modelCall({ repeated: true, data_paths: [], max_output_tokens: 200 }))
        .details,
    ).toEqual([
      "Sends step data to the workspace AI model",
      "At most 200 output tokens per call, once per item",
      "Counts against the AI budget",
    ]);
  });
});

describe("model calls in the authority changes", () => {
  test("added, widened, unchanged and removed model calls are reported", () => {
    const base = withCalls([
      modelCall({ step_id: "same" }),
      modelCall({ step_id: "grows" }),
      modelCall({ step_id: "gone" }),
    ]);
    const next = withCalls([
      modelCall({ step_id: "same" }),
      modelCall({ step_id: "grows", max_output_tokens: 4096 }),
      modelCall({ step_id: "fresh", call_path: ["sub"] }),
    ]);
    expect(
      effectChanges(base, next).map(({ step_id, call_path, change, model_call }) => [
        step_id,
        call_path ?? null,
        change,
        model_call,
      ]),
    ).toEqual([
      ["fresh", ["sub"], "added", true],
      ["grows", null, "widened", true],
      ["gone", null, "removed", true],
      ["same", null, "unchanged", true],
    ]);
  });

  test("a workflow without model steps reports no model calls", () => {
    expect(effectChanges(withCalls(), withCalls())).toEqual([]);
  });
});
