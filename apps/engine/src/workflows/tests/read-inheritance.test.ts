import { describe, expect, test } from "bun:test";
import {
  base,
  connector,
  type Dag,
  type Effect,
  effectOf,
  ITEMS_QUERY,
  judge,
  origin,
  restBoundary,
  stepOf,
} from "./read-inheritance-fixtures.ts";

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
