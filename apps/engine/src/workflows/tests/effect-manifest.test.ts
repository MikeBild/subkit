import { expect, test } from "bun:test";
import { workflowJsonDigest } from "../canonical-json.ts";
import {
  compileWorkflowEffectManifest,
  type ResolvedEffectBinding,
} from "../core/effect-manifest.ts";
import { readPathBoundary, readPathTarget } from "../read-path-boundary.ts";
import { requestBoundary, requestBoundaryTarget } from "../request-boundary.ts";
import { storageBoundary, storageTarget } from "../storage-boundary.ts";
import { WorkflowDefSchema } from "../types.ts";
import {
  graphqlDriverProjectItems,
  httpProjectItems,
  plainHttpGet,
} from "./fixtures/graphql-path-manifest.ts";

test("graphql-driver and plain REST manifests keep their pinned digests", () => {
  expect(compileWorkflowEffectManifest(graphqlDriverProjectItems()).digest).toBe(
    "16c311371b7ee485ed41b64e45c53f238d06e6cfb2e12d6251876b76402a1e8c",
  );
  expect(compileWorkflowEffectManifest(plainHttpGet()).digest).toBe(
    "d862250287598b7e4235234d3c875ac19c211db56dbbc83d9132604fff03821b",
  );
});
test("a graphql query on an http connector through path /graphql is an eligible read", () => {
  const result = compileWorkflowEffectManifest(httpProjectItems());
  expect(result.manifest.issues).toEqual([]);
  expect(result.eligible_for_repeated_runs).toBe(true);
  expect(result.manifest.effects[0]).toMatchObject({
    driver: "http",
    operation: "query",
    effect: "read",
    target: "https://api.github.com/graphql",
  });
});
test("a graphql mutation on an http connector is reviewed as a write", () => {
  const result = compileWorkflowEffectManifest(
    httpProjectItems({
      side_effects: undefined,
      graphql: {
        query:
          "mutation Close($id: ID!) { closeIssue(input: { issueId: $id }) { clientMutationId } }",
      },
    }),
  );
  expect(result.manifest.effects[0]).toMatchObject({ operation: "mutation", effect: "write" });
});

test("an unparseable graphql document on an http connector is unknown", () => {
  const result = compileWorkflowEffectManifest(
    httpProjectItems({ graphql: { query: "query Broken { viewer { login }" } }),
  );
  expect(result.manifest.effects[0]?.effect).toBe("unknown");
  expect(result.manifest.issues.map((issue) => issue.code)).toContain("unknown_effect");
});

test.each([
  ["without path", { path: undefined }],
  ["with a foreign path", { path: "//evil.example/graphql" }],
  ["with a step url", { url: "https://evil.example/graphql" }],
  ["with a non-graphql path", { path: "/admin/purge" }],
  ["with a dispatch path", { path: "/repos/o/r/dispatches" }],
])("a graphql block on an http connector %s is not eligible", (_label, step) => {
  const result = compileWorkflowEffectManifest(httpProjectItems(step));
  expect(result.eligible_for_repeated_runs).toBe(false);
  expect(result.manifest.issues.map((issue) => issue.code)).toContain("binding_mismatch");
});

test("a tampered graphql-on-http binding is still a mismatch", () => {
  const driver = httpProjectItems();
  driver.bindings = driver.bindings.map((binding) => ({ ...binding, driver: "s3" as const }));
  expect(
    compileWorkflowEffectManifest(driver).manifest.issues.map((issue) => issue.code),
  ).toContain("binding_mismatch");
  const digest = httpProjectItems();
  digest.bindings = digest.bindings.map((binding) => ({
    ...binding,
    request_digest: "d".repeat(64),
  }));
  expect(
    compileWorkflowEffectManifest(digest).manifest.issues.map((issue) => issue.code),
  ).toContain("binding_mismatch");
});

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

test("manifest parsing rejects malformed digests, empty identifiers, and oversized bindings", () => {
  const input = fixture();
  expect(() =>
    compileWorkflowEffectManifest({ ...input, execution_options_digest: "not-a-digest" }),
  ).toThrow();
  expect(() =>
    compileWorkflowEffectManifest({ ...input, bindings: [{ ...input.bindings[0]!, step_id: "" }] }),
  ).toThrow();
  expect(() =>
    compileWorkflowEffectManifest({
      ...input,
      bindings: Array.from({ length: 201 }, () => input.bindings[0]!),
    }),
  ).toThrow();
});

test("manifest parsing preserves every strict binding and call boundary", () => {
  const input = fixture();
  expect(() => compileWorkflowEffectManifest({ ...input, extra: true })).toThrow();
  expect(() =>
    compileWorkflowEffectManifest({ ...input, bindings: [{ ...input.bindings[0]!, target: "" }] }),
  ).toThrow();
  expect(() =>
    compileWorkflowEffectManifest({
      ...input,
      bindings: [{ ...input.bindings[0]!, request_digest: "A".repeat(64) }],
    }),
  ).toThrow();
  expect(() =>
    compileWorkflowEffectManifest({
      ...input,
      bindings: [{ ...input.bindings[0]!, driver: "other" }],
    }),
  ).toThrow();
  expect(() =>
    compileWorkflowEffectManifest({
      ...input,
      calls: Array.from({ length: 51 }, () => ({
        step_id: "call",
        workflow_id: workflow,
        workflow_version_id: version,
        workflow_digest: "a".repeat(64),
        execution_options_digest: "b".repeat(64),
      })),
    }),
  ).toThrow();
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
    { path: "/messages/${input.target}" },
    { body: { recipient: "${input.recipient}" } },
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

test("only request steps may receive one binding, with an explicit duplicate-claim error", () => {
  const input = fixture();
  input.definition = WorkflowDefSchema.parse({
    ...input.definition,
    steps: [
      ...input.definition.steps,
      { id: "prepare", kind: "transform", expression: "return { reviewed: true };" },
    ],
  });
  expect(() =>
    compileWorkflowEffectManifest({
      ...input,
      bindings: [{ ...input.bindings[0]!, step_id: "prepare" }],
    }),
  ).toThrow("effect bindings must identify each request step at most once");
  expect(() =>
    compileWorkflowEffectManifest({
      ...input,
      bindings: [...input.bindings, ...input.bindings],
    }),
  ).toThrow("effect bindings must identify each request step at most once");
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

test("a read-labelled GraphQL query over plain HTTP keeps its write manifest and digest", () => {
  const result = compileWorkflowEffectManifest(
    fixture({
      path: "/graphql",
      side_effects: "read",
      body: {
        query:
          "query RadarRepositories($query:String!,$first:Int!){search(query:$query,type:REPOSITORY,first:$first){repositoryCount}}",
        variables: { first: 50, query: "oss" },
      },
    }),
  );
  expect(result.manifest.effects[0]?.effect).toBe("write");
  expect(result.manifest.effects[0]?.operation).toBe("POST");
  expect(result.digest).toBe("0c461ccc188be8aadf02398f2f795a745cd6bca2fe79e786b67bbb8a05676b7d");
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
    body: "${input.report}",
    s3: {
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
  const within = compileWorkflowEffectManifest({
    ...input,
    observed_keys: [{ step_id: "send", key: "reports/daily/today.json" }],
  });
  expect(within.eligible_for_repeated_runs).toBe(true);
  const outside = compileWorkflowEffectManifest({
    ...input,
    observed_keys: [{ step_id: "send", key: "private/secret.json" }],
  });
  expect(outside.manifest.issues).toContainEqual({
    step_id: "send",
    code: "boundary_contradicted_by_history",
  });
  expect(outside.eligible_for_repeated_runs).toBe(false);

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

test("a removal becomes grantable only with a declared ceiling, and stays visibly destructive", () => {
  const input = fixture({
    method: "DELETE",
    path: undefined,
    body: undefined,
    s3: {
      key: "${item.key}",
      scope: { key_prefix: "reports/daily/", max_bytes: 10, max_deletes: 500 },
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
  expect(result.manifest.issues).toEqual([]);
  expect(result.eligible_for_repeated_runs).toBe(true);
  expect(result.manifest.effects[0]?.effect).toBe("destructive");
  expect(result.manifest.effects[0]?.storage?.max_deletes).toBe(500);
  const { max_deletes: _ceiling, ...noCeiling } = storage;
  expect(() =>
    compileWorkflowEffectManifest({
      ...input,
      bindings: [{ ...input.bindings[0], storage: noCeiling }],
    }),
  ).toThrow("max_deletes");
  expect(
    compileWorkflowEffectManifest({
      ...input,
      bindings: [{ ...input.bindings[0], storage: { ...storage, max_deletes: 1 } }],
    }).eligible_for_repeated_runs,
  ).toBe(false);
});

function boundaryFixture(request: Record<string, unknown> = {}) {
  const input = fixture({
    method: "POST",
    path: "/sites/${input.site}/releases",
    body: { ids: "${scope.pick.data.ids}" },
    boundary: {
      variables: { "input.site": { enum: ["company-cockpit"] } },
      max_body_bytes: 5000,
      max_calls: 1,
    },
    ...request,
  });
  const step = input.definition.steps[0];
  if (step?.kind !== "request") throw new Error("request missing");
  const boundary = requestBoundary(step, "https://api.example.test/v2");
  if (boundary)
    input.bindings[0] = {
      ...input.bindings[0]!,
      boundary,
      target: requestBoundaryTarget(boundary),
    };
  return { input, boundary };
}

test("an authored request boundary makes a runtime path and body grantable", () => {
  const { input, boundary } = boundaryFixture();
  expect(boundary).not.toBeNull();
  const result = compileWorkflowEffectManifest(input);
  expect(result.manifest.issues).toEqual([]);
  expect(result.eligible_for_repeated_runs).toBe(true);
  expect(result.manifest.effects[0]?.target).toBe(
    "https://api.example.test/v2/sites/{input.site}/releases",
  );
  expect(result.manifest.effects[0]?.boundary?.max_body_bytes).toBe(5000);
});

test("a stored boundary that no longer reproduces from the step is a mismatch", () => {
  const { input, boundary } = boundaryFixture();
  for (const changed of [
    { max_body_bytes: 9_000_000 },
    { variables: { "input.site": { enum: ["company-cockpit", "another-site"] } } },
    { origin: "https://evil.example.test" },
  ]) {
    const tampered = compileWorkflowEffectManifest({
      ...input,
      bindings: [{ ...input.bindings[0], boundary: { ...boundary, ...changed } }],
    });
    expect(tampered.manifest.issues.map((issue) => issue.code)).toContain("binding_mismatch");
    expect(tampered.eligible_for_repeated_runs).toBe(false);
  }
});

test("a refused boundary does not fall back to an unchecked read-query exemption", () => {
  const input = fixture({
    method: "GET",
    path: "/reports",
    body: undefined,
    query: { since: "${input.since}" },
    boundary: { variables: {}, max_body_bytes: 0, max_calls: 1 },
  });
  const result = compileWorkflowEffectManifest(input);
  expect(result.manifest.issues.map((issue) => issue.code)).toContain("dynamic_request");
  expect(result.manifest.effects[0]?.read_query).toBeUndefined();
  expect(result.eligible_for_repeated_runs).toBe(false);
});

test("an HTTP removal is grantable only when its author declared it destructive", () => {
  const declared = boundaryFixture({
    method: "DELETE",
    body: undefined,
    boundary: {
      variables: { "input.site": { enum: ["company-cockpit"] } },
      max_body_bytes: 0,
      max_calls: 1,
      destructive: true,
    },
  });
  const result = compileWorkflowEffectManifest(declared.input);
  expect(result.manifest.issues).toEqual([]);
  expect(result.manifest.effects[0]?.effect).toBe("destructive");
  const undeclared = boundaryFixture({
    method: "DELETE",
    body: undefined,
    boundary: {
      variables: { "input.site": { enum: ["company-cockpit"] } },
      max_body_bytes: 0,
      max_calls: 1,
    },
  });
  expect(undeclared.boundary).toBeNull();
  expect(
    compileWorkflowEffectManifest(undeclared.input).manifest.issues.map((issue) => issue.code),
  ).toEqual(expect.arrayContaining(["destructive_effect", "dynamic_request"]));
});
