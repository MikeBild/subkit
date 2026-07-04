// Fix G — side-effect classification matrix for request-class steps.
//
// The classifier lives at the driver layer (never vendor keywords):
// HTTP method semantics via the `isIdempotent` retry seam, GraphQL
// operation kind, SQL leading keyword, S3 verb — with the explicit
// `side_effects` step override winning in BOTH directions.

import { describe, expect, test } from "bun:test";
import { RequestStepSchema } from "../../workflows/types.ts";
import {
  classifyRequestStepSideEffects,
  redactHeldRequestHeaders,
} from "../steps/request/side-effects.ts";

const CONNECTOR_ID = "11111111-2222-4333-8444-555555555555";

function step(partial: Record<string, unknown>) {
  return RequestStepSchema.parse({ kind: "request", id: "s", ...partial });
}

describe("classifyRequestStepSideEffects · HTTP methods", () => {
  const url = "https://api.example.com/things";

  test.each([["GET"], ["HEAD"], ["OPTIONS"]])("%s is read", (method) => {
    expect(classifyRequestStepSideEffects(step({ method, url }))).toBe("read");
  });

  test.each([["POST"], ["PUT"], ["PATCH"], ["DELETE"]])("%s is write", (method) => {
    expect(classifyRequestStepSideEffects(step({ method, url }))).toBe("write");
  });

  test("method defaults to GET → read", () => {
    expect(classifyRequestStepSideEffects(step({ url }))).toBe("read");
  });
});

describe("classifyRequestStepSideEffects · explicit override wins both directions", () => {
  const url = "https://api.example.com/search";

  test("POST forced to read (semantically a search)", () => {
    expect(
      classifyRequestStepSideEffects(step({ method: "POST", url, side_effects: "read" })),
    ).toBe("read");
  });

  test("GET forced to write (mutating GET)", () => {
    expect(
      classifyRequestStepSideEffects(step({ method: "GET", url, side_effects: "write" })),
    ).toBe("write");
  });

  test("override beats the GraphQL operation rule", () => {
    expect(
      classifyRequestStepSideEffects(
        step({
          connector_id: CONNECTOR_ID,
          side_effects: "write",
          graphql: { operation: "query", query: "{ things { id } }" },
        }),
      ),
    ).toBe("write");
  });
});

describe("classifyRequestStepSideEffects · GraphQL", () => {
  test("explicit operation query → read", () => {
    expect(
      classifyRequestStepSideEffects(
        step({
          connector_id: CONNECTOR_ID,
          graphql: { operation: "query", query: "query L { things { id } }" },
        }),
      ),
    ).toBe("read");
  });

  test("explicit operation mutation → write", () => {
    expect(
      classifyRequestStepSideEffects(
        step({
          connector_id: CONNECTOR_ID,
          graphql: { operation: "mutation", query: "mutation A { add { id } }" },
        }),
      ),
    ).toBe("write");
  });

  test("operation inferred from the document — mutation keyword", () => {
    expect(
      classifyRequestStepSideEffects(
        step({
          connector_id: CONNECTOR_ID,
          graphql: { query: "mutation AddThing($n: String!) { add(name: $n) { id } }" },
        }),
      ),
    ).toBe("write");
  });

  test("operation inferred from the document — leading comment then mutation", () => {
    expect(
      classifyRequestStepSideEffects(
        step({
          connector_id: CONNECTOR_ID,
          graphql: { query: "# creates a thing\nmutation { add { id } }" },
        }),
      ),
    ).toBe("write");
  });

  test("bare selection-set shorthand is a query → read", () => {
    expect(
      classifyRequestStepSideEffects(
        step({ connector_id: CONNECTOR_ID, graphql: { query: "{ things { id } }" } }),
      ),
    ).toBe("read");
  });

  test("subscription → write (held, never streamed in preview)", () => {
    expect(
      classifyRequestStepSideEffects(
        step({
          connector_id: CONNECTOR_ID,
          graphql: { query: "subscription { thingAdded { id } }" },
        }),
      ),
    ).toBe("write");
  });
});

describe("classifyRequestStepSideEffects · SQL", () => {
  test("SELECT → read", () => {
    expect(
      classifyRequestStepSideEffects(
        step({ method: "SELECT", sql: { query: "SELECT id FROM widgets" } }),
      ),
    ).toBe("read");
  });

  test("leading whitespace + line comment before SELECT → read", () => {
    expect(
      classifyRequestStepSideEffects(
        step({ method: "SELECT", sql: { query: "  -- list them\n  select id from widgets" } }),
      ),
    ).toBe("read");
  });

  test("INSERT → write", () => {
    expect(
      classifyRequestStepSideEffects(
        step({ method: "INSERT", sql: { query: "INSERT INTO widgets (id) VALUES ($1)" } }),
      ),
    ).toBe("write");
  });

  test("UPDATE → write", () => {
    expect(
      classifyRequestStepSideEffects(
        step({ method: "UPDATE", sql: { query: "UPDATE widgets SET name = $1" } }),
      ),
    ).toBe("write");
  });

  test("WITH-CTE classifies write (conservative; override available)", () => {
    expect(
      classifyRequestStepSideEffects(
        step({ method: "SELECT", sql: { query: "WITH c AS (SELECT 1) SELECT * FROM c" } }),
      ),
    ).toBe("write");
  });

  test("SELECT plus a non-SELECT `also` statement → write", () => {
    expect(
      classifyRequestStepSideEffects(
        step({
          method: "SELECT",
          sql: {
            query: "SELECT id FROM widgets",
            also: [{ query: "DELETE FROM widgets WHERE id = $1" }],
          },
        }),
      ),
    ).toBe("write");
  });

  test("SELECT-only transaction (`also` all SELECT) → read", () => {
    expect(
      classifyRequestStepSideEffects(
        step({
          method: "SELECT",
          sql: {
            query: "SELECT id FROM widgets",
            also: [{ query: "SELECT count(*) FROM widgets" }],
          },
        }),
      ),
    ).toBe("read");
  });
});

describe("classifyRequestStepSideEffects · S3", () => {
  test("GET → read", () => {
    expect(
      classifyRequestStepSideEffects(
        step({ connector_id: CONNECTOR_ID, method: "GET", s3: { key: "a.json" } }),
      ),
    ).toBe("read");
  });

  test("LIST → read", () => {
    expect(
      classifyRequestStepSideEffects(
        step({ connector_id: CONNECTOR_ID, method: "LIST", s3: { prefix: "exports/" } }),
      ),
    ).toBe("read");
  });

  test("PUT → write", () => {
    expect(
      classifyRequestStepSideEffects(
        step({ connector_id: CONNECTOR_ID, method: "PUT", s3: { key: "a.json" } }),
      ),
    ).toBe("write");
  });

  test("DELETE → write", () => {
    expect(
      classifyRequestStepSideEffects(
        step({ connector_id: CONNECTOR_ID, method: "DELETE", s3: { key: "a.json" } }),
      ),
    ).toBe("write");
  });
});

describe("redactHeldRequestHeaders", () => {
  test("masks auth-bearing header values, keeps every name, passes safe values", () => {
    const out = redactHeldRequestHeaders({
      Authorization: "Bearer sk-live-abcdef0123456789abcdef0123456789",
      Cookie: "session=deadbeef",
      "X-Api-Key": "super-secret-key-000",
      "Content-Type": "application/json",
      "X-Trace-Id": "trace-1",
    });
    expect(out.Authorization).toBe("***REDACTED:auth_header***");
    expect(out.Cookie).toBe("***REDACTED:auth_header***");
    expect(out["X-Api-Key"]).toBe("***REDACTED:auth_header***");
    expect(out["Content-Type"]).toBe("application/json");
    expect(out["X-Trace-Id"]).toBe("trace-1");
    // every name survives — the judge must see WHICH headers would be sent
    expect(Object.keys(out).sort()).toEqual(
      ["Authorization", "Content-Type", "Cookie", "X-Api-Key", "X-Trace-Id"].sort(),
    );
  });
});
