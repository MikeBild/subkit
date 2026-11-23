import { describe, expect, test } from "bun:test";
import { workflowJsonDigest } from "../canonical-json.ts";
import {
  definitionDigest,
  definitionDigestView,
  derivedRequestProtocol,
  REQUEST_PROTOCOLS,
  requestDigest,
  requestDigestView,
  requestProtocol,
  requestProtocolDriver,
  rewriteStoredRequestProtocols,
} from "./request-protocol.ts";

describe("requestProtocol", () => {
  test("a step without a protocol speaks http", () => {
    expect(requestProtocol({})).toBe("http");
    expect(requestProtocol({ protocol: undefined })).toBe("http");
    for (const protocol of REQUEST_PROTOCOLS) expect(requestProtocol({ protocol })).toBe(protocol);
  });

  test("each protocol names its driver; only sql differs in name", () => {
    expect(REQUEST_PROTOCOLS.map((protocol) => requestProtocolDriver({ protocol }))).toEqual([
      "http",
      "graphql",
      "postgres",
      "s3",
      "mcp",
    ]);
    expect(requestProtocolDriver({})).toBe("http");
  });
});

describe("derivedRequestProtocol", () => {
  test("the block decides, in the order mcp, sql, graphql, s3", () => {
    const blocks = { mcp: {}, sql: {}, graphql: {}, s3: {} };
    expect(derivedRequestProtocol(blocks)).toBe("mcp");
    expect(derivedRequestProtocol({ sql: {}, graphql: {}, s3: {} })).toBe("sql");
    expect(derivedRequestProtocol({ graphql: {}, s3: {} })).toBe("graphql");
    expect(derivedRequestProtocol({ s3: {} })).toBe("s3");
    expect(derivedRequestProtocol({ xml: { body: {} } })).toBe("http");
    expect(derivedRequestProtocol({})).toBe("http");
  });

  test("a null or undefined block does not count", () => {
    expect(derivedRequestProtocol({ mcp: null, sql: undefined, s3: {} })).toBe("s3");
    expect(derivedRequestProtocol({ graphql: null })).toBe("http");
  });
});

describe("rewriteStoredRequestProtocols", () => {
  const http = { id: "read", kind: "request", method: "GET", url: "https://example.test" };
  const sql = { id: "rows", kind: "request", method: "GET", sql: { query: "select 1" } };
  const graphql = { id: "gql", kind: "request", graphql: { query: "query { a }" } };
  const transform = { id: "shape", kind: "transform", expression: "return 1;", sql: {} };

  test("only request steps with a non-http block gain a protocol, everything else is untouched", () => {
    const dag = { name: "stored", steps: [http, sql, graphql, transform], timeout_ms: 5 };
    const frozen = JSON.stringify(dag);
    const result = rewriteStoredRequestProtocols(dag);
    expect(result.changed).toBe(true);
    expect(result.changes).toEqual([
      { step_id: "rows", protocol: "sql" },
      { step_id: "gql", protocol: "graphql" },
    ]);
    expect(result.dag).toEqual({
      name: "stored",
      timeout_ms: 5,
      steps: [http, { ...sql, protocol: "sql" }, { ...graphql, protocol: "graphql" }, transform],
    });
    expect((result.dag as { steps: unknown[] }).steps[0]).toBe(http);
    expect(JSON.stringify(dag)).toBe(frozen);
  });

  test("a step that already names its protocol is left alone, also when it is wrong", () => {
    const dag = {
      steps: [
        { ...sql, protocol: "sql" },
        { ...graphql, protocol: "http" },
      ],
    };
    expect(rewriteStoredRequestProtocols(dag)).toEqual({ changed: false, dag, changes: [] });
  });

  test("a step without an id is still rewritten and reported with an empty id", () => {
    const result = rewriteStoredRequestProtocols({
      steps: [{ kind: "request", s3: { key: "a" } }],
    });
    expect(result.changes).toEqual([{ step_id: "", protocol: "s3" }]);
  });

  test("definitions without steps and malformed inputs come back untouched", () => {
    for (const dag of [null, 7, "x", [], {}, { steps: "x" }, { steps: [null, 3, http] }])
      expect(rewriteStoredRequestProtocols(dag)).toEqual({ changed: false, dag, changes: [] });
  });
});

describe("digest views", () => {
  test("the protocol is not part of a step's digest view, every other field is", () => {
    expect(requestDigestView({ id: "a", protocol: "sql", sql: { query: "select 1" } })).toEqual({
      id: "a",
      sql: { query: "select 1" },
    });
    const plain = { id: "a", url: "https://example.test" };
    expect(requestDigestView(plain)).toBe(plain);
    for (const value of [null, 3, "x", [1]]) expect(requestDigestView(value)).toBe(value);
  });

  test("a definition's digest view drops the protocol of every step and keeps the rest", () => {
    expect(
      definitionDigestView({
        name: "d",
        steps: [{ id: "a", protocol: "mcp", mcp: {} }, { id: "b" }],
      }),
    ).toEqual({ name: "d", steps: [{ id: "a", mcp: {} }, { id: "b" }] });
    for (const value of [null, 3, {}, { steps: 1 }])
      expect(definitionDigestView(value)).toBe(value);
  });

  test("naming the protocol never moves a step or definition digest; any other change does", () => {
    const stored = { id: "rows", kind: "request", method: "GET", sql: { query: "select 1" } };
    const named = { ...stored, protocol: "sql" };
    expect(requestDigest(named)).toBe(workflowJsonDigest(stored));
    expect(requestDigest(stored)).toBe(workflowJsonDigest(stored));
    expect(requestDigest({ ...named, method: "SELECT" })).not.toBe(requestDigest(named));
    expect(definitionDigest({ name: "d", steps: [named] })).toBe(
      workflowJsonDigest({ name: "d", steps: [stored] }),
    );
    expect(definitionDigest({ name: "e", steps: [named] })).not.toBe(
      definitionDigest({ name: "d", steps: [named] }),
    );
  });
});
