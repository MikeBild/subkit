import { expect, test } from "bun:test";
import { workflowJsonDigest } from "../canonical-json.ts";
import {
  compileWorkflowEffectManifest,
  type ResolvedEffectBinding,
} from "../core/effect-manifest.ts";
import { requestDigest } from "../core/request-protocol.ts";
import { GMAIL_SEND_TARGET } from "../report-delivery-boundary.ts";
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
    request_digest: requestDigest(step),
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

test("an invalid JSON child definition is unavailable and contributes no effects", () => {
  const result = compileWorkflowEffectManifest({
    ...parent(),
    calls: [
      resolvedChild({
        definition: { name: "broken", steps: [{ kind: "unsupported" }] },
        bindings: [],
      }),
    ],
  });
  expect(result.call_refusals).toEqual([{ step_id: "run_child", reason: "child_unavailable" }]);
  expect(result.manifest.issues).toEqual([{ step_id: "run_child", code: "unbound_workflow_call" }]);
  expect(result.manifest.effects.map((effect) => effect.step_id)).toEqual(["collect"]);
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

test("a slug-targeted child must resolve to that exact reviewed slug", () => {
  const accepted = compileWorkflowEffectManifest({
    ...parent({ workflow_id: undefined, workflow_slug: "publish-essay" }),
    calls: [resolvedChild()],
  });
  expect(accepted.call_refusals).toEqual([]);
  expect(accepted.manifest.calls?.[0]?.workflow_id).toBe(child_workflow);

  const rejected = compileWorkflowEffectManifest({
    ...parent({ workflow_id: undefined, workflow_slug: "publish-essay" }),
    calls: [resolvedChild({ workflow_slug: "other-child" })],
  });
  expect(rejected.call_refusals).toEqual([{ step_id: "run_child", reason: "target_not_static" }]);
  expect(rejected.manifest.issues).toEqual([
    { step_id: "run_child", code: "unbound_workflow_call" },
  ]);
});

test("a parent and its child may share a step id without merging", () => {
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

test("call claims use the exact public duplicate-or-unrelated refusal", () => {
  expect(() =>
    compileWorkflowEffectManifest({
      ...parent(),
      calls: [resolvedChild(), resolvedChild()],
    }),
  ).toThrow("resolved calls must identify each call step at most once");
  expect(() =>
    compileWorkflowEffectManifest({
      ...parent(),
      calls: [resolvedChild({ step_id: "collect" })],
    }),
  ).toThrow("resolved calls must identify each call step at most once");
});

test("a child carrying a proposal-derived profile is reported, not silently folded", () => {
  const child = def(
    [
      request("mail", {
        url: GMAIL_SEND_TARGET,
        path: undefined,
        body: { raw: "${scope.render.data.raw}" },
      }),
    ],
    "child",
  );
  const withProfile = {
    ...binding(child, "mail", GMAIL_SEND_TARGET),
    report_delivery: {
      kind: "gmail_report" as const,
      to: "reviewed@example.test",
      from: "robot@example.test",
      content_type: "text/plain" as const,
    },
  };
  const childInput = {
    tenant_id: tenant,
    workflow_id: child_workflow,
    workflow_version_id: child_version,
    execution_environment: "dev" as const,
    execution_options_digest: "d".repeat(64),
    definition: child,
    bindings: [withProfile],
  };
  expect(compileWorkflowEffectManifest(childInput).manifest.issues).toEqual([]);
  const result = compileWorkflowEffectManifest({
    ...parent(),
    calls: [resolvedChild({ definition: child, bindings: [withProfile] })],
  });
  expect(result.manifest.issues).toEqual([
    { step_id: "mail", code: "binding_mismatch", call_path: ["run_child"] },
  ]);
  expect(result.eligible_for_repeated_runs).toBe(false);
});

test("a clean transactional child is still reported to its caller", () => {
  const transactional = {
    kind: "gmail_transactional" as const,
    webhook_id: "0d4c6f7e-3b2a-4a1c-8d9e-1f2a3b4c5d6e",
    event_type: "reviewed",
    event_type_input: "body.type",
    recipient_input: "body.email",
    request_id_input: "body.id",
    from: "robot@example.test",
    content_type: "text/plain" as const,
    max_body_bytes: 1024,
  };
  const child = WorkflowDefSchema.parse({
    name: "transactional child",
    execution_privacy: "sensitive",
    steps: [
      {
        id: "mail",
        kind: "request",
        connector_id: connector,
        method: "POST",
        url: GMAIL_SEND_TARGET,
        max_retries: 0,
        body: { raw: "${scope.render.data.raw}" },
        transactional_delivery: transactional,
      },
    ],
  });
  const childBinding = {
    ...binding(child, "mail", GMAIL_SEND_TARGET),
    transactional_delivery: transactional,
  };
  expect(
    compileWorkflowEffectManifest({
      tenant_id: tenant,
      workflow_id: child_workflow,
      workflow_version_id: child_version,
      execution_environment: "dev",
      execution_options_digest: "d".repeat(64),
      definition: child,
      bindings: [childBinding],
    }).manifest.issues,
  ).toEqual([]);
  const result = compileWorkflowEffectManifest({
    ...parent(),
    calls: [resolvedChild({ definition: child, bindings: [childBinding] })],
  });
  expect(result.manifest.issues).toEqual([
    { step_id: "mail", code: "binding_mismatch", call_path: ["run_child"] },
  ]);
});

test("a clean outbox child is still reported to its caller", () => {
  const outbox = {
    kind: "gmail_outbox" as const,
    source_step_id: "source",
    recipient_field: "email",
    item_id_field: "id",
    from: "robot@example.test",
    content_type: "text/plain" as const,
    max_body_bytes: 1024,
    max_per_day: 1,
  };
  const child = WorkflowDefSchema.parse({
    name: "outbox child",
    execution_privacy: "sensitive",
    steps: [
      {
        id: "source",
        kind: "request",
        connector_id: connector,
        method: "GET",
        url: "https://queue.example.test/next",
      },
      {
        id: "mail",
        kind: "request",
        connector_id: connector,
        method: "POST",
        url: GMAIL_SEND_TARGET,
        max_retries: 0,
        body: { raw: "${scope.render.data.raw}" },
        outbox_delivery: outbox,
      },
    ],
  });
  const bindings = [
    binding(child, "source", "https://queue.example.test/next"),
    { ...binding(child, "mail", GMAIL_SEND_TARGET), outbox_delivery: outbox },
  ];
  expect(
    compileWorkflowEffectManifest({
      tenant_id: tenant,
      workflow_id: child_workflow,
      workflow_version_id: child_version,
      execution_environment: "dev",
      execution_options_digest: "d".repeat(64),
      definition: child,
      bindings,
    }).manifest.issues,
  ).toEqual([]);
  const result = compileWorkflowEffectManifest({
    ...parent(),
    calls: [resolvedChild({ definition: child, bindings })],
  });
  expect(result.manifest.issues).toEqual([
    { step_id: "mail", code: "binding_mismatch", call_path: ["run_child"] },
  ]);
});

test("a clean content-publication child is still reported to its caller", () => {
  const origin = "https://content.example.test";
  const item = "00000000-0000-4000-8000-000000000007";
  const child = WorkflowDefSchema.parse({
    name: "publication child",
    steps: [
      {
        id: "revise",
        kind: "request",
        connector_id: connector,
        method: "PUT",
        path: "/v1/content/${item.item_id}/revisions",
        body: "${item.markdown}",
        headers: { "Content-Type": "text/markdown" },
      },
    ],
  });
  const childBinding = {
    ...binding(child, "revise", `${origin}/v1/content/{approved-item}/revisions`),
    content_publication: {
      kind: "content_revision" as const,
      origin,
      item_ids: [item],
      max_bytes: 1024,
    },
  };
  expect(
    compileWorkflowEffectManifest({
      tenant_id: tenant,
      workflow_id: child_workflow,
      workflow_version_id: child_version,
      execution_environment: "dev",
      execution_options_digest: "d".repeat(64),
      definition: child,
      bindings: [childBinding],
    }).manifest.issues,
  ).toEqual([]);
  const result = compileWorkflowEffectManifest({
    ...parent(),
    calls: [resolvedChild({ definition: child, bindings: [childBinding] })],
  });
  expect(result.manifest.issues).toEqual([
    { step_id: "revise", code: "binding_mismatch", call_path: ["run_child"] },
  ]);
});

test("child effects sharing a call path retain deterministic step ordering", () => {
  const child = def([request("zeta"), request("alpha")], "child");
  const result = compileWorkflowEffectManifest({
    ...parent(),
    calls: [
      resolvedChild({
        definition: child,
        bindings: [
          binding(child, "zeta", "https://example.test/zeta"),
          binding(child, "alpha", "https://example.test/alpha"),
        ],
      }),
    ],
  });
  expect(result.manifest.effects.map((effect) => [effect.call_path, effect.step_id])).toEqual([
    [undefined, "collect"],
    [["run_child"], "alpha"],
    [["run_child"], "zeta"],
  ]);
});

test("unavailable child refusals are sorted independently of authored call order", () => {
  const result = compileWorkflowEffectManifest(
    parent({}, [
      { id: "z_child", kind: "call", workflow_id: child_workflow },
      { id: "a_child", kind: "call", workflow_id: child_workflow },
    ]),
  );
  expect(result.call_refusals).toEqual([
    { step_id: "a_child", reason: "child_unavailable" },
    { step_id: "run_child", reason: "child_unavailable" },
    { step_id: "z_child", reason: "child_unavailable" },
  ]);
});
