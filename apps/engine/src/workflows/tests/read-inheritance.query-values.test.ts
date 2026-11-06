import { describe, expect, test } from "bun:test";
import { boundaryGrowth } from "../authority-inheritance.ts";
import {
  type ReadInheritanceEvidence,
  readEffectInherits,
  requestStepsOf,
} from "../read-inheritance.ts";
import type { RequestStep } from "../types.ts";
import {
  base,
  connector,
  type Dag,
  type Effect,
  effectOf,
  grantedVersion,
  ITEMS_QUERY,
  judge,
  manifest,
  nextVersion,
  origin,
  restBoundary,
  stepOf,
} from "./read-inheritance-fixtures.ts";

function relaxedBy(change: (dag: Dag, effects: Effect[]) => Effect[] | undefined) {
  const relaxed = new Map<string, string[]>();
  expect(judge(change, true, relaxed)).toEqual([]);
  return Object.fromEntries(relaxed);
}

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
