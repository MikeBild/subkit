// What a called workflow puts into an approval.
//
// A `call` step used to end the review: it raised `unbound_workflow_call` and
// the workflow could never be granted, however ordinary its child was. Three
// production workflows sit behind that, each genuinely orchestrating — one
// reads the child's output, one branches on it, one loops over it.
//
// The rule these pin: a child is COMPILED here, by the same code that compiles
// the parent, and its effects and issues are folded in under the call step they
// came through. Nothing is taken on the resolver's word, and a child whose
// target could change between the approval and the run is refused outright.

import { expect, test } from "bun:test";
import { workflowJsonDigest } from "../canonical-json.ts";
import { compileWorkflowEffectManifest, type ResolvedEffectBinding } from "../effect-manifest.ts";
import { WorkflowDefSchema } from "../types.ts";

const tenant = "00000000-0000-4000-8000-000000000001";
const workflow = "00000000-0000-4000-8000-000000000002";
const version = "00000000-0000-4000-8000-000000000003";
const connector = "00000000-0000-4000-8000-000000000004";
const child_workflow = "00000000-0000-4000-8000-000000000005";
const child_version = "00000000-0000-4000-8000-000000000006";
const OPTIONS = "c".repeat(64);

function def(steps: Array<Record<string, unknown>>, name = "parent") {
  return WorkflowDefSchema.parse(JSON.parse(JSON.stringify({ name, steps })));
}

function request(id: string, extra: Record<string, unknown> = {}) {
  return { id, kind: "request", connector_id: connector, method: "POST", path: `/${id}`, ...extra };
}

/** A binding as resolution would freeze it, bound to the step it describes. */
function binding(
  definition: ReturnType<typeof def>,
  step_id: string,
  target: string,
): ResolvedEffectBinding {
  const step = definition.steps.find((s) => s.id === step_id);
  return {
    tenant_id: tenant,
    step_id,
    connector_id: connector,
    driver: "http",
    environment: "dev",
    request_digest: workflowJsonDigest(step),
    target,
    configuration_digest: "a".repeat(64),
    credential_binding_digest: "b".repeat(64),
    rewrites_target: false,
  };
}

const CHILD = def([request("publish")], "child");

function resolvedChild(overrides: Record<string, unknown> = {}) {
  return {
    step_id: "run_child",
    workflow_id: child_workflow,
    workflow_slug: "publish-essay",
    workflow_version_id: child_version,
    execution_options_digest: "d".repeat(64),
    definition: CHILD,
    bindings: [binding(CHILD, "publish", "https://example.test/publish")],
    ...overrides,
  };
}

function parent(
  callStep: Record<string, unknown> = {},
  extraSteps: Array<Record<string, unknown>> = [],
) {
  const definition = def([
    request("collect"),
    { id: "run_child", kind: "call", workflow_id: child_workflow, ...callStep },
    ...extraSteps,
  ]);
  return {
    tenant_id: tenant,
    workflow_id: workflow,
    workflow_version_id: version,
    execution_environment: "dev" as const,
    execution_options_digest: OPTIONS,
    definition,
    bindings: [binding(definition, "collect", "https://example.test/collect")],
  };
}

test("a call nobody resolved stays unbound — exactly as before", () => {
  const result = compileWorkflowEffectManifest(parent());
  expect(result.manifest.issues).toEqual([{ step_id: "run_child", code: "unbound_workflow_call" }]);
  expect(result.eligible_for_repeated_runs).toBe(false);
  expect(result.call_refusals).toEqual([{ step_id: "run_child", reason: "child_unavailable" }]);
  // Nothing about the child leaked into an approval that refused it.
  expect(result.manifest.calls).toBeUndefined();
  expect(result.manifest.effects.map((e) => e.step_id)).toEqual(["collect"]);
});

test("a resolved call folds the child's effects under the step they came through", () => {
  const result = compileWorkflowEffectManifest({ ...parent(), calls: [resolvedChild()] });
  expect(result.manifest.issues).toEqual([]);
  expect(result.eligible_for_repeated_runs).toBe(true);
  expect(result.call_refusals).toEqual([]);
  expect(result.manifest.effects.map((e) => [e.step_id, e.call_path])).toEqual([
    ["collect", undefined],
    ["publish", ["run_child"]],
  ]);
  // The approval pins WHICH version runs, not what it is called.
  expect(result.manifest.calls).toEqual([
    {
      step_id: "run_child",
      workflow_id: child_workflow,
      workflow_version_id: child_version,
      workflow_digest: workflowJsonDigest(CHILD),
      execution_options_digest: "d".repeat(64),
    },
  ]);
});

test("the child's own problems arrive as this workflow's problems, marked as the child's", () => {
  const dynamic = def([request("publish", { path: "/publish/${scope.collect.data.id}" })], "child");
  const result = compileWorkflowEffectManifest({
    ...parent(),
    calls: [
      resolvedChild({
        definition: dynamic,
        bindings: [binding(dynamic, "publish", "https://example.test/publish")],
      }),
    ],
  });
  expect(result.manifest.issues).toEqual([
    { step_id: "publish", code: "dynamic_request", call_path: ["run_child"] },
  ]);
  expect(result.eligible_for_repeated_runs).toBe(false);
});

test("a child that calls a workflow itself is refused, and nothing of it is folded", () => {
  const nested = def(
    [request("publish"), { id: "deeper", kind: "call", workflow_id: workflow }],
    "child",
  );
  const result = compileWorkflowEffectManifest({
    ...parent(),
    calls: [
      resolvedChild({
        definition: nested,
        bindings: [binding(nested, "publish", "https://example.test/publish")],
      }),
    ],
  });
  expect(result.call_refusals).toEqual([{ step_id: "run_child", reason: "child_calls_workflow" }]);
  expect(result.manifest.issues).toEqual([{ step_id: "run_child", code: "unbound_workflow_call" }]);
  expect(result.manifest.effects.map((e) => e.step_id)).toEqual(["collect"]);
  expect(result.manifest.calls).toBeUndefined();
});

test("a call step that does not name exactly one fixed workflow is refused", () => {
  const both = compileWorkflowEffectManifest({
    ...parent({ workflow_slug: "publish-essay" }),
    calls: [resolvedChild()],
  });
  expect(both.call_refusals).toEqual([{ step_id: "run_child", reason: "target_not_static" }]);
  const neither = compileWorkflowEffectManifest({
    ...parent({ workflow_id: undefined }),
    calls: [resolvedChild()],
  });
  expect(neither.call_refusals).toEqual([{ step_id: "run_child", reason: "target_not_static" }]);
  // A resolver that answered with a different workflow than the step names.
  const swapped = compileWorkflowEffectManifest({
    ...parent(),
    calls: [resolvedChild({ workflow_id: "00000000-0000-4000-8000-0000000000ff" })],
  });
  expect(swapped.call_refusals).toEqual([{ step_id: "run_child", reason: "target_not_static" }]);
  for (const result of [both, neither, swapped]) {
    expect(result.manifest.issues).toEqual([
      { step_id: "run_child", code: "unbound_workflow_call" },
    ]);
    expect(result.manifest.calls).toBeUndefined();
  }
});

test("a parent and its child may share a step id without merging", () => {
  // Both call their step `publish`, against different targets. If the call path
  // were dropped anywhere — in the fold, the sort, or a flattened key — the two
  // would collapse and the reviewer would see one permission instead of two.
  const shared = def([
    request("publish"),
    { id: "run_child", kind: "call", workflow_id: child_workflow },
  ]);
  const input = {
    tenant_id: tenant,
    workflow_id: workflow,
    workflow_version_id: version,
    execution_environment: "dev" as const,
    execution_options_digest: OPTIONS,
    definition: shared,
    bindings: [binding(shared, "publish", "https://parent.test/publish")],
    calls: [resolvedChild()],
  };
  const result = compileWorkflowEffectManifest(input);
  expect(result.manifest.issues).toEqual([]);
  expect(result.manifest.effects.map((e) => [e.step_id, e.target, e.call_path])).toEqual([
    ["publish", "https://parent.test/publish", undefined],
    ["publish", "https://example.test/publish", ["run_child"]],
  ]);
});

test("own effects sort before called ones, and calls sort among themselves by step id", () => {
  const two = def([
    request("zzz_own"),
    { id: "b_call", kind: "call", workflow_id: child_workflow },
    { id: "a_call", kind: "call", workflow_id: child_workflow },
  ]);
  const result = compileWorkflowEffectManifest({
    tenant_id: tenant,
    workflow_id: workflow,
    workflow_version_id: version,
    execution_environment: "dev" as const,
    execution_options_digest: OPTIONS,
    definition: two,
    bindings: [binding(two, "zzz_own", "https://example.test/zzz")],
    calls: [resolvedChild({ step_id: "b_call" }), resolvedChild({ step_id: "a_call" })],
  });
  expect(result.manifest.effects.map((e) => [e.call_path?.[0] ?? null, e.step_id])).toEqual([
    [null, "zzz_own"],
    ["a_call", "publish"],
    ["b_call", "publish"],
  ]);
  expect(result.manifest.calls?.map((c) => c.step_id)).toEqual(["a_call", "b_call"]);
});

test("a resolved call must name a call step of this workflow, once", () => {
  expect(() =>
    compileWorkflowEffectManifest({
      ...parent(),
      calls: [resolvedChild(), resolvedChild()],
    }),
  ).toThrow(/at most once/);
  expect(() =>
    compileWorkflowEffectManifest({
      ...parent(),
      calls: [resolvedChild({ step_id: "collect" })],
    }),
  ).toThrow(/at most once/);
  expect(() =>
    compileWorkflowEffectManifest({
      ...parent(),
      calls: [resolvedChild({ step_id: "absent" })],
    }),
  ).toThrow(/at most once/);
});

test("a child carrying a proposal-derived profile is reported, not silently folded", () => {
  // Children are resolved with empty profile maps, so this cannot happen by the
  // intended path. It is refused anyway: a permission derived from the PARENT's
  // proposal context has not been reviewed for the child.
  const child = def([request("mail", { path: "/messages/send" })], "child");
  const withProfile = {
    ...binding(child, "mail", "https://mail.test/messages/send"),
    report_delivery: {
      kind: "gmail_report" as const,
      to: "reviewed@example.test",
      from: "robot@example.test",
      content_type: "text/plain" as const,
    },
  };
  const result = compileWorkflowEffectManifest({
    ...parent(),
    calls: [resolvedChild({ definition: child, bindings: [withProfile] })],
  });
  expect(
    result.manifest.issues.some(
      (i) => i.code === "binding_mismatch" && i.call_path?.[0] === "run_child",
    ),
  ).toBe(true);
  expect(result.eligible_for_repeated_runs).toBe(false);
});
