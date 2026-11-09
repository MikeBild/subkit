import { expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  compileWorkflowEffectManifest,
  WorkflowEffectManifestSchema,
} from "../core/effect-manifest.ts";
import { plainHttpGet } from "./fixtures/graphql-path-manifest.ts";

function manifest() {
  return compileWorkflowEffectManifest(plainHttpGet()).manifest;
}

test("the public manifest schema preserves a compiled HTTP manifest", () => {
  const value = manifest();
  expect(WorkflowEffectManifestSchema.parse(value)).toEqual(value);
});

test("every documented issue code and its single-level call path survive schema parsing", () => {
  const base = manifest();
  const codes = [
    "missing_binding",
    "binding_mismatch",
    "environment_mismatch",
    "dynamic_request",
    "unknown_effect",
    "destructive_effect",
    "unbound_workflow_call",
    "boundary_contradicted_by_history",
  ] as const;
  const value = {
    ...base,
    issues: codes.map((code) => ({ step_id: "reviewed_child", code, call_path: ["parent_call"] })),
  };
  expect(WorkflowEffectManifestSchema.parse(value)).toEqual(value);
  for (const code of ["", "approved", "invalid_binding"]) {
    expect(
      WorkflowEffectManifestSchema.safeParse({ ...base, issues: [{ step_id: "child", code }] })
        .success,
    ).toBe(false);
  }
});

test("effect and issue call paths contain exactly one nonempty step name", () => {
  const base = manifest();
  const valid = {
    ...base,
    effects: base.effects.map((effect) => ({ ...effect, call_path: ["parent_call"] })),
  };
  expect(WorkflowEffectManifestSchema.parse(valid)).toEqual(valid);
  for (const call_path of [[], [""], ["parent", "grandparent"]]) {
    expect(
      WorkflowEffectManifestSchema.safeParse({
        ...base,
        effects: base.effects.map((effect) => ({ ...effect, call_path })),
      }).success,
    ).toBe(false);
    expect(
      WorkflowEffectManifestSchema.safeParse({
        ...base,
        issues: [{ step_id: "child", code: "missing_binding", call_path }],
      }).success,
    ).toBe(false);
  }
});

test("multiple version-pinned workflow calls retain their full public receipt", () => {
  const base = manifest();
  const pin = {
    step_id: "first_child",
    workflow_id: base.workflow_id,
    workflow_version_id: base.workflow_version_id,
    workflow_digest: base.workflow_digest,
    execution_options_digest: base.execution_options_digest,
  };
  const value = { ...base, calls: [pin, { ...pin, step_id: "second_child" }] };
  expect(WorkflowEffectManifestSchema.parse(value)).toEqual(value);
  expect(
    WorkflowEffectManifestSchema.safeParse({ ...base, calls: [{ ...pin, step_id: "" }] }).success,
  ).toBe(false);
  expect(
    WorkflowEffectManifestSchema.safeParse({ ...base, calls: [{ ...pin, extra: true }] }).success,
  ).toBe(false);
});

test("caller guards retain JSON execution guards and only accept the on-success erasure contract", () => {
  const base = manifest();
  const value = {
    ...base,
    caller_guards: {
      execution_guards: { policy: ["reviewed", { enabled: true }] },
      caller_erasure: "on_success" as const,
    },
  };
  expect(WorkflowEffectManifestSchema.parse(value)).toEqual(value);
  for (const caller_erasure of ["", "always", "never"]) {
    expect(
      WorkflowEffectManifestSchema.safeParse({ ...base, caller_guards: { caller_erasure } })
        .success,
    ).toBe(false);
  }
  expect(
    WorkflowEffectManifestSchema.safeParse({ ...base, caller_guards: { extra: true } }).success,
  ).toBe(false);
});

test("OpenAPI retains the public WorkflowEffectManifest component name", () => {
  const app = new OpenAPIHono();
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/manifest",
    responses: {
      200: {
        description: "Reviewed effect manifest",
        content: { "application/json": { schema: WorkflowEffectManifestSchema } },
      },
    },
  });
  const document = app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title: "Manifest contract", version: "1" },
  });
  expect(document.components?.schemas?.WorkflowEffectManifest).toBeDefined();
  expect(document.paths?.["/manifest"]?.get?.responses?.["200"]).toMatchObject({
    content: {
      "application/json": { schema: { $ref: "#/components/schemas/WorkflowEffectManifest" } },
    },
  });
});
