import { expect, test } from "bun:test";
import { workflowJsonDigest } from "../canonical-json.ts";
import {
  compileWorkflowEffectManifest,
  type ResolvedEffectBinding,
} from "../core/effect-manifest.ts";
import { requestDigest } from "../core/request-protocol.ts";
import { readPathBoundary, readPathTarget } from "../read-path-boundary.ts";
import { requestBoundary, requestBoundaryTarget } from "../request-boundary.ts";
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
    request_digest: requestDigest(definition.steps[0]),
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

test("environment rejection retains its specific public issue code", () => {
  const input = fixture();
  expect(compileWorkflowEffectManifest(input).manifest.issues).toEqual([]);
  input.bindings[0]!.environment = "prod";
  expect(compileWorkflowEffectManifest(input).manifest.issues).toEqual([
    { step_id: "send", code: "environment_mismatch" },
  ]);
});

for (const kind of ["storage", "read_path", "boundary"] as const) {
  test(`${kind} rejects a target changed independently of the reviewed profile`, () => {
    const input = fixture(
      kind === "storage"
        ? {
            protocol: "s3",
            method: "PUT",
            path: undefined,
            body: "report",
            s3: {
              key: "reports/daily/report.json",
              scope: { key_prefix: "reports/daily/", max_bytes: 1000 },
            },
          }
        : kind === "read_path"
          ? {
              method: "GET",
              body: undefined,
              path: "/v2/projects/${item.id}/resources",
            }
          : {
              path: "/sites/${input.site}/releases",
              boundary: {
                variables: { "input.site": { enum: ["company-cockpit"] } },
                max_body_bytes: 5000,
                max_calls: 1,
              },
            },
    );
    const step = input.definition.steps[0];
    if (step?.kind !== "request") throw new Error("missing request");
    const binding = input.bindings[0]!;
    if (kind === "storage") {
      const profile = storageBoundary(step, "https://store.example.test/bucket/");
      if (!profile) throw new Error("missing storage profile");
      Object.assign(binding, { driver: "s3", storage: profile, target: storageTarget(profile) });
    } else if (kind === "read_path") {
      const profile = readPathBoundary(step, "https://example.test");
      if (!profile) throw new Error("missing read path profile");
      Object.assign(binding, { read_path: profile, target: readPathTarget(profile) });
    } else {
      const profile = requestBoundary(step, "https://example.test");
      if (!profile) throw new Error("missing request profile");
      Object.assign(binding, { boundary: profile, target: requestBoundaryTarget(profile) });
    }
    expect(compileWorkflowEffectManifest(input).manifest.issues).toEqual([]);
    const reviewedTarget = binding.target;
    binding.target = "https://other.example.test/unreviewed";
    expect(compileWorkflowEffectManifest(input).manifest.issues).toEqual([
      { step_id: "send", code: "binding_mismatch" },
      ...(kind === "storage" ? [] : [{ step_id: "send", code: "dynamic_request" as const }]),
    ]);
    binding.target = reviewedTarget;
    binding.driver = kind === "storage" ? "http" : "postgres";
    expect(
      compileWorkflowEffectManifest(input).manifest.issues.filter(
        (issue) => issue.code === "binding_mismatch",
      ),
    ).toEqual([
      { step_id: "send", code: "binding_mismatch" },
      { step_id: "send", code: "binding_mismatch" },
    ]);
  });
}

test("content publication rejects a target outside its approved item profile", () => {
  const origin = "https://content.example.test";
  const input = fixture({
    method: "PUT",
    path: "/v1/content/${item.item_id}/revisions",
    body: "${item.markdown}",
    headers: { "Content-Type": "text/markdown" },
  });
  const binding = input.bindings[0]!;
  binding.content_publication = {
    kind: "content_revision",
    origin,
    item_ids: ["00000000-0000-4000-8000-000000000007"],
    max_bytes: 1024,
  };
  binding.target = `${origin}/v1/content/{approved-item}/revisions`;
  expect(compileWorkflowEffectManifest(input).manifest.issues).toEqual([]);
  binding.target = `${origin}/v1/content/unapproved/revisions`;
  expect(compileWorkflowEffectManifest(input).manifest.issues).toEqual([
    { step_id: "send", code: "binding_mismatch" },
    { step_id: "send", code: "dynamic_request" },
  ]);
  binding.target = `${origin}/v1/content/{approved-item}/revisions`;
  binding.driver = "postgres";
  expect(
    compileWorkflowEffectManifest(input).manifest.issues.filter(
      (issue) => issue.code === "binding_mismatch",
    ),
  ).toHaveLength(2);
});

test("content releases require the exact reviewed revision producer", () => {
  const origin = "https://content.example.test";
  const item = "00000000-0000-4000-8000-000000000007";
  const site = "00000000-0000-4000-8000-000000000008";
  const input = fixture({
    method: "PUT",
    path: `/v1/content/${item}/revisions`,
    body: "reviewed markdown",
    headers: { "Content-Type": "text/markdown" },
  });
  const producer = input.bindings[0]!;
  producer.content_publication = {
    kind: "content_revision",
    origin,
    item_ids: [item],
    max_bytes: 1024,
  };
  producer.target = `${origin}/v1/content/{approved-item}/revisions`;
  input.definition = WorkflowDefSchema.parse({
    ...input.definition,
    steps: [
      ...input.definition.steps,
      {
        id: "release",
        kind: "request",
        connector_id: connector,
        method: "POST",
        path: `/v1/sites/${site}/releases`,
        headers: { "Content-Type": "application/json" },
        body: { revision_ids: "${scope.send.data.revision_ids}" },
      },
    ],
  });
  const release: ResolvedEffectBinding = {
    ...producer,
    step_id: "release",
    request_digest: requestDigest(input.definition.steps[1]),
    target: `${origin}/v1/sites/${site}/releases`,
    content_publication: {
      kind: "content_release",
      origin,
      site_id: site,
      reason: null,
      sources: [{ step_id: "send", item_ids: [item] }],
    },
  };
  input.bindings.push(release);
  expect(compileWorkflowEffectManifest(input).manifest.issues).toEqual([]);
  const invalidProducers: Array<ResolvedEffectBinding | undefined> = [
    undefined,
    { ...producer, content_publication: undefined },
    { ...producer, connector_id: site },
    {
      ...producer,
      content_publication: {
        kind: "content_revision",
        origin: "https://other.example.test",
        item_ids: [item],
        max_bytes: 1024,
      },
    },
    {
      ...producer,
      content_publication: { kind: "content_revision", origin, item_ids: [site], max_bytes: 1024 },
    },
  ];
  for (const invalidProducer of invalidProducers) {
    const result = compileWorkflowEffectManifest({
      ...input,
      bindings: invalidProducer ? [invalidProducer, release] : [release],
    });
    expect(result.manifest.issues.filter((issue) => issue.step_id === "release")).toEqual([
      { step_id: "release", code: "binding_mismatch" },
    ]);
  }
});

test("runtime query exemptions require an HTTP request without GraphQL", () => {
  const input = fixture({
    method: "GET",
    body: undefined,
    path: "/reports",
    query: { since: "${input.since}" },
  });
  const baseline = compileWorkflowEffectManifest(input);
  expect(baseline.manifest.issues).toEqual([]);
  expect(baseline.manifest.effects[0]?.read_query).toBeDefined();
  const foreignDriver = compileWorkflowEffectManifest({
    ...input,
    bindings: [{ ...input.bindings[0]!, driver: "postgres" }],
  });
  expect(foreignDriver.manifest.effects[0]?.read_query).toBeUndefined();
  expect(foreignDriver.manifest.issues.map((issue) => issue.code)).toEqual([
    "binding_mismatch",
    "dynamic_request",
    "unknown_effect",
  ]);
  input.definition = WorkflowDefSchema.parse({
    ...input.definition,
    steps: [
      {
        ...input.definition.steps[0]!,
        protocol: "graphql",
        graphql: { operation: "query", query: "query { viewer { id } }" },
      },
    ],
  });
  input.bindings[0]!.request_digest = requestDigest(input.definition.steps[0]);
  const graphql = compileWorkflowEffectManifest(input);
  expect(graphql.manifest.effects[0]?.read_query).toBeUndefined();
  expect(graphql.manifest.issues.map((issue) => issue.code)).toContain("dynamic_request");
});

test("observed storage keys do not constrain an HTTP request without a storage profile", () => {
  const input = fixture();
  const expected = compileWorkflowEffectManifest(input);
  expect(expected.manifest.issues).toEqual([]);
  expect(
    compileWorkflowEffectManifest({
      ...input,
      observed_keys: [{ step_id: "send", key: "outside/unrelated" }],
    }),
  ).toEqual(expected);
});

test("SQL declarations require a PostgreSQL binding even with a GraphQL-shaped path", () => {
  for (const path of [undefined, "/graphql"]) {
    const input = fixture({
      protocol: "sql",
      method: "SELECT",
      path,
      body: undefined,
      sql: { query: "SELECT 1" },
    });
    input.bindings[0]!.driver = "postgres";
    expect(compileWorkflowEffectManifest(input).manifest.issues).toEqual([
      { step_id: "send", code: "unknown_effect" },
    ]);
    input.bindings[0]!.driver = "http";
    expect(compileWorkflowEffectManifest(input).manifest.issues).toEqual([
      { step_id: "send", code: "binding_mismatch" },
    ]);
  }
});
