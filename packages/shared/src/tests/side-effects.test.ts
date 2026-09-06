// Unit tests for `classifyHttpSideEffect` — the ONE shared rule that
// decides read vs. write for the engine's hold-writes mechanism AND the
// conversation/MCP confirm-gate. The load-bearing case is the one that
// produced the "gemeldet ≠ geschrieben" no-op in prod: a search over
// POST is a WRITE unless the author marks it `override: "read"`.

import { describe, expect, test } from "bun:test";
import {
  classifyHttpSideEffect,
  classifyMcpToolSideEffect,
  httpMethodIsRead,
  inferGraphqlOperation,
  sqlIsSelect,
} from "../side-effects.ts";

describe("classifyHttpSideEffect — HTTP method", () => {
  test("GET / HEAD / OPTIONS are reads", () => {
    for (const method of ["GET", "HEAD", "OPTIONS", "get", "head"]) {
      expect(classifyHttpSideEffect({ method })).toBe("read");
    }
  });

  test("POST / PATCH / PUT / DELETE are writes", () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE", "post"]) {
      expect(classifyHttpSideEffect({ method })).toBe("write");
    }
  });

  test("missing method defaults to GET (read)", () => {
    expect(classifyHttpSideEffect({})).toBe("read");
  });

  test("a search over POST is a write absent an override (the prod no-op trigger)", () => {
    expect(classifyHttpSideEffect({ method: "POST" })).toBe("write");
  });
});

describe("classifyHttpSideEffect — override (author escape hatch)", () => {
  test("override:read wins over a POST", () => {
    expect(classifyHttpSideEffect({ method: "POST", override: "read" })).toBe("read");
  });

  test("override:write wins over a GET", () => {
    expect(classifyHttpSideEffect({ method: "GET", override: "write" })).toBe("write");
  });

  test("override:read cannot downgrade structurally mutating HTTP methods", () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      expect(classifyHttpSideEffect({ method, override: "read" })).toBe("write");
    }
  });
});

describe("classifyHttpSideEffect — GraphQL", () => {
  test("query operation is read", () => {
    expect(classifyHttpSideEffect({ graphql: { operation: "query", query: "{ me }" } })).toBe(
      "read",
    );
  });

  test("mutation / subscription are writes", () => {
    expect(
      classifyHttpSideEffect({ graphql: { operation: "mutation", query: "mutation { x }" } }),
    ).toBe("write");
    expect(
      classifyHttpSideEffect({
        graphql: { operation: "subscription", query: "subscription { x }" },
      }),
    ).toBe("write");
  });

  test("operation inferred from the document when not explicit", () => {
    expect(classifyHttpSideEffect({ graphql: { query: "mutation Foo { x }" } })).toBe("write");
    expect(classifyHttpSideEffect({ graphql: { query: "  { bareSelection }" } })).toBe("read");
  });

  test("a misleading query label or read override cannot hide a mutation", () => {
    for (const query of [
      "mutation Remove { remove { id } }",
      "fragment F on Item { id } mutation Remove { remove { ...F } }",
      "query Read { items { id } } mutation Remove { remove { id } }",
      "subscription Watch { items { id } }",
    ]) {
      expect(classifyHttpSideEffect({ graphql: { operation: "query", query } })).toBe("write");
      expect(classifyHttpSideEffect({ graphql: { query }, override: "read" })).toBe("write");
    }
  });

  test("fragment-first reads remain reads, but missing or invalid operations fail closed", () => {
    expect(
      classifyHttpSideEffect({
        graphql: {
          query: "fragment F on Item { id } query Read { items { ...F } }",
        },
      }),
    ).toBe("read");
    for (const query of ["", "fragment F on Item { id }", "not a query", "mutation {"]) {
      expect(
        classifyHttpSideEffect({ graphql: { operation: "query", query }, override: "read" }),
      ).toBe("write");
    }
  });

  test("oversized GraphQL documents do not consume an unbounded parser budget", () => {
    const query = `{ ${"item ".repeat(10_001)} }`;
    expect(classifyHttpSideEffect({ graphql: { query } })).toBe("write");
  });
});

describe("classifyHttpSideEffect — SQL", () => {
  test("SELECT-only is read", () => {
    expect(classifyHttpSideEffect({ sql: { query: "SELECT 1" } })).toBe("read");
  });

  test("SELECT with leading comments is read", () => {
    expect(classifyHttpSideEffect({ sql: { query: "-- c\n/* b */ select * from t" } })).toBe(
      "read",
    );
  });

  test("INSERT / UPDATE / WITH-CTE are writes", () => {
    expect(classifyHttpSideEffect({ sql: { query: "INSERT INTO t VALUES (1)" } })).toBe("write");
    expect(classifyHttpSideEffect({ sql: { query: "with x as (select 1) select * from x" } })).toBe(
      "write",
    );
  });

  test("a read collapses to write if any `also` statement writes", () => {
    expect(
      classifyHttpSideEffect({
        sql: { query: "SELECT 1", also: [{ query: "DELETE FROM t" }] },
      }),
    ).toBe("write");
  });

  test("a read label cannot downgrade SQL writes or a writing also statement", () => {
    for (const sql of [
      { query: "DELETE FROM t" },
      { query: "UPDATE t SET x = 1" },
      { query: "SELECT 1", also: [{ query: "DELETE FROM t" }] },
    ]) {
      expect(classifyHttpSideEffect({ sql, override: "read" })).toBe("write");
    }
  });
});

describe("classifyHttpSideEffect — S3", () => {
  test("GET / HEAD / LIST are reads, PUT / DELETE are writes", () => {
    expect(classifyHttpSideEffect({ s3: true, method: "GET" })).toBe("read");
    expect(classifyHttpSideEffect({ s3: true, method: "LIST" })).toBe("read");
    expect(classifyHttpSideEffect({ s3: true, method: "PUT" })).toBe("write");
    expect(classifyHttpSideEffect({ s3: true, method: "DELETE" })).toBe("write");
  });

  test("override:read cannot downgrade an S3 mutation", () => {
    expect(classifyHttpSideEffect({ s3: true, method: "PUT", override: "read" })).toBe("write");
    expect(classifyHttpSideEffect({ s3: true, method: "DELETE", override: "read" })).toBe("write");
  });
});

describe("helpers", () => {
  test("httpMethodIsRead", () => {
    expect(httpMethodIsRead("get")).toBe(true);
    expect(httpMethodIsRead("POST")).toBe(false);
  });

  test("inferGraphqlOperation never invents a query for an unknown document", () => {
    expect(inferGraphqlOperation("fragment F on T { x }")).toBeNull();
    expect(inferGraphqlOperation("fragment F on T { x } mutation M { remove { ...F } }")).toBe(
      "mutation",
    );
    expect(
      inferGraphqlOperation("query Read { items { id } } subscription Updates { item { id } }"),
    ).toBe("subscription");
  });

  test("sqlIsSelect", () => {
    expect(sqlIsSelect("  SELECT 1")).toBe(true);
    expect(sqlIsSelect("UPDATE t SET x=1")).toBe(false);
  });
});

describe("classifyMcpToolSideEffect — the remote's own annotations", () => {
  test("no annotations at all is a write", () => {
    // Silence is not a claim of harmlessness. A tool that says nothing
    // about itself gets the treatment a tool that says nothing deserves.
    expect(classifyMcpToolSideEffect(undefined)).toBe("write");
    expect(classifyMcpToolSideEffect(null)).toBe("write");
    expect(classifyMcpToolSideEffect({})).toBe("write");
  });

  test("annotations that do not assert read-only are a write", () => {
    expect(classifyMcpToolSideEffect({ readOnlyHint: false })).toBe("write");
    // Partial annotations — the server answered other questions and left
    // this one open — do not answer it by omission.
    expect(classifyMcpToolSideEffect({ idempotentHint: true, openWorldHint: false })).toBe("write");
  });

  test("only an uncontradicted readOnlyHint yields read", () => {
    expect(classifyMcpToolSideEffect({ readOnlyHint: true })).toBe("read");
    expect(classifyMcpToolSideEffect({ readOnlyHint: true, destructiveHint: false })).toBe("read");
  });

  test("destructiveHint overrides a readOnlyHint rather than being averaged with it", () => {
    // A server contradicting itself is not evidence of safety. The hint
    // can only escalate.
    expect(classifyMcpToolSideEffect({ readOnlyHint: true, destructiveHint: true })).toBe("write");
  });

  test("THE GATE DOES NOT READ IT: a tools/call stays a write however the tool is annotated", () => {
    // This is the whole security property. `classifyHttpSideEffect` is
    // what the hold-writes mechanism and the confirm gate consult, and it
    // takes no annotations — so there is no argument a third-party server
    // can send that turns its own write into an unconfirmed call. If this
    // ever fails, a remote has been handed the power to gate itself.
    expect(classifyHttpSideEffect({ mcp: { operation: "call_tool" } })).toBe("write");
    // A tenant's authoring agent can also supply this label: it is not
    // evidence of a human-approved execution boundary.
    expect(classifyHttpSideEffect({ mcp: { operation: "call_tool" }, override: "read" })).toBe(
      "write",
    );
  });
});
