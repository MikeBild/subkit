import { expect, test } from "bun:test";
import { workflowJsonDigest } from "../canonical-json.ts";
import { compileWorkflowEffectManifest, type ResolvedEffectBinding } from "../effect-manifest.ts";
import { WorkflowDefSchema } from "../types.ts";

const tenant = "00000000-0000-4000-8000-000000000001";
const workflow = "00000000-0000-4000-8000-000000000002";
const version = "00000000-0000-4000-8000-000000000003";
const connector = "00000000-0000-4000-8000-000000000004";
const origin = "https://api.example.test";
const headers = { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };

const readStep = (id: string, path: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "request",
  connector_id: connector,
  method: "GET",
  path,
  headers,
  on_error: "continue",
  max_retries: 2,
  retry_backoff_ms: 500,
  error_policy: "none",
  expected_statuses: [200],
  ...extra,
});

function compiled(steps: Record<string, unknown>[], privacy?: "sensitive") {
  const definition = WorkflowDefSchema.parse(
    JSON.parse(
      JSON.stringify({
        name: "Repository briefing",
        timeout_ms: 120_000,
        ...(privacy ? { execution_privacy: privacy } : {}),
        steps,
      }),
    ),
  );
  const bindings: ResolvedEffectBinding[] = definition.steps
    .filter((step) => step.kind === "request")
    .map((step) => ({
      tenant_id: tenant,
      step_id: step.id,
      connector_id: connector,
      driver: "http",
      environment: "prod",
      request_digest: workflowJsonDigest(step),
      target: `${origin}${(step as { path: string }).path}`,
      configuration_digest: "a".repeat(64),
      credential_binding_digest: "b".repeat(64),
      rewrites_target: false,
    }));
  return compileWorkflowEffectManifest({
    tenant_id: tenant,
    workflow_id: workflow,
    workflow_version_id: version,
    execution_environment: "prod",
    execution_options_digest: "c".repeat(64),
    definition,
    bindings,
  });
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: authored workflow placeholder
const since = "${scope.windows.data.since}";

const briefingSteps = [
  {
    id: "windows",
    kind: "transform",
    language: "javascript",
    expression: "return { since: '2026-01-01T00:00:00.000Z' };",
  },
  readStep("repo", "/repos/acme/app"),
  readStep("main_ref", "/repos/acme/app/git/ref/heads/main"),
  readStep("commits_page_1", "/repos/acme/app/commits", {
    query: { sha: "main", since, per_page: 100, page: 1 },
  }),
  readStep("issues_page_1", "/repos/acme/app/issues", {
    query: { state: "all", since, per_page: 100, page: 1, sort: "updated", direction: "desc" },
  }),
  readStep("runs", "/repos/acme/app/actions/runs", {
    query: { branch: "main", per_page: 100 },
    data_selector: "workflow_runs",
  }),
  {
    id: "briefing",
    kind: "transform",
    language: "javascript",
    expression: "return { repository: input.scope.repo.data.full_name };",
  },
];

test("an approved sensitive REST briefing keeps its pinned effect-manifest digest", () => {
  const result = compiled(briefingSteps, "sensitive");
  expect(result.eligible_for_repeated_runs).toBe(true);
  expect(
    result.manifest.effects.map((effect) => [effect.step_id, effect.operation, effect.effect]),
  ).toEqual([
    ["commits_page_1", "GET", "read"],
    ["issues_page_1", "GET", "read"],
    ["main_ref", "GET", "read"],
    ["repo", "GET", "read"],
    ["runs", "GET", "read"],
  ]);
  expect(
    result.manifest.effects.filter((effect) => effect.read_query).map((effect) => effect.step_id),
  ).toEqual(["commits_page_1", "issues_page_1"]);
  expect(result.digest).toBe("4d366304c0a7a7db66eeb41a05946cdf104c724037c68ab54ad70d86099511cf");
});

test("a plain REST GET without pagination keeps its pinned digest", () => {
  expect(
    compiled([readStep("milestones", "/repos/acme/app/milestones", { query: { state: "all" } })])
      .digest,
  ).toBe("f71d413e54faa0ef417c530daa795a81de318ba5042e77580c990827be59c916");
});

test("a REST GET with page pagination keeps its pinned digest", () => {
  const result = compiled([
    readStep("issues", "/repos/acme/app/issues", {
      query: { state: "all" },
      pagination: {
        strategy: "page",
        page_param: "page",
        limit_param: "per_page",
        page_size: 100,
        max_pages: 20,
      },
    }),
  ]);
  expect(result.eligible_for_repeated_runs).toBe(true);
  expect(result.digest).toBe("8ed23d38b00c74647ffb83ff230b8d6ee3402382ce4a78370def4ef30060bb0e");
});

test("a REST GET with link pagination keeps its pinned digest", () => {
  const result = compiled([
    readStep("commits", "/repos/acme/app/commits", {
      query: { sha: "main" },
      pagination: {
        strategy: "link",
        link_params: ["page"],
        limit_param: "per_page",
        page_size: 100,
        max_pages: 20,
        on_limit: "truncate",
        unique_by: "sha",
      },
    }),
  ]);
  expect(result.eligible_for_repeated_runs).toBe(true);
  expect(result.manifest.effects[0]).toMatchObject({ operation: "GET", effect: "read" });
  expect(result.digest).toBe("3df4158481ef1fbd8c48a40fedf9dc7aeacb5fa7af85439c400aff05ade09db4");
});
