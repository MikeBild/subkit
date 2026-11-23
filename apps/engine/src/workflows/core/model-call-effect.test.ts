import { describe, expect, test } from "bun:test";
import { type CallStep, CallStepSchema, type ModelStep, ModelStepSchema } from "../types.ts";
import { projectBoundaryGrowth } from "./authority-inheritance.ts";
import { compileWorkflowEffectManifest, type WorkflowEffectManifest } from "./effect-manifest.ts";
import {
  MODEL_CALL_DATA_PATHS_MAX,
  type ModelCallEffect,
  modelCallLabel,
  modelCallMatch,
  modelCallOf,
  modelCallThrough,
  modelCallWidened,
  sortModelCalls,
} from "./model-call-effect.ts";

const TENANT = "00000000-0000-4000-8000-000000000001";
const WORKFLOW = "00000000-0000-4000-8000-000000000002";
const VERSION = "00000000-0000-4000-8000-000000000003";
const CHILD_WORKFLOW = "00000000-0000-4000-8000-00000000000d";
const CHILD_VERSION = "00000000-0000-4000-8000-00000000000e";
const verdict = { type: "object", properties: { category: { type: "string" } } };

function modelStep(fields: Record<string, unknown> = {}): ModelStep {
  return ModelStepSchema.parse({
    id: "classify",
    kind: "model",
    prompt: "Classify",
    output_schema: verdict,
    ...fields,
  });
}

function callStep(fields: Record<string, unknown> = {}): CallStep {
  return CallStepSchema.parse({ id: "sub", kind: "call", workflow_id: CHILD_WORKFLOW, ...fields });
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

function compile(steps: unknown[], calls?: unknown[]) {
  return compileWorkflowEffectManifest({
    tenant_id: TENANT,
    workflow_id: WORKFLOW,
    workflow_version_id: VERSION,
    execution_environment: "prod",
    execution_options_digest: "a".repeat(64),
    definition: { name: "plain", steps },
    bindings: [],
    ...(calls ? { calls } : {}),
  });
}

describe("a model step as a model call", () => {
  test("names the flow, the effective output cap and the data paths it sends", () => {
    expect(
      modelCallOf(
        modelStep({
          prompt: "Sort ${scope.fetch.data.body} for ${caller.email} and ${scope.fetch.data.body}",
          system: "Tone ${state.tone}",
          input: { rows: ["${input.text}"], fixed: 3 },
        }),
      ),
    ).toEqual({
      step_id: "classify",
      flow: "workflow_step",
      effect: "read",
      max_output_tokens: 1024,
      repeated: false,
      data_paths: ["caller.email", "input.text", "scope.fetch.data.body", "state.tone"],
    });
  });

  test("an explicit output cap and a for_each are carried over", () => {
    const call = modelCallOf(
      modelStep({
        max_output_tokens: 200,
        for_each: "(sourceData) => sourceData.list.data.items",
        prompt: "Sort ${item.text}",
      }),
    );
    expect(call.max_output_tokens).toBe(200);
    expect(call.repeated).toBe(true);
    expect(call.data_paths).toEqual(["item.text"]);
  });

  test("secret placeholders never count as data paths", () => {
    expect(modelCallOf(modelStep({ prompt: "Use ${cred.github.token}" })).data_paths).toEqual([]);
  });

  test("data paths stop at the limit", () => {
    const input = Object.fromEntries(
      Array.from({ length: MODEL_CALL_DATA_PATHS_MAX + 5 }, (_, index) => [
        `f${index}`,
        `\${input.f${String(index).padStart(3, "0")}}`,
      ]),
    );
    const paths = modelCallOf(modelStep({ input })).data_paths;
    expect(paths).toHaveLength(MODEL_CALL_DATA_PATHS_MAX);
    expect(paths[0]).toBe("input.f000");
  });

  test("a call step names its path and repeats the child's call per item", () => {
    expect(modelCallThrough(modelCall(), callStep())).toEqual(modelCall({ call_path: ["sub"] }));
    expect(
      modelCallThrough(modelCall(), callStep({ for_each: "(sourceData) => sourceData.x.data" }))
        .repeated,
    ).toBe(true);
    expect(modelCallThrough(modelCall({ repeated: true }), callStep()).repeated).toBe(true);
  });

  test("labels, sorting and matching use the call path and the step id", () => {
    const parent = modelCall({ step_id: "b" });
    const child = modelCall({ step_id: "a", call_path: ["sub"] });
    const first = modelCall({ step_id: "a" });
    expect(modelCallLabel(parent)).toBe("b");
    expect(modelCallLabel(child)).toBe("sub/a");
    expect(sortModelCalls([child, parent, first])).toEqual([first, parent, child]);
    expect(modelCallMatch([parent, child], modelCall({ step_id: "a", call_path: ["sub"] }))).toBe(
      child,
    );
    expect(modelCallMatch([parent], first)).toBeUndefined();
    expect(modelCallMatch(undefined, first)).toBeUndefined();
  });

  test("a call widens with more output tokens, a new repetition or new data paths only", () => {
    const granted = modelCall({ data_paths: ["input.a", "input.b"] });
    expect(modelCallWidened(modelCall({ data_paths: ["input.a"] }), granted)).toBe(false);
    expect(modelCallWidened(modelCall({ ...granted, max_output_tokens: 512 }), granted)).toBe(
      false,
    );
    expect(modelCallWidened(modelCall({ ...granted, max_output_tokens: 2048 }), granted)).toBe(
      true,
    );
    expect(modelCallWidened(modelCall({ ...granted, repeated: true }), granted)).toBe(true);
    expect(
      modelCallWidened(modelCall({ ...granted, repeated: false }), { ...granted, repeated: true }),
    ).toBe(false);
    expect(modelCallWidened(modelCall({ data_paths: ["input.c"] }), granted)).toBe(true);
  });
});

describe("model calls in the effect manifest", () => {
  const plain = [
    { id: "shape", kind: "transform", language: "javascript", expression: "return 1;" },
  ];

  test("a workflow without model steps keeps its manifest and digest byte for byte", () => {
    const result = compile(plain);
    expect(result.manifest).not.toHaveProperty("model_calls");
    expect(result.digest).toBe("08664e90a7a37b81c9d172c308efcc7cde80bfd9160ce313ce770e5f6a9238f3");
  });

  test("a model step is declared, and it changes the digest", () => {
    const result = compile([
      ...plain,
      { id: "classify", kind: "model", prompt: "Sort ${input.text}", output_schema: verdict },
    ]);
    expect(result.manifest.model_calls).toEqual([modelCall()]);
    expect(result.manifest.effects).toEqual([]);
    expect(result.manifest.issues).toEqual([]);
    expect(result.eligible_for_repeated_runs).toBe(true);
    expect(result.digest).not.toBe(compile(plain).digest);
  });

  test("a child workflow's model calls are declared under the call path", () => {
    const result = compile(
      [{ id: "sub", kind: "call", workflow_id: CHILD_WORKFLOW, for_each: "(s) => s.x" }],
      [
        {
          step_id: "sub",
          workflow_id: CHILD_WORKFLOW,
          workflow_slug: "child",
          workflow_version_id: CHILD_VERSION,
          execution_options_digest: "b".repeat(64),
          definition: {
            name: "child",
            steps: [
              { id: "summarize", kind: "model", prompt: "Sum ${input.a}", output_schema: verdict },
            ],
          },
          bindings: [],
        },
      ],
    );
    expect(result.manifest.model_calls).toEqual([
      modelCall({
        step_id: "summarize",
        call_path: ["sub"],
        repeated: true,
        data_paths: ["input.a"],
      }),
    ]);
  });
});

describe("model calls in the approval boundary", () => {
  const manifest = (model_calls?: ModelCallEffect[]): WorkflowEffectManifest => ({
    schema_version: 1,
    tenant_id: TENANT,
    workflow_id: WORKFLOW,
    workflow_version_id: VERSION,
    workflow_digest: "e".repeat(64),
    execution_environment: "prod",
    execution_options_digest: "c".repeat(64),
    effects: [],
    issues: [],
    ...(model_calls ? { model_calls } : {}),
  });
  const growth = (granted?: ModelCallEffect[], next?: ModelCallEffect[]) =>
    projectBoundaryGrowth(manifest(granted), manifest(next)).growth;

  test("a new model step is growth, so an earlier approval does not carry over", () => {
    expect(growth(undefined, [modelCall()])).toEqual([
      {
        kind: "new_model_call",
        connector_id: null,
        target: null,
        effect: "read",
        item: "classify",
      },
    ]);
    expect(growth([modelCall()], [modelCall({ step_id: "a", call_path: ["sub"] })])).toEqual([
      { kind: "new_model_call", connector_id: null, target: null, effect: "read", item: "sub/a" },
    ]);
  });

  test("a wider model call is growth; prompt wording alone carries over", () => {
    expect(growth([modelCall()], [modelCall({ max_output_tokens: 4096 })])).toHaveLength(1);
    expect(growth([modelCall()], [modelCall({ repeated: true })])).toHaveLength(1);
    expect(growth([modelCall()], [modelCall({ data_paths: ["input.secret_note"] })])).toHaveLength(
      1,
    );
    expect(growth([modelCall()], [modelCall()])).toEqual([]);
    expect(growth([modelCall()], undefined)).toEqual([]);
  });
});
