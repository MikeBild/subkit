import { expect, test } from "bun:test";
import type { WorkflowEffectManifest } from "../effect-manifest.ts";
import { type ReadInheritanceEvidence, requestStepsOf } from "../read-inheritance.ts";
import { projectBoundaryGrowth } from "./authority-inheritance.ts";

type Effect = WorkflowEffectManifest["effects"][number];

const connector = "00000000-0000-4000-8000-000000000004";
const ids = {
  tenant: "00000000-0000-4000-8000-000000000001",
  workflow: "00000000-0000-4000-8000-000000000002",
  granted: "00000000-0000-4000-8000-000000000010",
  next: "00000000-0000-4000-8000-000000000011",
} as const;

function effect(step_id: string, overrides: Partial<Effect> = {}): Effect {
  return {
    tenant_id: ids.tenant,
    step_id,
    connector_id: connector,
    driver: "http",
    environment: "prod",
    request_digest: "d".repeat(64),
    target: "https://api.example.test/things",
    configuration_digest: "a".repeat(64),
    credential_binding_digest: "b".repeat(64),
    rewrites_target: false,
    operation: "GET",
    effect: "read",
    ...overrides,
  } as Effect;
}

function manifest(
  version: string,
  effects: Effect[],
  caller_guards?: unknown,
): WorkflowEffectManifest {
  return {
    schema_version: 1,
    tenant_id: ids.tenant,
    workflow_id: ids.workflow,
    workflow_version_id: version,
    workflow_digest: "e".repeat(64),
    execution_environment: "prod",
    execution_options_digest: "c".repeat(64),
    effects,
    issues: [],
    ...(caller_guards === undefined ? {} : { caller_guards }),
  } as WorkflowEffectManifest;
}

function growth(
  granted: Effect[],
  next: Effect[],
  options: { grantedGuards?: unknown; nextGuards?: unknown } = {},
) {
  return projectBoundaryGrowth(
    manifest(ids.granted, granted, options.grantedGuards),
    manifest(ids.next, next, options.nextGuards),
  );
}

function evidence(
  granted: Array<Record<string, unknown>>,
  next: Array<Record<string, unknown>>,
): ReadInheritanceEvidence {
  const toSteps = (steps: Array<Record<string, unknown>>) =>
    requestStepsOf({ name: "authority inheritance", steps });
  const before = toSteps(granted);
  const after = toSteps(next);
  if (!before || !after) throw new Error("test evidence did not parse");
  return { granted: before, next: after };
}

function request(id: string, timeout_ms: number, max_retries = 0): Record<string, unknown> {
  return {
    id,
    kind: "request",
    connector_id: connector,
    method: "GET",
    path: "/things",
    timeout_ms,
    max_retries,
  };
}

test("classifies connector, target, boundary, effect, and caller-guard growth exactly once", () => {
  const granted = [effect("same"), effect("write", { effect: "write" })];
  const next = [
    effect("new-connector", { connector_id: "00000000-0000-4000-8000-000000000099" }),
    effect("new-target", { target: "https://api.example.test/other" }),
    effect("changed-digest", { configuration_digest: "f".repeat(64) }),
    effect("wider", { effect: "destructive" }),
  ];
  const result = growth(granted, next, {
    grantedGuards: { allowed: ["run"] },
    nextGuards: { allowed: ["approve"] },
  });

  expect(result.growth).toEqual([
    {
      kind: "new_connector",
      connector_id: "00000000-0000-4000-8000-000000000099",
      target: "https://api.example.test/things",
      effect: "read",
    },
    {
      kind: "new_target",
      connector_id: connector,
      target: "https://api.example.test/other",
      effect: "read",
    },
    {
      kind: "changed_boundary",
      connector_id: connector,
      target: "https://api.example.test/things",
      effect: "read",
    },
    {
      kind: "wider_effect",
      connector_id: connector,
      target: "https://api.example.test/things",
      effect: "destructive",
    },
    {
      kind: "changed_boundary",
      connector_id: null,
      target: "execution_guards",
      effect: "write",
    },
  ]);
  expect(result.relaxed).toEqual(new Map());
});

test("covers effects by rank but requires exact unknown operations", () => {
  expect(growth([effect("g", { effect: "destructive" })], [effect("n")]).growth).toEqual([]);
  expect(
    growth(
      [effect("g", { effect: "unknown", operation: "GET" })],
      [effect("n", { effect: "unknown", operation: "POST" })],
    ).growth,
  ).toEqual([expect.objectContaining({ kind: "wider_effect", effect: "unknown" })]);
  expect(
    growth(
      [effect("g", { effect: "unknown", operation: "GET" })],
      [effect("n", { effect: "unknown", operation: "GET" })],
    ).growth,
  ).toEqual([]);
});

test("treats every protected sub-boundary and credential binding as a changed boundary", () => {
  const protectedKeys = [
    "transactional_delivery",
    "outbox_delivery",
    "report_delivery",
    "content_publication",
    "read_path",
    "storage",
    "boundary",
    "read_query",
  ] as const;
  for (const key of protectedKeys) {
    const changed = effect("next", { [key]: { changed: key } });
    expect(growth([effect("granted")], [changed]).growth).toEqual([
      expect.objectContaining({ kind: "changed_boundary" }),
    ]);
  }
  for (const changed of [
    effect("next", { credential_binding_digest: "f".repeat(64) }),
    effect("next", { rewrites_target: true }),
  ]) {
    expect(growth([effect("granted")], [changed]).growth).toEqual([
      expect.objectContaining({ kind: "changed_boundary" }),
    ]);
  }
});

test("projects read relaxations without mutating input and chooses the shortest matching relaxation", () => {
  const initial = new Map<string, readonly string[]>([["next", ["headers.accept"]]]);
  const before = structuredClone([...initial]);
  const granted = [effect("slow"), effect("exact")];
  const next = [effect("next")];
  const result = projectBoundaryGrowth(
    manifest(ids.granted, granted),
    manifest(ids.next, next),
    evidence([request("slow", 1_000), request("exact", 2_000)], [request("next", 2_000)]),
    initial,
  );

  expect(result.growth).toEqual([]);
  expect(result.relaxed).toEqual(new Map());
  expect([...initial]).toEqual(before);
});

test("deduplicates and sorts read relaxation keys while preserving readonly prior evidence", () => {
  const initial = new Map<string, readonly string[]>([["next", ["headers.accept", "timeout_ms"]]]);
  const result = projectBoundaryGrowth(
    manifest(ids.granted, [effect("granted")]),
    manifest(ids.next, [effect("next")]),
    evidence([request("granted", 1_000, 0)], [request("next", 2_000, 2)]),
    initial,
  );

  expect(result.growth).toEqual([]);
  expect(result.relaxed).toEqual(
    new Map([["next", ["headers.accept", "max_retries", "timeout_ms"]]]),
  );
  expect(initial.get("next")).toEqual(["headers.accept", "timeout_ms"]);
});

test("authority cannot cross driver or environment and anonymous targets retain their reason", () => {
  for (const overrides of [{ driver: "graphql" }, { environment: "dev" }] as const) {
    expect(growth([effect("granted")], [effect("next", overrides)]).growth).toEqual([
      expect.objectContaining({ kind: "new_connector" }),
    ]);
  }
  expect(growth([], [effect("next", { connector_id: null })]).growth).toEqual([
    expect.objectContaining({ kind: "new_target", connector_id: null }),
  ]);
});

test("relaxation selection keeps an exact earlier grant and the first equal-size explanation", () => {
  const compare = (grantedRequests: Array<Record<string, unknown>>) =>
    projectBoundaryGrowth(
      manifest(ids.granted, [effect("first"), effect("second")]),
      manifest(ids.next, [effect("next")]),
      evidence(grantedRequests, [request("next", 2000, 2)]),
    );
  expect(compare([request("first", 2000, 2), request("second", 1000, 2)]).relaxed).toEqual(
    new Map(),
  );
  expect(compare([request("first", 1000, 2), request("second", 2000, 0)]).relaxed).toEqual(
    new Map([["next", ["timeout_ms"]]]),
  );
});

test("a first relaxation starts with exactly its proven keys", () => {
  const result = projectBoundaryGrowth(
    manifest(ids.granted, [effect("granted")]),
    manifest(ids.next, [effect("next")]),
    evidence([request("granted", 1000)], [request("next", 2000)]),
  );
  expect(result.growth).toEqual([]);
  expect(result.relaxed).toEqual(new Map([["next", ["timeout_ms"]]]));
});

test("non-relaxable read changes remain a boundary change", () => {
  const result = projectBoundaryGrowth(
    manifest(ids.granted, [effect("granted")]),
    manifest(ids.next, [effect("next", { configuration_digest: "f".repeat(64) })]),
    evidence(
      [{ ...request("granted", 1000), headers: { "x-secret": "old" } }],
      [{ ...request("next", 1000), headers: { "x-secret": "new" } }],
    ),
  );
  expect(result.growth).toEqual([expect.objectContaining({ kind: "changed_boundary" })]);
});

test("identical configurations need no relaxed evidence", () => {
  expect(growth([effect("granted")], [effect("next")])).toEqual({ growth: [], relaxed: new Map() });
});

test("effect authority covers the complete lattice and unknown operations require an exact match", () => {
  const accepted = new Set([
    "read:read",
    "read:write",
    "read:destructive",
    "write:write",
    "write:destructive",
    "destructive:destructive",
  ]);
  for (const nextEffect of ["read", "write", "destructive", "unknown"] as const) {
    for (const grantedEffect of ["read", "write", "destructive", "unknown"] as const) {
      for (const operation of ["GET", "POST"]) {
        const expected =
          accepted.has(`${nextEffect}:${grantedEffect}`) ||
          (nextEffect === "unknown" && grantedEffect === "unknown" && operation === "GET");
        const result = growth(
          [effect("granted", { effect: grantedEffect, operation: "GET" })],
          [effect("next", { effect: nextEffect, operation })],
        );
        expect(result.growth).toEqual(
          expected ? [] : [expect.objectContaining({ kind: "wider_effect", effect: nextEffect })],
        );
      }
    }
  }
});

const TOOL_TARGET = "https://tools.example.test/mcp#search";
const toolBoundary = (over: Record<string, unknown> = {}) => ({
  server: "https://tools.example.test/mcp",
  tool: "search",
  effect: "read",
  variables: { "input.q": { enum: ["alpha"] } },
  arguments: [{ path: ["q"], var: "input.q" }],
  fixed_arguments_digest: "1".repeat(64),
  max_calls: 2,
  descriptor: {
    name: "search",
    annotations: { readOnlyHint: true },
    input_schema_digest: "2".repeat(64),
    digest: "3".repeat(64),
  },
  ...over,
});
const toolEffect = (step_id: string, over: Record<string, unknown> = {}, kind = "read") =>
  effect(step_id, {
    driver: "mcp",
    target: TOOL_TARGET,
    operation: "tools/call:search",
    effect: kind,
    mcp: toolBoundary(over),
  } as Partial<Effect>);

test("an identical tool boundary carries the approval forward", () => {
  expect(growth([toolEffect("granted")], [toolEffect("next")]).growth).toEqual([]);
});

test("every difference in a tool boundary is a changed boundary", () => {
  for (const changed of [
    { max_calls: 3 },
    { max_calls: 1 },
    { variables: { "input.q": { enum: ["alpha", "beta"] } } },
    { variables: { "input.q": { class: "identifier" } } },
    { fixed_arguments_digest: "9".repeat(64) },
    { arguments: [{ path: ["query"], var: "input.q" }] },
    {
      descriptor: {
        name: "search",
        annotations: { readOnlyHint: true },
        input_schema_digest: "8".repeat(64),
        digest: "7".repeat(64),
      },
    },
    {
      descriptor: {
        name: "search",
        annotations: {},
        input_schema_digest: "2".repeat(64),
        digest: "6".repeat(64),
      },
    },
  ])
    expect(growth([toolEffect("granted")], [toolEffect("next", changed)]).growth).toEqual([
      { kind: "changed_boundary", connector_id: connector, target: TOOL_TARGET, effect: "read" },
    ]);
});

test("a tool boundary that appears or disappears is a changed boundary", () => {
  const bare = effect("bare", {
    driver: "mcp",
    target: TOOL_TARGET,
    operation: "tools/call:search",
  } as Partial<Effect>);
  expect(growth([bare], [toolEffect("next")]).growth).toHaveLength(1);
  expect(growth([toolEffect("granted")], [bare]).growth).toHaveLength(1);
});

test("a tool call stated as a read gets no relaxed read inheritance", () => {
  const tool = (id: string, max_retries: number) => ({
    id,
    kind: "request",
    connector_id: connector,
    mcp: { operation: "call_tool", tool: "search", arguments: { q: "alpha" } },
    max_retries,
  });
  const result = projectBoundaryGrowth(
    manifest(ids.granted, [toolEffect("granted", { max_calls: 5 })]),
    manifest(ids.next, [toolEffect("next", { max_calls: 2 })]),
    evidence([tool("granted", 0)], [tool("next", 0)]),
  );
  expect(result.growth).toEqual([
    { kind: "changed_boundary", connector_id: connector, target: TOOL_TARGET, effect: "read" },
  ]);
  const same = projectBoundaryGrowth(
    manifest(ids.granted, [toolEffect("granted")]),
    manifest(ids.next, [toolEffect("next")]),
    evidence([tool("granted", 0)], [tool("next", 3)]),
  );
  expect(same.growth).toEqual([]);
  expect(same.relaxed.size).toBe(0);
});

test("a tool call stated as a write is not covered by one approved as a read", () => {
  expect(
    growth([toolEffect("granted")], [toolEffect("next", { effect: "write" }, "write")]).growth,
  ).toEqual([
    { kind: "changed_boundary", connector_id: connector, target: TOOL_TARGET, effect: "write" },
  ]);
});
