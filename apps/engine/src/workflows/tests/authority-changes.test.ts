import { expect, test } from "bun:test";
import { effectChanges } from "../authority-changes.ts";
import { boundaryGrowth } from "../authority-inheritance.ts";
import type { WorkflowEffectManifest } from "../effect-manifest.ts";

type Effect = WorkflowEffectManifest["effects"][number];

const tenant = "00000000-0000-4000-8000-000000000001";
const workflow = "00000000-0000-4000-8000-000000000002";
const connector = "00000000-0000-4000-8000-000000000004";
const origin = "https://api.example.test";

function effect(
  step_id: string,
  path: string,
  options: {
    method?: "GET" | "POST" | "DELETE";
    effect?: Effect["effect"];
    max_calls?: number;
    max_requests?: number;
    variables?: Record<string, { class: "integer" }>;
  } = {},
): Effect {
  const method = options.method ?? "GET";
  const segments = path
    .split("/")
    .map((part) => (part.startsWith("{") ? { var: `input.${part.slice(1, -1)}` } : part));
  return {
    tenant_id: tenant,
    step_id,
    connector_id: connector,
    driver: "http",
    environment: "prod",
    request_digest: "d".repeat(64),
    target: `${origin}${path}`,
    configuration_digest: "a".repeat(64),
    credential_binding_digest: "b".repeat(64),
    rewrites_target: false,
    operation: method,
    effect: options.effect ?? (method === "GET" ? "read" : "write"),
    boundary: {
      base_url: origin,
      method,
      origin,
      segments,
      variables: options.variables ?? {},
      query: { fixed: {}, variable: [] },
      max_body_bytes: method === "GET" ? 0 : 65_536,
      max_calls: options.max_calls ?? 1,
      ...(options.max_requests
        ? { pagination: { params: ["page"], max_requests: options.max_requests } }
        : {}),
    },
  } as Effect;
}

function manifest(version: string, effects: Effect[]): WorkflowEffectManifest {
  return {
    schema_version: 1,
    tenant_id: tenant,
    workflow_id: workflow,
    workflow_version_id: version,
    workflow_digest: "e".repeat(64),
    execution_environment: "prod",
    execution_options_digest: "c".repeat(64),
    effects,
    issues: [],
  };
}

const base = manifest("00000000-0000-4000-8000-000000000010", [
  effect("repo", "/repos/acme/app"),
  effect("commits", "/repos/acme/app/commits", { max_calls: 1, max_requests: 10 }),
  effect("issues", "/repos/acme/app/issues"),
  effect("old", "/repos/acme/app/milestones"),
]);

const next = manifest("00000000-0000-4000-8000-000000000011", [
  effect("repo", "/repos/acme/app"),
  effect("commits", "/repos/acme/app/commits", { max_calls: 1, max_requests: 30 }),
  effect("issues", "/repos/acme/app/issues", { method: "POST" }),
  effect("comment", "/repos/acme/app/issues/{issue}/comments", {
    method: "POST",
    variables: { "input.issue": { class: "integer" } },
  }),
]);

test("classifies added, widened, read to write, unchanged and removed effects", () => {
  const changes = effectChanges(base, next);
  const by = Object.fromEntries(changes.map((entry) => [entry.step_id, entry]));
  expect(by.comment).toMatchObject({ change: "added", effect: "write", subject: "comments" });
  expect(by.comment?.previous).toBeUndefined();
  expect(by.commits).toMatchObject({
    change: "widened",
    effect: "read",
    subject: "commits",
    previous: { effect: "read", max_calls: 1, max_requests: 10 },
  });
  expect(by.issues).toMatchObject({
    change: "widened",
    effect: "write",
    previous: { effect: "read", max_calls: 1, max_requests: null },
  });
  expect(by.repo).toMatchObject({ change: "unchanged", effect: "read", subject: "app" });
  expect(by.old).toMatchObject({ change: "removed", effect: "read", subject: "milestones" });
});

test("orders changes by risk, then step id, independent of manifest order", () => {
  const order = effectChanges(base, next).map((entry) => entry.step_id);
  expect(order).toEqual(["comment", "issues", "commits", "old", "repo"]);
  const shuffled = manifest(next.workflow_version_id, [...next.effects].reverse());
  expect(effectChanges(base, shuffled)).toEqual(effectChanges(base, next));
});

test("an effect the growth check reports is never unchanged", () => {
  const variants: Array<[WorkflowEffectManifest, WorkflowEffectManifest]> = [
    [base, next],
    [next, base],
    [base, base],
    [manifest(base.workflow_version_id, []), next],
    [
      base,
      manifest(next.workflow_version_id, [
        effect("repo", "/repos/acme/other"),
        effect("commits", "/repos/acme/app/commits", { max_calls: 2, max_requests: 10 }),
        effect("issues", "/repos/acme/app/issues", { method: "DELETE", effect: "destructive" }),
      ]),
    ],
  ];
  for (const [from, to] of variants) {
    const unchanged = new Set(
      effectChanges(from, to)
        .filter((entry) => entry.change === "unchanged")
        .map((entry) => entry.step_id),
    );
    for (const candidate of to.effects) {
      const grows = boundaryGrowth(from, manifest(to.workflow_version_id, [candidate])).length > 0;
      if (grows) expect(unchanged.has(candidate.step_id)).toBe(false);
    }
  }
});

test("identical manifests report every effect unchanged", () => {
  const changes = effectChanges(base, base);
  expect(changes.every((entry) => entry.change === "unchanged")).toBe(true);
  expect(changes).toHaveLength(base.effects.length);
});

test("a new model step leaves every request effect as it was", () => {
  const withModel: WorkflowEffectManifest = {
    ...base,
    model_calls: [
      {
        step_id: "summarize",
        flow: "workflow_step",
        effect: "read",
        max_output_tokens: 1024,
        repeated: false,
        data_paths: [],
      },
    ],
  };
  const changes = effectChanges(base, withModel);
  expect(changes.filter((entry) => !entry.model_call).map((entry) => entry.change)).toEqual([
    "unchanged",
    "unchanged",
    "unchanged",
    "unchanged",
  ]);
  expect(changes.filter((entry) => entry.model_call).map((entry) => entry.change)).toEqual([
    "added",
  ]);
});
