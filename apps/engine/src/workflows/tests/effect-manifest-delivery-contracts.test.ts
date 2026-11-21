import { expect, test } from "bun:test";
import { workflowJsonDigest } from "../canonical-json.ts";
import {
  compileWorkflowEffectManifest,
  type ResolvedEffectBinding,
  WorkflowEffectManifestSchema,
} from "../core/effect-manifest.ts";
import { GMAIL_SEND_TARGET } from "../report-delivery-boundary.ts";
import { WorkflowDefSchema } from "../types.ts";

const tenant = "00000000-0000-4000-8000-000000000001";
const workflow = "00000000-0000-4000-8000-000000000002";
const version = "00000000-0000-4000-8000-000000000003";
const connector = "00000000-0000-4000-8000-000000000004";
const report = {
  kind: "gmail_report" as const,
  to: "recipient@example.test",
  from: "sender@example.test",
  content_type: "text/plain" as const,
};
const transactional = {
  kind: "gmail_transactional" as const,
  webhook_id: "0d4c6f7e-3b2a-4a1c-8d9e-1f2a3b4c5d6e",
  event_type: "application.received",
  event_type_input: "body.type",
  recipient_input: "body.applicant.email",
  request_id_input: "body.id",
  from: "sender@example.test",
  content_type: "text/plain" as const,
  max_body_bytes: 4096,
};

function input(
  step: Record<string, unknown>,
  bindingPatch: Partial<ResolvedEffectBinding> = {},
  privacy: "sensitive" | undefined = undefined,
) {
  const definition = WorkflowDefSchema.parse({
    name: "Delivery contract",
    ...(privacy ? { execution_privacy: privacy } : {}),
    steps: [{ id: "send", kind: "request", connector_id: connector, method: "POST", ...step }],
  });
  const request = definition.steps[0]!;
  const binding: ResolvedEffectBinding = {
    tenant_id: tenant,
    step_id: "send",
    connector_id: connector,
    driver: "http",
    environment: "dev",
    request_digest: workflowJsonDigest(request),
    target: GMAIL_SEND_TARGET,
    configuration_digest: "a".repeat(64),
    credential_binding_digest: "b".repeat(64),
    rewrites_target: false,
    ...bindingPatch,
  };
  return {
    tenant_id: tenant,
    workflow_id: workflow,
    workflow_version_id: version,
    execution_environment: "dev" as const,
    execution_options_digest: "c".repeat(64),
    definition,
    bindings: [binding],
  };
}

const reportStep = {
  path: "/gmail/v1/users/me/messages/send",
  body: { raw: "${steps.render.data.raw}" },
};

test("report delivery is an exact Gmail shape, and its boundary cannot be silently weakened", () => {
  const accepted = compileWorkflowEffectManifest(input(reportStep, { report_delivery: report }));
  expect(accepted.manifest.issues).toEqual([]);
  expect(accepted.eligible_for_repeated_runs).toBe(true);

  for (const [stepPatch, bindingPatch] of [
    [{ method: "GET" }, {}],
    [{ body: { raw: "${steps.render.data.raw}", threadId: "x" } }, {}],
    [{ pagination: { strategy: "page", page_param: "page", max_pages: 1 } }, {}],
    [{}, { target: "https://mail.example.test/send" }],
  ] as const) {
    const candidate = input(
      { ...reportStep, ...stepPatch },
      { report_delivery: report, ...bindingPatch },
    );
    const result = compileWorkflowEffectManifest(candidate);
    expect(result.manifest.issues).toContainEqual({ step_id: "send", code: "binding_mismatch" });
    expect(result.eligible_for_repeated_runs).toBe(false);
  }
});

test("transactional delivery requires sensitive privacy, a matching profile, and an admissible Gmail request", () => {
  const accepted = compileWorkflowEffectManifest(
    input(
      { ...reportStep, max_retries: 0, transactional_delivery: transactional },
      { transactional_delivery: transactional },
      "sensitive",
    ),
  );
  expect(accepted.manifest.issues).toEqual([]);

  for (const [privacy, stepPatch, bindingPatch] of [
    [undefined, {}, {}],
    ["sensitive", { max_retries: 1 }, {}],
    ["sensitive", { report_delivery: report }, {}],
    ["sensitive", {}, { transactional_delivery: { ...transactional, event_type: "other" } }],
    ["sensitive", {}, { transactional_delivery: undefined }],
  ] as const) {
    const candidate = input(
      { ...reportStep, max_retries: 0, transactional_delivery: transactional, ...stepPatch },
      { transactional_delivery: transactional, ...bindingPatch },
      privacy,
    );
    const result = compileWorkflowEffectManifest(candidate);
    expect(result.manifest.issues).toContainEqual({ step_id: "send", code: "binding_mismatch" });
    expect(result.eligible_for_repeated_runs).toBe(false);
  }
});

test("transactional presence must match the authored request in both directions", () => {
  const absentBinding = compileWorkflowEffectManifest(
    input(
      { ...reportStep, max_retries: 0, transactional_delivery: transactional },
      {},
      "sensitive",
    ),
  );
  expect(absentBinding.manifest.issues).toContainEqual({
    step_id: "send",
    code: "binding_mismatch",
  });
  const unexpectedBinding = compileWorkflowEffectManifest(
    input(
      { ...reportStep, max_retries: 0 },
      { transactional_delivery: transactional },
      "sensitive",
    ),
  );
  expect(unexpectedBinding.manifest.issues).toContainEqual({
    step_id: "send",
    code: "binding_mismatch",
  });
});

test("a delivery profile never exempts a runtime request unless its exact authority predicate holds", () => {
  const cases = [
    {
      step: { ...reportStep, max_retries: 1, transactional_delivery: transactional },
      binding: { transactional_delivery: transactional },
      issues: ["binding_mismatch", "dynamic_request"],
    },
    {
      step: {
        ...reportStep,
        max_retries: 1,
        outbox_delivery: {
          kind: "gmail_outbox" as const,
          source_step_id: "source",
          recipient_field: "email",
          item_id_field: "id",
          from: "sender@example.test",
          content_type: "text/plain" as const,
          max_body_bytes: 1024,
          max_per_day: 1,
        },
      },
      binding: {
        outbox_delivery: {
          kind: "gmail_outbox" as const,
          source_step_id: "source",
          recipient_field: "email",
          item_id_field: "id",
          from: "sender@example.test",
          content_type: "text/plain" as const,
          max_body_bytes: 1024,
          max_per_day: 1,
        },
      },
      issues: ["binding_mismatch", "binding_mismatch", "dynamic_request"],
    },
    {
      step: reportStep,
      binding: { report_delivery: report, target: "https://mail.example.test/send" },
      issues: ["binding_mismatch", "dynamic_request"],
    },
  ] as const;
  for (const { step, binding, issues } of cases) {
    const result = compileWorkflowEffectManifest(input(step, binding, "sensitive"));
    expect(result.manifest.issues.map((issue) => issue.code)).toEqual(Array.from(issues));
  }
});

test("delivery runtime exemptions require HTTP bindings and byte-identical delivery profiles", () => {
  const nonHttp = compileWorkflowEffectManifest(
    input({ ...reportStep }, { report_delivery: report, driver: "mcp" }, "sensitive"),
  );
  expect(nonHttp.manifest.issues.map((issue) => issue.code)).toEqual([
    "binding_mismatch",
    "dynamic_request",
  ]);

  const outbox = {
    kind: "gmail_outbox" as const,
    source_step_id: "source",
    recipient_field: "email",
    item_id_field: "id",
    from: "sender@example.test",
    content_type: "text/plain" as const,
    max_body_bytes: 1024,
    max_per_day: 1,
  };
  for (const [step, binding, issues] of [
    [
      { ...reportStep, max_retries: 0, transactional_delivery: transactional },
      { transactional_delivery: { ...transactional, max_body_bytes: 1025 } },
      ["binding_mismatch", "dynamic_request"],
    ],
    [
      { ...reportStep, max_retries: 0, outbox_delivery: outbox },
      { outbox_delivery: { ...outbox, max_per_day: 2 } },
      ["binding_mismatch", "binding_mismatch", "dynamic_request"],
    ],
  ] as const) {
    const result = compileWorkflowEffectManifest(input(step, binding, "sensitive"));
    expect(result.manifest.issues.map((issue) => issue.code)).toEqual(Array.from(issues));
  }
});

test("manifest effects and issues use a stable lexical order independent of authored order", () => {
  const definition = WorkflowDefSchema.parse({
    name: "Ordering",
    steps: [
      { id: "zeta", kind: "request", connector_id: connector, method: "POST", path: "/z" },
      { id: "alpha", kind: "request", connector_id: connector, method: "GET", path: "/a" },
      { id: "middle", kind: "request", connector_id: connector, method: "GET", path: "/m" },
    ],
  });
  const zeta = definition.steps[0]!;
  const middle = definition.steps[2]!;
  const resolved = (
    step: (typeof definition.steps)[number],
    target: string,
  ): ResolvedEffectBinding => ({
    tenant_id: tenant,
    step_id: step.id,
    connector_id: connector,
    driver: "http",
    environment: "dev",
    request_digest: workflowJsonDigest(step),
    target,
    configuration_digest: "a".repeat(64),
    credential_binding_digest: "b".repeat(64),
    rewrites_target: false,
  });
  const good = compileWorkflowEffectManifest({
    tenant_id: tenant,
    workflow_id: workflow,
    workflow_version_id: version,
    execution_environment: "dev",
    execution_options_digest: "c".repeat(64),
    definition,
    bindings: [
      resolved(middle, "https://example.test/m"),
      resolved(zeta, "https://example.test/z"),
    ],
  });
  expect(good.manifest.effects.map((effect) => effect.step_id)).toEqual(["middle", "zeta"]);
  expect(good.manifest.issues).toEqual([{ step_id: "alpha", code: "missing_binding" }]);

  const bad = compileWorkflowEffectManifest({
    tenant_id: tenant,
    workflow_id: workflow,
    workflow_version_id: version,
    execution_environment: "dev",
    execution_options_digest: "c".repeat(64),
    definition,
    bindings: [
      {
        ...resolved(zeta, "https://example.test/z"),
        request_digest: "0".repeat(64),
        rewrites_target: true,
      },
      resolved(middle, "https://example.test/m"),
    ],
  });
  expect(bad.manifest.issues).toEqual([
    { step_id: "alpha", code: "missing_binding" },
    { step_id: "zeta", code: "binding_mismatch" },
    { step_id: "zeta", code: "dynamic_request" },
  ]);
});

test("workflow calls require one literal non-empty target before a child can be trusted", () => {
  const callResult = (call: Record<string, unknown>) => {
    const definition = WorkflowDefSchema.parse({
      name: "Static calls only",
      steps: [{ id: "child", kind: "call", ...call }],
    });
    return compileWorkflowEffectManifest({
      tenant_id: tenant,
      workflow_id: workflow,
      workflow_version_id: version,
      execution_environment: "dev",
      execution_options_digest: "c".repeat(64),
      definition,
      bindings: [],
    });
  };
  for (const call of [
    {},
    { workflow_slug: "" },
    { workflow_slug: "${input.workflow}" },
    { workflow_id: workflow, workflow_slug: "also-named" },
  ]) {
    const result = callResult(call);
    expect(result.call_refusals).toEqual([{ step_id: "child", reason: "target_not_static" }]);
    expect(result.manifest.issues).toEqual([{ step_id: "child", code: "unbound_workflow_call" }]);
  }
  const literal = callResult({ workflow_slug: "reviewed-child" });
  expect(literal.call_refusals).toEqual([{ step_id: "child", reason: "child_unavailable" }]);
});

test("binding driver declarations bind the request protocol and preserve each protocol operation", () => {
  const cases = [
    {
      step: { method: "POST", graphql: { query: "query Viewer { viewer { login } }" } },
      driver: "graphql" as const,
      target: "https://api.example.test/graphql",
      operation: "query",
      effect: "read",
    },
    {
      step: { method: "SELECT", sql: { query: "SELECT id FROM accounts" } },
      driver: "postgres" as const,
      target: "postgres://reviewed",
      operation: "sql",
      effect: "unknown",
    },
    {
      step: { method: "GET", mcp: { operation: "read_resource", uri: "resource://reviewed" } },
      driver: "mcp" as const,
      target: "mcp://reviewed",
      operation: "read_resource",
      effect: "read",
    },
  ] as const;
  for (const { step, driver, target, operation, effect } of cases) {
    const candidate = input(step, { driver, target });
    const result = compileWorkflowEffectManifest(candidate);
    expect(result.manifest.effects[0]).toMatchObject({ driver, operation, effect });
    if (driver === "postgres")
      expect(result.manifest.issues).toContainEqual({ step_id: "send", code: "unknown_effect" });
    else expect(result.manifest.issues).toEqual([]);

    const wrongDriver = compileWorkflowEffectManifest({
      ...candidate,
      bindings: [{ ...candidate.bindings[0]!, driver: "http" }],
    });
    expect(wrongDriver.manifest.issues).toContainEqual({
      step_id: "send",
      code: "binding_mismatch",
    });
  }
});

test("all authority digests are exactly 64 lowercase hexadecimal characters", () => {
  const baseline = input(
    { method: "GET", path: "/reviewed" },
    { target: "https://example.test/reviewed" },
  );
  const malformed = [
    { execution_options_digest: `x${"c".repeat(64)}` },
    { execution_options_digest: `${"c".repeat(64)}x` },
    { bindings: [{ ...baseline.bindings[0]!, request_digest: `x${"a".repeat(64)}` }] },
    { bindings: [{ ...baseline.bindings[0]!, configuration_digest: `${"a".repeat(64)}x` }] },
    { bindings: [{ ...baseline.bindings[0]!, credential_binding_digest: `x${"b".repeat(64)}` }] },
  ];
  for (const patch of malformed)
    expect(() => compileWorkflowEffectManifest({ ...baseline, ...patch })).toThrow();
});

test("manifest input rejects unknown binding fields and empty call pins at its public boundary", () => {
  const baseline = input(
    { method: "GET", path: "/reviewed" },
    { target: "https://example.test/reviewed" },
  );
  expect(() =>
    compileWorkflowEffectManifest({
      ...baseline,
      bindings: [{ ...baseline.bindings[0]!, unreviewed: true }],
    }),
  ).toThrow();
  expect(() =>
    compileWorkflowEffectManifest({
      ...baseline,
      calls: [
        {
          step_id: "",
          workflow_id: workflow,
          workflow_slug: "reviewed",
          workflow_version_id: version,
          execution_options_digest: "a".repeat(64),
          definition: { name: "child", steps: [] },
          bindings: [],
        },
      ],
    }),
  ).toThrow();
});

test("lexical manifest ordering is deterministic for Unicode identifiers and binding permutations", () => {
  const definition = WorkflowDefSchema.parse({
    name: "Unicode order",
    steps: ["ä", "z", "a"].map((id) => ({
      id,
      kind: "request",
      connector_id: connector,
      method: "GET",
      path: `/${id}`,
    })),
  });
  const bindings = definition.steps.map((step) => ({
    tenant_id: tenant,
    step_id: step.id,
    connector_id: connector,
    driver: "http" as const,
    environment: "dev" as const,
    request_digest: workflowJsonDigest(step),
    target: `https://example.test/${step.id}`,
    configuration_digest: "a".repeat(64),
    credential_binding_digest: "b".repeat(64),
    rewrites_target: false,
  }));
  const compile = (orderedBindings: typeof bindings) =>
    compileWorkflowEffectManifest({
      tenant_id: tenant,
      workflow_id: workflow,
      workflow_version_id: version,
      execution_environment: "dev",
      execution_options_digest: "c".repeat(64),
      definition,
      bindings: orderedBindings,
    });
  const forward = compile(bindings);
  const reverse = compile([...bindings].reverse());
  expect(forward.manifest.effects.map((effect) => effect.step_id)).toEqual(["a", "z", "ä"]);
  expect(reverse).toEqual(forward);
});

test("the public manifest schema admits exactly its four reviewed effect states", () => {
  const compiled = compileWorkflowEffectManifest(
    input({ method: "GET", path: "/reviewed" }, { target: "https://example.test/reviewed" }),
  ).manifest;
  for (const effect of ["read", "write", "unknown", "destructive"]) {
    expect(
      WorkflowEffectManifestSchema.safeParse({
        ...compiled,
        effects: [{ ...compiled.effects[0]!, effect }],
      }).success,
    ).toBe(true);
  }
  expect(
    WorkflowEffectManifestSchema.safeParse({
      ...compiled,
      effects: [{ ...compiled.effects[0]!, effect: "approved" }],
    }).success,
  ).toBe(false);
});

test("MCP resources and prompts preserve their native operations, while GraphQL write overrides stay writes", () => {
  for (const [mcp, operation] of [
    [{ operation: "read_resource", uri: "resource://reviewed" }, "read_resource"],
    [{ operation: "get_prompt", prompt: "reviewed" }, "get_prompt"],
  ] as const) {
    const result = compileWorkflowEffectManifest(
      input({ method: "GET", mcp }, { driver: "mcp", target: "mcp://reviewed" }),
    );
    expect(result.manifest.effects[0]).toMatchObject({ operation, effect: "read" });
  }
  for (const driver of ["http", "graphql"] as const) {
    const result = compileWorkflowEffectManifest(
      input(
        {
          method: "POST",
          ...(driver === "http" ? { path: "/graphql" } : {}),
          side_effects: "write",
          graphql: { query: "query Viewer { viewer { login } }" },
        },
        { driver, target: "https://api.example.test/graphql" },
      ),
    );
    expect(result.manifest.effects[0]).toMatchObject({ operation: "query", effect: "write" });
  }
});

test("S3 driver classification preserves read, write, and destructive effects", () => {
  for (const [method, effect] of [
    ["GET", "read"],
    ["PUT", "write"],
    ["DELETE", "destructive"],
  ] as const) {
    const result = compileWorkflowEffectManifest(
      input(
        { method, s3: { key: "reviewed/object.json" } },
        { driver: "s3", target: "https://store.example.test/reviewed/object.json" },
      ),
    );
    expect(result.manifest.effects[0]).toMatchObject({ operation: method, effect });
  }
});

test("caller guards are pinned and distinguish guard-only from erasure policies", () => {
  for (const policy of [
    { execution_guards: { input_bytes: { text: 1024 } } },
    { caller_erasure: "on_success" as const },
    { execution_guards: { input_bytes: { text: 1024 } }, caller_erasure: "on_success" as const },
  ]) {
    const guarded = input({ method: "GET", path: "/reviewed" });
    guarded.definition = WorkflowDefSchema.parse({
      ...guarded.definition,
      product_id: "guarded-product",
      required_caller_kind: "user",
      execution_privacy: "sensitive",
      ...policy,
    });
    const result = compileWorkflowEffectManifest(guarded);
    expect(result.manifest.caller_guards).toEqual(policy);
    expect(result.digest).not.toBe(
      compileWorkflowEffectManifest(input({ method: "GET", path: "/reviewed" })).digest,
    );
  }
});

test("returned manifest does not retain mutable input bindings", () => {
  const candidate = input({ method: "GET", path: "/reviewed" });
  const result = compileWorkflowEffectManifest(candidate);
  candidate.bindings[0]!.target = "https://example.test/changed";
  expect(result.manifest.effects[0]?.target).toBe(GMAIL_SEND_TARGET);
  expect(workflowJsonDigest(result.manifest)).toBe(result.digest);
});
