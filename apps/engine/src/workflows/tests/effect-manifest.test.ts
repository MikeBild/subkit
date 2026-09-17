import { expect, test } from "bun:test";
import { workflowJsonDigest } from "../canonical-json.ts";
import { compileWorkflowEffectManifest, type ResolvedEffectBinding } from "../effect-manifest.ts";
import { readPathBoundary, readPathTarget } from "../read-path-boundary.ts";
import { storageBoundary, storageTarget } from "../storage-boundary.ts";
import { WorkflowDefSchema } from "../types.ts";

const tenant = "00000000-0000-4000-8000-000000000001";
const workflow = "00000000-0000-4000-8000-000000000002";
const version = "00000000-0000-4000-8000-000000000003";
const connector = "00000000-0000-4000-8000-000000000004";

function fixture(request: Record<string, unknown> = {}) {
  const definition = WorkflowDefSchema.parse(
    JSON.parse(
      JSON.stringify({
        name: "Bound request",
        steps: [
          {
            id: "send",
            kind: "request",
            connector_id: connector,
            method: "POST",
            path: "/messages",
            body: { recipient: "reviewed@example.test", text: "Hello" },
            ...request,
          },
        ],
      }),
    ),
  );
  const binding: ResolvedEffectBinding = {
    tenant_id: tenant,
    step_id: "send",
    connector_id: connector,
    driver: "http",
    environment: "dev",
    request_digest: workflowJsonDigest(definition.steps[0]),
    target: "https://example.test/messages",
    configuration_digest: "a".repeat(64),
    credential_binding_digest: "b".repeat(64),
    rewrites_target: false,
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

test("exact static request produces a deterministic version and environment bound manifest", () => {
  const input = fixture();
  const result = compileWorkflowEffectManifest(input);
  expect(result.eligible_for_repeated_runs).toBe(true);
  expect(result.manifest.effects[0]?.effect).toBe("write");
  expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(result).toEqual(compileWorkflowEffectManifest(JSON.parse(JSON.stringify(input))));
  const reversed = Object.fromEntries(Object.entries(input.definition).reverse());
  expect(compileWorkflowEffectManifest({ ...input, definition: reversed }).digest).toBe(
    result.digest,
  );
});

test("version, recipient, environment, configuration, credentials and execution options bind the digest", () => {
  const baseline = fixture();
  const digest = compileWorkflowEffectManifest(baseline).digest;
  for (const patch of [
    { workflow_version_id: "00000000-0000-4000-8000-000000000009" },
    { execution_options_digest: "d".repeat(64) },
    { execution_environment: "prod", bindings: [{ ...baseline.bindings[0], environment: "prod" }] },
    { bindings: [{ ...baseline.bindings[0], target: "https://example.test/another-recipient" }] },
    { bindings: [{ ...baseline.bindings[0], configuration_digest: "d".repeat(64) }] },
    { bindings: [{ ...baseline.bindings[0], credential_binding_digest: "d".repeat(64) }] },
  ])
    expect(compileWorkflowEffectManifest({ ...baseline, ...patch }).digest).not.toBe(digest);
  const changed = fixture({ body: { recipient: "someone-else@example.test", text: "Hello" } });
  expect(compileWorkflowEffectManifest(changed).digest).not.toBe(digest);
});

test("runtime recipients, paths, and target-rewriting hooks cannot receive repeated-run authority", () => {
  for (const request of [
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Workflow interpolation, not JavaScript.
    { path: "/messages/${input.target}" },
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Workflow interpolation, not JavaScript.
    { body: { recipient: "${input.recipient}" } },
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Workflow interpolation, not JavaScript.
    { headers: { "X-Tenant": "${input.tenant}" } },
  ]) {
    const result = compileWorkflowEffectManifest(fixture(request));
    expect(result.eligible_for_repeated_runs).toBe(false);
    expect(result.manifest.issues).toContainEqual({ step_id: "send", code: "dynamic_request" });
  }
  const input = fixture();
  input.bindings[0]!.rewrites_target = true;
  expect(compileWorkflowEffectManifest(input).eligible_for_repeated_runs).toBe(false);
});

test("missing, cross-environment, connector-mismatched and stale request bindings fail closed", () => {
  for (const bindings of [
    [],
    [{ ...fixture().bindings[0], environment: "prod" }],
    [{ ...fixture().bindings[0], tenant_id: "00000000-0000-4000-8000-000000000099" }],
    [{ ...fixture().bindings[0], connector_id: null }],
    [{ ...fixture().bindings[0], request_digest: "0".repeat(64) }],
    [{ ...fixture().bindings[0], driver: "graphql" }],
    [{ ...fixture().bindings[0], target: null }],
  ])
    expect(
      compileWorkflowEffectManifest({ ...fixture(), bindings }).eligible_for_repeated_runs,
    ).toBe(false);
});

test("duplicate or unrelated binding claims are rejected rather than ignored", () => {
  const input = fixture();
  expect(() =>
    compileWorkflowEffectManifest({ ...input, bindings: [...input.bindings, ...input.bindings] }),
  ).toThrow();
  expect(() =>
    compileWorkflowEffectManifest({
      ...input,
      bindings: [{ ...input.bindings[0], step_id: "other" }],
    }),
  ).toThrow();
});

test("SQL and MCP tool calls remain unknown even when their authors claim read", () => {
  for (const [driver, request] of [
    ["postgres", { method: "SELECT", sql: { query: "SELECT hidden_side_effect()" } }],
    [
      "mcp",
      {
        method: "GET",
        body: undefined,
        path: undefined,
        mcp: { operation: "call_tool", tool: "search" },
      },
    ],
  ] as const) {
    const input = fixture({ ...request, side_effects: "read" });
    input.bindings[0]!.driver = driver;
    const result = compileWorkflowEffectManifest(input);
    expect(result.eligible_for_repeated_runs).toBe(false);
    expect(result.manifest.effects[0]?.effect).toBe("unknown");
  }
});

test("a destructive request and invalid GraphQL document require concrete approval", () => {
  expect(
    compileWorkflowEffectManifest(fixture({ method: "DELETE" })).manifest.effects[0]?.effect,
  ).toBe("destructive");
  const input = fixture({ graphql: { query: "fragment F on Item { id }" } });
  input.bindings[0]!.driver = "graphql";
  const result = compileWorkflowEffectManifest(input);
  expect(result.eligible_for_repeated_runs).toBe(false);
  expect(result.manifest.effects[0]?.effect).toBe("unknown");
});

test("an author read label cannot make a POST manifest claim it has no write effect", () => {
  expect(
    compileWorkflowEffectManifest(fixture({ side_effects: "read" })).manifest.effects[0]?.effect,
  ).toBe("write");
});

test("a child workflow without an immutable child version never inherits authority", () => {
  const input = fixture();
  input.definition = WorkflowDefSchema.parse({
    name: "Call child",
    steps: [{ kind: "call", id: "child", workflow_id: workflow }],
  });
  input.bindings = [];
  const result = compileWorkflowEffectManifest(input);
  expect(result.eligible_for_repeated_runs).toBe(false);
  expect(result.manifest.issues).toEqual([{ step_id: "child", code: "unbound_workflow_call" }]);
});

test("returned manifest does not retain mutable input bindings", () => {
  const input = fixture();
  const result = compileWorkflowEffectManifest(input);
  input.bindings[0]!.target = "https://example.test/changed";
  expect(result.manifest.effects[0]?.target).toBe("https://example.test/messages");
  expect(workflowJsonDigest(result.manifest)).toBe(result.digest);
});

test("binding enumeration order is irrelevant but ordered workflow content is not", () => {
  const input = fixture();
  const first = input.definition.steps[0];
  if (!first) throw new Error("missing fixture request");
  input.definition.steps.push({ ...first, id: "second" });
  input.bindings.push({
    ...input.bindings[0]!,
    step_id: "second",
    request_digest: workflowJsonDigest(input.definition.steps[1]),
  });
  const baseline = compileWorkflowEffectManifest(input);
  expect(baseline.eligible_for_repeated_runs).toBe(true);
  input.bindings.reverse();
  expect(compileWorkflowEffectManifest(input)).toEqual(baseline);
  input.definition.steps.reverse();
  expect(compileWorkflowEffectManifest(input).digest).not.toBe(baseline.digest);
});

test("duplicate workflow step IDs cannot hide an effect behind another request", () => {
  const input = fixture();
  const first = input.definition.steps[0];
  if (!first) throw new Error("missing fixture request");
  input.definition.steps.push({ ...first });
  expect(() => compileWorkflowEffectManifest(input)).toThrow("unique workflow step IDs");
});

test("a locally sandboxed preparation-only version has no invented external effects", () => {
  const input = fixture();
  input.definition = WorkflowDefSchema.parse({
    name: "Prepare",
    steps: [{ kind: "transform", id: "prepare", expression: "return { draft: true };" }],
  });
  input.bindings = [];
  const result = compileWorkflowEffectManifest(input);
  expect(result.manifest.effects).toEqual([]);
  expect(result.manifest.issues).toEqual([]);
  expect(result.eligible_for_repeated_runs).toBe(true);
});

test("a reusable path authority must bind the exact reviewed identifier template", () => {
  const input = fixture({
    method: "GET",
    body: undefined,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow runtime template
    path: "/v2/projects/${item.id}/resources",
  });
  const step = input.definition.steps[0];
  if (step?.kind !== "request") throw new Error("request missing");
  const boundary = readPathBoundary(step, "https://example.test");
  if (!boundary) throw new Error("boundary missing");
  input.bindings[0]!.read_path = boundary;
  input.bindings[0]!.target = readPathTarget(boundary);
  const good = compileWorkflowEffectManifest(input);
  expect(good.eligible_for_repeated_runs).toBe(true);
  input.bindings[0]!.read_path = { ...boundary, segments: ["", "v2", null, null, "resources"] };
  expect(compileWorkflowEffectManifest(input).eligible_for_repeated_runs).toBe(false);
  input.bindings[0]!.read_path = boundary;
  input.bindings[0]!.rewrites_target = true;
  expect(compileWorkflowEffectManifest(input).eligible_for_repeated_runs).toBe(false);
});

test("S3 recurring authority requires an explicit folder profile bound to the authored limits", () => {
  const input = fixture({
    method: "PUT",
    path: undefined,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored runtime-expression fixture
    body: "${input.report}",
    s3: {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: authored runtime-expression fixture
      key: "${input.key}",
      content_type: "application/json",
      scope: { key_prefix: "reports/daily/", max_bytes: 1000 },
    },
  });
  const step = input.definition.steps[0];
  if (step?.kind !== "request") throw new Error("request missing");
  const storage = storageBoundary(step, "https://store.example.test/bucket/")!;
  input.bindings[0] = {
    ...input.bindings[0]!,
    driver: "s3",
    storage,
    target: storageTarget(storage),
  };
  const result = compileWorkflowEffectManifest(input);
  expect(result.eligible_for_repeated_runs).toBe(true);
  expect(result.manifest.effects[0]?.storage?.key_prefix).toBe("reports/daily/");
  for (const changed of [{ key_prefix: "private/" }, { max_bytes: 2000 }, { operation: "GET" }]) {
    const tampered = {
      ...input,
      bindings: [{ ...input.bindings[0], storage: { ...storage, ...changed } }],
    };
    expect(compileWorkflowEffectManifest(tampered).eligible_for_repeated_runs).toBe(false);
  }
  expect(
    compileWorkflowEffectManifest({
      ...input,
      bindings: [{ ...input.bindings[0], storage: undefined }],
    }).eligible_for_repeated_runs,
  ).toBe(false);
});
