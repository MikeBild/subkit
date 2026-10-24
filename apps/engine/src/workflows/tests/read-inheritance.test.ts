import { describe, expect, test } from "bun:test";
import { boundaryGrowth } from "../authority-inheritance.ts";
import type { WorkflowEffectManifest } from "../effect-manifest.ts";
import {
  type ReadInheritanceEvidence,
  readEffectInherits,
  requestStepsOf,
} from "../read-inheritance.ts";
import type { RequestStep } from "../types.ts";

type Effect = WorkflowEffectManifest["effects"][number];
type Dag = { name: string; steps: Array<Record<string, unknown>> };

const tenant = "00000000-0000-4000-8000-000000000001";
const workflow = "00000000-0000-4000-8000-000000000002";
const grantedVersion = "00000000-0000-4000-8000-000000000010";
const nextVersion = "00000000-0000-4000-8000-000000000011";
const connector = "00000000-0000-4000-8000-000000000004";
const origin = "https://api.example.test";

const ITEMS_QUERY =
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

function base(step_id: string, target: string, over: Partial<Effect> = {}): Effect {
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

function restBoundary(path: string, max_calls: number, max_requests?: number) {
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

function stepOf(dag: Dag, id: string): Record<string, unknown> {
  const step = dag.steps.find((candidate) => candidate.id === id);
  if (!step) throw new Error(`fixture has no step ${id}`);
  return step;
}

function effectOf(effects: Effect[], id: string): Effect {
  const effect = effects.find((candidate) => candidate.step_id === id);
  if (!effect) throw new Error(`fixture has no effect ${id}`);
  return effect;
}

function judge(
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

function relaxedBy(change: (dag: Dag, effects: Effect[]) => Effect[] | undefined) {
  const relaxed = new Map<string, string[]>();
  expect(judge(change, true, relaxed)).toEqual([]);
  return Object.fromEntries(relaxed);
}

describe("read-only versions that may inherit their approval", () => {
  const inherits: Array<[string, (dag: Dag, effects: Effect[]) => Effect[] | undefined]> = [
    ["an unchanged version", () => undefined],
    [
      "a changed timeout",
      (dag) => {
        stepOf(dag, "repo").timeout_ms = 30_000;
        return undefined;
      },
    ],
    [
      "changed retries and backoff",
      (dag) => {
        Object.assign(stepOf(dag, "issues"), {
          max_retries: 4,
          retry_backoff_ms: 500,
          retry_on_status: [429, 503],
        });
        return undefined;
      },
    ],
    [
      "a changed fixed accept or API version header",
      (dag) => {
        stepOf(dag, "repo").headers = {
          Accept: "application/vnd.github.raw+json",
          "X-GitHub-Api-Version": "2026-03-10",
        };
        return undefined;
      },
    ],
    [
      "a lower page limit",
      (dag) => {
        (stepOf(dag, "issues").pagination as Record<string, unknown>).max_pages = 3;
        return undefined;
      },
    ],
    [
      "a lower GraphQL page and item limit",
      (dag) => {
        const graphql = stepOf(dag, "items").graphql as Record<string, Record<string, unknown>>;
        Object.assign(graphql.cursor_pagination ?? {}, { max_pages: 20, max_items: 1000 });
        return undefined;
      },
    ],
    [
      "a lower call limit on the reviewed request boundary",
      (dag, effects) => {
        stepOf(dag, "pulls").boundary = { variables: {}, max_body_bytes: 0, max_calls: 5 };
        effectOf(effects, "pulls").boundary = restBoundary("/repos/acme/app/pulls", 5);
        return undefined;
      },
    ],
    [
      "a changed response mapping without a request change",
      (dag) => {
        Object.assign(stepOf(dag, "issues"), {
          data_selector: "$.items",
          response_schema: { type: "array" },
          on_error: "continue",
        });
        return undefined;
      },
    ],
  ];
  for (const [label, change] of inherits) {
    test(label, () => {
      expect(judge(change)).toEqual([]);
    });
  }
});

describe("read-only versions that must ask a person again", () => {
  const grows: Array<[string, string, (dag: Dag, effects: Effect[]) => Effect[] | undefined]> = [
    [
      "a changed REST query",
      "changed_boundary",
      (dag, effects) => {
        stepOf(dag, "issues").query = { state: "all", per_page: 50 };
        effectOf(effects, "issues").read_query = {
          fixed: { state: "all", per_page: "50" },
          variable: [],
        };
        return undefined;
      },
    ],
    [
      "a changed GraphQL query body",
      "changed_boundary",
      (dag) => {
        const graphql = stepOf(dag, "items").graphql as Record<string, unknown>;
        graphql.query = ITEMS_QUERY.replace("nodes { id }", "nodes { id content { body } }");
        return undefined;
      },
    ],
    [
      "an added GraphQL variable",
      "changed_boundary",
      (dag) => {
        const graphql = stepOf(dag, "items").graphql as Record<string, unknown>;
        graphql.variables = { after: null, owner: "acme", number: 4, state: "OPEN" };
        return undefined;
      },
    ],
    [
      "a removed GraphQL variable",
      "changed_boundary",
      (dag) => {
        const graphql = stepOf(dag, "items").graphql as Record<string, unknown>;
        graphql.variables = { after: null, owner: "acme" };
        return undefined;
      },
    ],
    [
      "a GraphQL variable that is no longer literal",
      "changed_boundary",
      (dag) => {
        const graphql = stepOf(dag, "items").graphql as Record<string, unknown>;
        // biome-ignore lint/suspicious/noTemplateCurlyInString: an authored runtime placeholder
        graphql.variables = { after: null, owner: { login: "${input.owner}" }, number: 4 };
        return undefined;
      },
    ],
    [
      "a GraphQL variable change together with a changed document",
      "changed_boundary",
      (dag) => {
        const graphql = stepOf(dag, "items").graphql as Record<string, unknown>;
        graphql.query = ITEMS_QUERY.replace("first: 50", "first: 100");
        graphql.variables = { after: null, owner: "someone-else", number: 4 };
        return undefined;
      },
    ],
    [
      "a changed literal query value where a reviewed query boundary applies",
      "changed_boundary",
      (dag) => {
        stepOf(dag, "issues").query = { state: "all", per_page: 50 };
        return undefined;
      },
    ],
    [
      "an added literal query key",
      "changed_boundary",
      (dag) => {
        stepOf(dag, "labels").query = { sort: "created", direction: "desc", page_hint: "x" };
        return undefined;
      },
    ],
    [
      "a removed literal query key",
      "changed_boundary",
      (dag) => {
        stepOf(dag, "labels").query = { sort: "created" };
        return undefined;
      },
    ],
    [
      "a query value that is no longer literal",
      "changed_boundary",
      (dag) => {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: an authored runtime placeholder
        stepOf(dag, "labels").query = { sort: "${input.sort}", direction: "desc" };
        return undefined;
      },
    ],
    [
      "a query value moved into the path",
      "changed_boundary",
      (dag) => {
        stepOf(dag, "labels").path = "/repos/acme/app/labels?sort=updated";
        return undefined;
      },
    ],
    [
      "a changed credential binding",
      "changed_boundary",
      (_dag, effects) => {
        effectOf(effects, "repo").credential_binding_digest = "f".repeat(64);
        return undefined;
      },
    ],
    [
      "a changed connector configuration",
      "changed_boundary",
      (_dag, effects) => {
        effectOf(effects, "issues").configuration_digest = "9".repeat(64);
        return undefined;
      },
    ],
    [
      "a target rewrite",
      "changed_boundary",
      (_dag, effects) => {
        effectOf(effects, "pulls").rewrites_target = true;
        return undefined;
      },
    ],
    [
      "a higher page limit",
      "changed_boundary",
      (dag) => {
        (stepOf(dag, "issues").pagination as Record<string, unknown>).max_pages = 50;
        return undefined;
      },
    ],
    [
      "a higher GraphQL page limit",
      "changed_boundary",
      (dag) => {
        const graphql = stepOf(dag, "items").graphql as Record<string, Record<string, unknown>>;
        Object.assign(graphql.cursor_pagination ?? {}, { max_pages: 80 });
        return undefined;
      },
    ],
    [
      "a higher call limit on the reviewed request boundary",
      "changed_boundary",
      (dag, effects) => {
        stepOf(dag, "pulls").boundary = { variables: {}, max_body_bytes: 0, max_calls: 50 };
        effectOf(effects, "pulls").boundary = restBoundary("/repos/acme/app/pulls", 50);
        return undefined;
      },
    ],
    [
      "a removed page limit",
      "changed_boundary",
      (dag) => {
        const pagination = stepOf(dag, "issues").pagination as Record<string, unknown>;
        delete pagination.max_pages;
        return undefined;
      },
    ],
    [
      "pagination added to a single request",
      "changed_boundary",
      (dag) => {
        stepOf(dag, "repo").pagination = {
          strategy: "link",
          link_params: ["page"],
          max_pages: 2,
        };
        return undefined;
      },
    ],
    [
      "a new non-allowlisted header",
      "changed_boundary",
      (dag) => {
        stepOf(dag, "repo").headers = {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "x-filter": "assigned",
        };
        return undefined;
      },
    ],
    [
      "an authorization header",
      "changed_boundary",
      (dag) => {
        stepOf(dag, "repo").headers = {
          accept: "application/vnd.github+json",
          authorization: "Bearer other",
        };
        return undefined;
      },
    ],
    [
      "an allowlisted header that is no longer literal",
      "changed_boundary",
      (dag) => {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: an authored runtime placeholder
        stepOf(dag, "repo").headers = { accept: "${input.media_type}" };
        return undefined;
      },
    ],
    [
      "a request repeated for each item",
      "changed_boundary",
      (dag) => {
        stepOf(dag, "repo").for_each = "input.repositories";
        return undefined;
      },
    ],
    [
      "a new read target",
      "new_target",
      (dag, effects) => {
        dag.steps.push({
          id: "releases",
          kind: "request",
          connector_id: connector,
          method: "GET",
          path: "/repos/acme/app/releases",
        });
        return [...effects, base("releases", `${origin}/repos/acme/app/releases`)];
      },
    ],
    [
      "an added write",
      "new_target",
      (dag, effects) => {
        dag.steps.push({
          id: "comment",
          kind: "request",
          connector_id: connector,
          method: "POST",
          path: "/repos/acme/app/issues/1/comments",
          body: { body: "Briefing" },
        });
        return [
          ...effects,
          base("comment", `${origin}/repos/acme/app/issues/1/comments`, {
            operation: "POST",
            effect: "write",
          }),
        ];
      },
    ],
    [
      "a read turned into a write on the same target",
      "wider_effect",
      (dag, effects) => {
        Object.assign(stepOf(dag, "items"), {
          side_effects: "write",
        });
        effectOf(effects, "items").effect = "write";
        return undefined;
      },
    ],
  ];
  for (const [label, kind, change] of grows) {
    test(label, () => {
      const growth = judge(change);
      expect(growth.length).toBeGreaterThan(0);
      expect(growth.map((entry) => entry.kind)).toContain(kind as never);
    });
  }
});

describe("the rule only applies with both reviewed definitions", () => {
  test("without definitions a GraphQL read query change still inherits under the current rule", () => {
    const growth = judge((dag) => {
      const graphql = stepOf(dag, "items").graphql as Record<string, unknown>;
      graphql.query = ITEMS_QUERY.replace("nodes { id }", "nodes { id content { body } }");
      return undefined;
    }, false);
    expect(growth).toEqual([]);
  });

  test("without definitions a lower call limit still asks a person again", () => {
    const growth = judge((dag, effects) => {
      stepOf(dag, "pulls").boundary = { variables: {}, max_body_bytes: 0, max_calls: 5 };
      effectOf(effects, "pulls").boundary = restBoundary("/repos/acme/app/pulls", 5);
      return undefined;
    }, false);
    expect(growth.map((entry) => entry.kind)).toEqual(["changed_boundary"]);
  });

  test("a read the definitions cannot show is judged by the current rule", () => {
    const missing = judge((dag) => {
      dag.steps = dag.steps.filter((step) => step.id !== "items");
      return undefined;
    });
    expect(missing).toEqual([]);
    const called = judge((_dag, effects) => {
      for (const effect of effects) effect.call_path = ["child"];
      effectOf(effects, "pulls").boundary = restBoundary("/repos/acme/app/pulls", 5);
      return undefined;
    });
    expect(called.map((entry) => entry.kind)).toEqual(["changed_boundary"]);
  });

  test("writes keep the current strict rule", () => {
    const writeEffect = (body: string): Effect =>
      base("comment", `${origin}/repos/acme/app/issues/1/comments`, {
        operation: "POST",
        effect: "write",
        request_digest: body.repeat(64).slice(0, 64),
      });
    const dag = (body: string): Dag => ({
      name: "Comment",
      steps: [
        {
          id: "comment",
          kind: "request",
          connector_id: connector,
          method: "POST",
          path: "/repos/acme/app/issues/1/comments",
          body: { body },
          timeout_ms: body === "a" ? 1_000 : 2_000,
        },
      ],
    });
    const grantedSteps = requestStepsOf(dag("a"));
    const nextSteps = requestStepsOf(dag("b"));
    if (!grantedSteps || !nextSteps) throw new Error("fixture definitions do not parse");
    const granted = manifest(grantedVersion, [writeEffect("a")]);
    const next = manifest(nextVersion, [writeEffect("b")]);
    expect(boundaryGrowth(granted, next, { granted: grantedSteps, next: nextSteps })).toEqual(
      boundaryGrowth(granted, next),
    );
  });
});

describe("read-only versions that only change literal request values", () => {
  test("a changed literal query value on the same endpoint inherits and names the key", () => {
    expect(
      relaxedBy((dag) => {
        stepOf(dag, "labels").query = { sort: "updated", direction: "desc" };
        return undefined;
      }),
    ).toEqual({ labels: ["query.sort"] });
  });

  test("changed GraphQL variable values on the same query document inherit and name the keys", () => {
    expect(
      relaxedBy((dag) => {
        const graphql = stepOf(dag, "items").graphql as Record<string, unknown>;
        graphql.variables = { after: null, owner: "someone-else", number: 7 };
        return undefined;
      }),
    ).toEqual({ items: ["graphql.variables.number", "graphql.variables.owner"] });
  });

  test("an unchanged request inherits without relaxed keys", () => {
    expect(relaxedBy(() => undefined)).toEqual({});
  });

  test("the transport relaxations are named too", () => {
    expect(
      relaxedBy((dag, effects) => {
        stepOf(dag, "repo").timeout_ms = 30_000;
        stepOf(dag, "repo").headers = {
          accept: "application/vnd.github.raw+json",
          "x-github-api-version": "2022-11-28",
        };
        stepOf(dag, "pulls").boundary = { variables: {}, max_body_bytes: 0, max_calls: 5 };
        effectOf(effects, "pulls").boundary = restBoundary("/repos/acme/app/pulls", 5);
        return undefined;
      }),
    ).toEqual({
      pulls: ["boundary.max_calls"],
      repo: ["headers.accept", "timeout_ms"],
    });
  });
});

describe("GraphQL documents that are not a pure query keep the strict rule", () => {
  const graphqlTarget = `${origin}/graphql`;
  const judgeDocument = (query: string, operation?: "query" | "mutation" | "subscription") => {
    const dag = (owner: string): Dag => ({
      name: "GraphQL read",
      steps: [
        {
          id: "read",
          kind: "request",
          connector_id: connector,
          method: "POST",
          graphql: {
            ...(operation ? { operation } : {}),
            query,
            variables: { owner },
          },
        },
      ],
    });
    const effect = () => base("read", graphqlTarget, { driver: "graphql", operation: "query" });
    const grantedSteps = requestStepsOf(dag("acme"));
    const nextSteps = requestStepsOf(dag("someone-else"));
    if (!grantedSteps || !nextSteps) throw new Error("fixture definitions do not parse");
    return boundaryGrowth(manifest(grantedVersion, [effect()]), manifest(nextVersion, [effect()]), {
      granted: grantedSteps,
      next: nextSteps,
    });
  };

  test("a pure query document with only a changed variable value inherits", () => {
    expect(judgeDocument("query Repo($owner: String!) { user(login: $owner) { id } }")).toEqual([]);
  });

  const strict: Array<[string, string, ("query" | "mutation" | "subscription")?]> = [
    [
      "a mutation declared as a query read",
      "mutation Close($owner: String!) { closeAll(owner: $owner) { id } }",
      "query",
    ],
    [
      "a subscription declared as a query read",
      "subscription Watch($owner: String!) { events(owner: $owner) { id } }",
    ],
    [
      "a query document mixed with a mutation",
      "query Repo($owner: String!) { user(login: $owner) { id } } mutation Close($owner: String!) { closeAll(owner: $owner) { id } }",
    ],
    [
      "a query document labelled as a mutation",
      "query Repo($owner: String!) { user(login: $owner) { id } }",
      "mutation",
    ],
    ["a document that does not parse", "query Repo($owner: String!) { user(login: $owner) { id }"],
    ["a schema definition instead of an operation", "type Query { user(login: String!): ID }"],
  ];
  for (const [label, query, operation] of strict) {
    test(label, () => {
      expect(judgeDocument(query, operation).map((entry) => entry.kind)).toEqual([
        "changed_boundary",
      ]);
    });
  }
});

describe("query value relaxation never reaches writes", () => {
  test("a write with a changed literal query value is judged by the strict rule", () => {
    const step = (sort: string): RequestStep =>
      ({
        id: "update",
        kind: "request",
        connector_id: connector,
        method: "PATCH",
        path: "/repos/acme/app/labels",
        query: { sort },
      }) as RequestStep;
    const write = base("update", `${origin}/repos/acme/app/labels`, {
      operation: "PATCH",
      effect: "write",
    });
    const evidence: ReadInheritanceEvidence = {
      granted: new Map([["update", step("created")]]),
      next: new Map([["update", step("updated")]]),
    };
    expect(readEffectInherits(write, write, evidence, [])).toBeNull();
  });
});
