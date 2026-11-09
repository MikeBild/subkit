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
