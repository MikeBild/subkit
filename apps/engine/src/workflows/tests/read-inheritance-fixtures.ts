import { boundaryGrowth } from "../authority-inheritance.ts";
import type { WorkflowEffectManifest } from "../effect-manifest.ts";
import { type ReadInheritanceEvidence, requestStepsOf } from "../read-inheritance.ts";

export type Effect = WorkflowEffectManifest["effects"][number];

export type Dag = { name: string; steps: Array<Record<string, unknown>> };

const tenant = "00000000-0000-4000-8000-000000000001";

const workflow = "00000000-0000-4000-8000-000000000002";

export const grantedVersion = "00000000-0000-4000-8000-000000000010";

export const nextVersion = "00000000-0000-4000-8000-000000000011";

export const connector = "00000000-0000-4000-8000-000000000004";

export const origin = "https://api.example.test";

export const ITEMS_QUERY =
  "query Items($after: String, $owner: String!, $number: Int!) { user(login: $owner) { projectV2(number: $number) { items(first: 50, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } } } }";

function briefingDag(): Dag {
  return {
    name: "Repository briefing",
    steps: [
      {
        id: "repo",
        kind: "request",
        connector_id: connector,
        method: "GET",
        path: "/repos/acme/app",
        headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
        timeout_ms: 10_000,
      },
      {
        id: "issues",
        kind: "request",
        connector_id: connector,
        method: "GET",
        path: "/repos/acme/app/issues",
        query: { state: "open", per_page: 50 },
        pagination: { strategy: "link", link_params: ["page"], max_pages: 5 },
        max_retries: 2,
      },
      {
        id: "labels",
        kind: "request",
        connector_id: connector,
        method: "GET",
        path: "/repos/acme/app/labels",
        query: { sort: "created", direction: "desc" },
      },
      {
        id: "pulls",
        kind: "request",
        connector_id: connector,
        method: "GET",
        path: "/repos/acme/app/pulls",
        boundary: { variables: {}, max_body_bytes: 0, max_calls: 10 },
      },
      {
        id: "items",
        kind: "request",
        connector_id: connector,
        method: "POST",
        graphql: {
          operation: "query",
          query: ITEMS_QUERY,
          variables: { after: null, owner: "acme", number: 4 },
          cursor_pagination: {
            connection_path: "user.projectV2.items",
            items_field: "nodes",
            cursor_variable: "after",
            max_pages: 40,
            max_items: 2000,
          },
        },
      },
    ],
  };
}

export function base(step_id: string, target: string, over: Partial<Effect> = {}): Effect {
  return {
    tenant_id: tenant,
    step_id,
    connector_id: connector,
    driver: "http",
    environment: "prod",
    request_digest: "d".repeat(64),
    target,
    configuration_digest: "a".repeat(64),
    credential_binding_digest: "b".repeat(64),
    rewrites_target: false,
    operation: "GET",
    effect: "read",
    ...over,
  } as Effect;
}

export function restBoundary(path: string, max_calls: number, max_requests?: number) {
  return {
    base_url: origin,
    method: "GET" as const,
    origin,
    segments: path.split("/"),
    variables: {},
    query: { fixed: {}, variable: [] },
    max_body_bytes: 0,
    max_calls,
    ...(max_requests ? { pagination: { params: ["page"], max_requests } } : {}),
  };
}

function briefingEffects(): Effect[] {
  return [
    base("repo", `${origin}/repos/acme/app`, {
      read_path: { origin, segments: ["", "repos", "acme", "app"], search: "" },
    }),
    base("issues", `${origin}/repos/acme/app/issues`, {
      read_query: { fixed: { state: "open", per_page: "50" }, variable: [] },
    }),
    base("labels", `${origin}/repos/acme/app/labels`),
    base("pulls", `${origin}/repos/acme/app/pulls`, {
      boundary: restBoundary("/repos/acme/app/pulls", 10),
    }),
    base("items", `${origin}/graphql`, { driver: "graphql", operation: "query" }),
  ];
}

export function manifest(version: string, effects: Effect[]): WorkflowEffectManifest {
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

export function stepOf(dag: Dag, id: string): Record<string, unknown> {
  const step = dag.steps.find((candidate) => candidate.id === id);
  if (!step) throw new Error(`fixture has no step ${id}`);
  return step;
}

export function effectOf(effects: Effect[], id: string): Effect {
  const effect = effects.find((candidate) => candidate.step_id === id);
  if (!effect) throw new Error(`fixture has no effect ${id}`);
  return effect;
}

export function judge(
  change: (dag: Dag, effects: Effect[]) => Effect[] | undefined,
  withEvidence = true,
  relaxed?: Map<string, string[]>,
) {
  const grantedDag = briefingDag();
  const nextDag = briefingDag();
  const grantedEffects = briefingEffects();
  const nextEffects = briefingEffects();
  const changed = change(nextDag, nextEffects) ?? nextEffects;
  const grantedSteps = requestStepsOf(grantedDag);
  const nextSteps = requestStepsOf(nextDag);
  if (!grantedSteps || !nextSteps) throw new Error("fixture definitions do not parse");
  const evidence: ReadInheritanceEvidence = { granted: grantedSteps, next: nextSteps };
  return boundaryGrowth(
    manifest(grantedVersion, grantedEffects),
    manifest(nextVersion, changed),
    withEvidence ? evidence : undefined,
    relaxed,
  );
}
