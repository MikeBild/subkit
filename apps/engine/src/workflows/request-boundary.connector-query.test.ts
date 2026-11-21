import { expect, test } from "bun:test";
import { workflowJsonDigest } from "./canonical-json.ts";
import {
  type ConnectorQuery,
  compileRequestBoundary,
  connectorQueryOf,
  describeRequestBoundaryViolation,
  RequestBoundarySchema,
  requestBoundary,
  requestBoundaryViolation,
} from "./request-boundary.ts";
import { BASE, step } from "./request-boundary-fixtures.ts";

const read = step({
  method: "GET",
  path: "/sites/${input.site}/stats",
  query: { tz: "UTC" },
  boundary: {
    variables: { "input.site": { enum: ["blog"] } },
    max_body_bytes: 0,
    max_calls: 1,
  },
});

function own(fixed: Record<string, unknown>, credential: string[]): ConnectorQuery {
  const query = connectorQueryOf(fixed, credential);
  if (!query) throw new Error("connector query fixture did not resolve");
  return query;
}

const OWN = own({ format: "json" }, ["api_key"]);

const url = (query: string) => `https://api.example.test/v2/sites/blog/stats?${query}`;

function violation(query: string, own = OWN) {
  const { boundary } = compileRequestBoundary(read, BASE, own);
  if (!boundary) throw new Error("boundary did not compile");
  return requestBoundaryViolation(boundary, {
    method: "GET",
    url: url(query),
    headers: {},
    body: null,
  });
}

test("the connector's own query keys become part of the compiled boundary", () => {
  const { boundary, refusal } = compileRequestBoundary(
    read,
    BASE,
    own({ format: "json" }, ["token", "api_key", "api_key"]),
  );
  expect(refusal).toBeUndefined();
  expect(boundary?.connector_query).toEqual({
    fixed: { format: workflowJsonDigest("json") },
    credential: ["api_key", "token"],
  });
});

test("a static value is pinned by its digest and never stored as text", () => {
  const query = own({ api_key: "s3cr3t-static", limit: 50, strict: true }, []);
  expect(JSON.stringify(query)).not.toContain("s3cr3t-static");
  expect(query.fixed).toEqual({
    api_key: workflowJsonDigest("s3cr3t-static"),
    limit: workflowJsonDigest("50"),
    strict: workflowJsonDigest("true"),
  });
  const { boundary } = compileRequestBoundary(read, BASE, query);
  expect(JSON.stringify(boundary)).not.toContain("s3cr3t-static");
  const check = (value: string) =>
    requestBoundaryViolation(boundary!, {
      method: "GET",
      url: url(`tz=UTC&api_key=${value}&limit=50&strict=true`),
      headers: {},
      body: null,
    });
  expect(check("s3cr3t-static")).toBeNull();
  expect(check("S3cr3t-static")).toEqual({
    kind: "query",
    detail: { reason: "fixed_value", key: "api_key" },
  });
  expect(check("")).toEqual({ kind: "query", detail: { reason: "fixed_value", key: "api_key" } });
});

test("a connector without own query keys leaves the boundary exactly as it was", () => {
  const plain = compileRequestBoundary(read, BASE).boundary;
  const empty = compileRequestBoundary(read, BASE, own({}, [])).boundary;
  expect(plain).toBeDefined();
  expect(plain?.connector_query).toBeUndefined();
  expect(workflowJsonDigest(empty)).toBe(workflowJsonDigest(plain));
});

test("the boundary digest changes with every connector key and static value", () => {
  const digest = (query: ConnectorQuery) =>
    workflowJsonDigest(compileRequestBoundary(read, BASE, query).boundary);
  const reviewed = digest(OWN);
  expect(digest(own({ format: "xml" }, ["api_key"]))).not.toBe(reviewed);
  expect(digest(own({ format: "json" }, ["key"]))).not.toBe(reviewed);
  expect(digest(own({ format: "json" }, []))).not.toBe(reviewed);
  expect(digest(own({}, ["api_key"]))).not.toBe(reviewed);
  expect(digest(own({ format: "json" }, ["api_key"]))).toBe(reviewed);
});

test("a connector key that the step also uses is refused, whatever the step uses it for", () => {
  const refusal = (extra: Record<string, unknown>, own: ConnectorQuery) =>
    compileRequestBoundary(step({ ...read, ...extra }), BASE, own).refusal;
  expect(refusal({}, own({ tz: "CET" }, []))).toBe("connector_query_conflict");
  expect(refusal({}, own({}, ["tz"]))).toBe("connector_query_conflict");
  expect(refusal({}, own({ api_key: "a" }, ["api_key"]))).toBe("connector_query_conflict");
  expect(
    refusal(
      {
        path: "/sites/blog/stats",
        query: { site: "${input.site}" },
      },
      own({}, ["site"]),
    ),
  ).toBe("connector_query_conflict");
  expect(
    refusal(
      {
        pagination: {
          strategy: "page",
          page_param: "page",
          limit_param: "per_page",
          max_pages: 3,
        },
      },
      own({ per_page: "50" }, []),
    ),
  ).toBe("connector_query_conflict");
});

test("a static query that adds nothing counts as empty, one that cannot be named is refused", () => {
  const empty = { fixed: {}, credential: [] };
  for (const nothing of [undefined, null, [], {}, "", 0, false])
    expect(connectorQueryOf(nothing, [])).toEqual(empty);
  expect(connectorQueryOf([], ["key"])).toEqual(own({}, ["key"]));
  expect(connectorQueryOf({ nested: { a: 1 } }, [])).toEqual({
    fixed: { nested: workflowJsonDigest("[object Object]") },
    credential: [],
  });
  expect(connectorQueryOf(["a"], [])).toEqual({
    fixed: { "0": workflowJsonDigest("a") },
    credential: [],
  });
  expect(connectorQueryOf({ "": "a" }, [])).toBeNull();
  expect(connectorQueryOf({ a: "b" }, [""])).toBeNull();
  expect(connectorQueryOf({ ["k".repeat(201)]: "b" }, [])).toBeNull();
  expect(compileRequestBoundary(read, BASE, { fixed: { "": "x" }, credential: [] }).refusal).toBe(
    "connector_query_unresolved",
  );
  const plainText = { fixed: { format: "json" }, credential: [] };
  expect(compileRequestBoundary(read, BASE, plainText).refusal).toBe("connector_query_unresolved");
});

test("dispatch admits exactly the reviewed query and nothing beside it", () => {
  expect(violation("tz=UTC&format=json&api_key=s3cr3t")).toBeNull();
  expect(violation("api_key=another-s3cr3t&format=json&tz=UTC")).toBeNull();
  expect(violation("tz=UTC&format=json")).toEqual({
    kind: "query",
    detail: { reason: "missing_key", key: "api_key" },
  });
  expect(violation("tz=UTC&api_key=s3cr3t")).toEqual({
    kind: "query",
    detail: { reason: "missing_key", key: "format" },
  });
  expect(violation("tz=UTC&format=xml&api_key=s3cr3t")).toEqual({
    kind: "query",
    detail: { reason: "fixed_value", key: "format" },
  });
  expect(violation("tz=UTC&format=json&api_key=s3cr3t&debug=1")).toEqual({
    kind: "query",
    detail: { reason: "unexpected_key", key: "debug" },
  });
  expect(violation("tz=UTC&format=json&api_key=a&api_key=b")).toEqual({
    kind: "query",
    detail: { reason: "duplicate_key", key: "api_key" },
  });
  expect(violation("tz=UTC&format=json&api_key=s3cr3t&token=t")).toEqual({
    kind: "query",
    detail: { reason: "unexpected_key", key: "token" },
  });
});

test("a boundary reviewed without connector keys refuses a connector that adds them later", () => {
  const { boundary } = compileRequestBoundary(read, BASE);
  expect(
    requestBoundaryViolation(boundary!, {
      method: "GET",
      url: url("tz=UTC&api_key=s3cr3t"),
      headers: {},
      body: null,
    }),
  ).toEqual({ kind: "query", detail: { reason: "unexpected_key", key: "api_key" } });
});

test("no refusal text ever repeats a credential value", () => {
  for (const query of [
    "tz=UTC&format=xml&api_key=s3cr3t",
    "tz=UTC&format=json&api_key=s3cr3t&debug=1",
    "tz=UTC&format=json&api_key=s3cr3t&api_key=s3cr3t",
    "tz=CET&format=json&api_key=s3cr3t",
  ]) {
    const found = violation(query);
    expect(found).not.toBeNull();
    expect(describeRequestBoundaryViolation(found!)).not.toContain("s3cr3t");
    expect(JSON.stringify(found)).not.toContain("s3cr3t");
  }
});

test("a stored boundary whose connector keys overlap the step's keys is not trusted", () => {
  const { boundary } = compileRequestBoundary(read, BASE, OWN);
  const tampered = (connector_query: unknown) =>
    RequestBoundarySchema.safeParse({ ...boundary, connector_query }).success;
  expect(tampered(OWN)).toBe(true);
  expect(tampered(own({ tz: "UTC" }, []))).toBe(false);
  expect(tampered(own({}, ["tz"]))).toBe(false);
  expect(tampered(own({}, []))).toBe(false);
  expect(tampered(own({ a: "1" }, ["a"]))).toBe(false);
  expect(tampered(own({}, ["b", "a"]))).toBe(false);
  expect(tampered({ fixed: {}, credential: ["a"], extra: true })).toBe(false);
  expect(
    requestBoundaryViolation(
      { ...boundary!, connector_query: { fixed: { tz: "UTC" }, credential: [] } },
      { method: "GET", url: url("tz=UTC"), headers: {}, body: null },
    ),
  ).toEqual({ kind: "boundary_invalid" });
});

test("recompiling from the reviewed connector keys reproduces the reviewed boundary", () => {
  const { boundary } = compileRequestBoundary(read, BASE, OWN);
  expect(requestBoundary(read, boundary!.base_url, boundary!.connector_query)).toEqual(boundary!);
  expect(workflowJsonDigest(requestBoundary(read, boundary!.base_url))).not.toBe(
    workflowJsonDigest(boundary),
  );
});
