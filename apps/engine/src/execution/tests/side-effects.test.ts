import { describe, expect, test } from "bun:test";
import { type RequestStep, RequestStepSchema } from "../../workflows/types.ts";
import { environmentMismatchRefusal } from "../connector-availability.ts";
import {
  classifyRequestStepSideEffects,
  redactHeldRequestHeaders,
  requestRequiresPreparationHold,
} from "../steps/request/side-effects.ts";

const CONNECTOR_ID = "11111111-2222-4333-8444-555555555555";

describe("preparation holds are stricter than retry hints", () => {
  test("a read-labelled POST remains retry-classified read but requires a preparation hold", () => {
    const request = step({
      method: "POST",
      url: "https://example.com/search",
      side_effects: "read",
    });
    expect(classifyRequestStepSideEffects(request)).toBe("read");
    expect(requestRequiresPreparationHold(request, "http")).toBe(true);
  });

  test("SELECT is not proof of a side-effect-free execution", () => {
    expect(
      requestRequiresPreparationHold(
        step({ sql: { query: "SELECT writing_function()" } }),
        "postgres",
      ),
    ).toBe(true);
  });

  test.each(["GET", "HEAD", "OPTIONS"])("ordinary HTTP %s stays autonomous", (method) => {
    expect(
      requestRequiresPreparationHold(step({ method, url: "https://example.com/items" }), "http"),
    ).toBe(false);
  });

  test.each(["postgres", "graphql", "s3", "mcp", "unknown"])(
    "a resolved %s driver cannot borrow HTTP read semantics",
    (driver) => {
      expect(requestRequiresPreparationHold(requestStep({ method: "GET" }), driver)).toBe(true);
    },
  );
});

function step(partial: Record<string, unknown>) {
  return RequestStepSchema.parse({ kind: "request", id: "s", ...partial });
}

function requestStep(partial: Record<string, unknown>): RequestStep {
  return { kind: "request", id: "s", method: "GET", ...partial } as RequestStep;
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

  test.each([["PUT"], ["PATCH"], ["DELETE"]])("%s cannot be forced to read", (method) => {
    expect(classifyRequestStepSideEffects(requestStep({ method, url, side_effects: "read" }))).toBe(
      "write",
    );
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

  test("WITH-CTE classifies write conservatively", () => {
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

describe("classifyRequestStepSideEffects · MCP", () => {
  test("call_tool is a write — a missing annotation gets no benefit of the doubt", () => {
    expect(
      classifyRequestStepSideEffects(
        step({ connector_id: CONNECTOR_ID, mcp: { operation: "call_tool", tool: "send_email" } }),
      ),
    ).toBe("write");
  });

  test("call_tool is a write even though the step method defaults to GET", () => {
    const parsed = step({
      connector_id: CONNECTOR_ID,
      mcp: { operation: "call_tool", tool: "anything" },
    });
    expect(parsed.method).toBe("GET");
    expect(classifyRequestStepSideEffects(parsed)).toBe("write");
  });

  test("read_resource and get_prompt are reads by the operation alone", () => {
    expect(
      classifyRequestStepSideEffects(
        step({ connector_id: CONNECTOR_ID, mcp: { operation: "read_resource", uri: "file:///a" } }),
      ),
    ).toBe("read");
    expect(
      classifyRequestStepSideEffects(
        step({ connector_id: CONNECTOR_ID, mcp: { operation: "get_prompt", prompt: "summarise" } }),
      ),
    ).toBe("read");
  });

  test("an author label cannot downgrade an MCP tool call, but can escalate a read", () => {
    expect(
      classifyRequestStepSideEffects(
        step({
          connector_id: CONNECTOR_ID,
          side_effects: "read",
          mcp: { operation: "call_tool", tool: "search" },
        }),
      ),
    ).toBe("write");
    expect(
      classifyRequestStepSideEffects(
        step({
          connector_id: CONNECTOR_ID,
          side_effects: "write",
          mcp: { operation: "read_resource", uri: "file:///a" },
        }),
      ),
    ).toBe("write");
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

  test("PUT remains write when a definition claims read", () => {
    expect(
      classifyRequestStepSideEffects(
        requestStep({
          connector_id: CONNECTOR_ID,
          method: "PUT",
          side_effects: "read",
          s3: { key: "a.json" },
        }),
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
    expect(Object.keys(out).sort()).toEqual(
      ["Authorization", "Content-Type", "Cookie", "X-Api-Key", "X-Trace-Id"].sort(),
    );
  });
});

test("dispatch classification uses the resolved S3 driver and materialized LIST without an S3 block", () => {
  expect(
    classifyRequestStepSideEffects(
      step({ connector_id: CONNECTOR_ID, method: "GET" }),
      "s3",
      "LIST",
    ),
  ).toBe("read");
  expect(
    classifyRequestStepSideEffects(
      step({ connector_id: CONNECTOR_ID, method: "GET", side_effects: "read" }),
      "s3",
      "PUT",
    ),
  ).toBe("write");
});

test("dispatch classification uses the materialized method without lowering mutation effects", () => {
  expect(
    classifyRequestStepSideEffects(
      step({ connector_id: CONNECTOR_ID, method: "GET", side_effects: "read" }),
      "http",
      "DELETE",
    ),
  ).toBe("write");
});

describe("classifyRequestStepSideEffects · GraphQL over plain HTTP", () => {
  const query =
    "query RadarRepositories($query: String!, $first: Int!) { search(query: $query, type: REPOSITORY, first: $first) { repositoryCount } }";
  const mutation = 'mutation { addStar(input: {starrableId: "1"}) { clientMutationId } }';

  test("a read-labelled mutation in a POST body is a write and is held", () => {
    const request = step({
      connector_id: CONNECTOR_ID,
      method: "POST",
      path: "/graphql",
      body: { query: mutation },
      side_effects: "read",
    });
    expect(classifyRequestStepSideEffects(request, "http")).toBe("write");
    expect(requestRequiresPreparationHold(request, "http")).toBe(true);
  });

  test("a POSTed query document is a read and is not held", () => {
    const request = step({
      connector_id: CONNECTOR_ID,
      method: "POST",
      path: "/graphql",
      body: { query, variables: { query: "x", first: 5 } },
    });
    expect(classifyRequestStepSideEffects(request, "http")).toBe("read");
    expect(requestRequiresPreparationHold(request, "http")).toBe(false);
  });

  test("a POST search on a non-GraphQL path stays held", () => {
    const request = step({
      connector_id: CONNECTOR_ID,
      method: "POST",
      path: "/v1/search",
      body: { query: "SubKit" },
      side_effects: "read",
    });
    expect(classifyRequestStepSideEffects(request, "http")).toBe("read");
    expect(requestRequiresPreparationHold(request, "http")).toBe(true);
  });
});

describe("classifyRequestStepSideEffects · GraphQL endpoint resolved from the connector base_url", () => {
  const graphqlBaseUrl = "https://api.github.com/graphql";
  const persisted = { extensions: { persistedQuery: { version: 1, sha256Hash: "abc" } } };

  test("a read-labelled POST to the connector base_url without a readable document is held", () => {
    for (const target of [{ url: "${connector.github.base_url}" }, { path: "/" }, {}]) {
      const request = step({
        connector_id: CONNECTOR_ID,
        method: "POST",
        side_effects: "read",
        body: { query: "query { viewer { login }" },
        ...target,
      });
      expect(classifyRequestStepSideEffects(request, "http", undefined, graphqlBaseUrl)).toBe(
        "write",
      );
      expect(requestRequiresPreparationHold(request, "http", graphqlBaseUrl)).toBe(true);
    }
  });

  test("a persisted or batched mutation is a write even without the base_url", () => {
    const persistedStep = step({
      connector_id: CONNECTOR_ID,
      method: "POST",
      path: "/graphql",
      side_effects: "read",
      body: persisted,
    });
    const batched = step({
      connector_id: CONNECTOR_ID,
      method: "POST",
      path: "/",
      side_effects: "read",
      body: [{ query: 'mutation { addStar(input: {starrableId: "1"}) { clientMutationId } }' }],
    });
    expect(classifyRequestStepSideEffects(persistedStep, "http")).toBe("write");
    expect(classifyRequestStepSideEffects(batched, "http")).toBe("write");
  });

  test("an environment fallback refuses a read-labelled GraphQL write on the base_url", () => {
    const request = step({
      connector_id: CONNECTOR_ID,
      method: "POST",
      side_effects: "read",
      body: persisted,
    });
    expect(
      environmentMismatchRefusal(
        { slug: "github", environment: "dev", base_url: graphqlBaseUrl },
        request,
        "prod",
      )?.code,
    ).toBe("connector_environment_mismatch");
  });
});
