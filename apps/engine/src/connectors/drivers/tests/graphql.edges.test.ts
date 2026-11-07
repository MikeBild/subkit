import { describe, expect, spyOn, test } from "bun:test";
import type { ConnectorOperationError } from "@shared/index.ts";
import { exportPKCS8, generateKeyPair } from "jose";
import { logger } from "../../../logging/logger.ts";
import { probeGraphQLConnector, query } from "../graphql.ts";
import { HttpRequestInvalidError } from "../http.ts";
import {
  asOrigin,
  GRAPHQL_TENANT,
  graphqlConnector,
  recordingFetch,
  unusedGraphqlDb,
} from "./graphql-fixtures.ts";

type QueryParams = Parameters<typeof query>[0];

function run(extra: Partial<QueryParams>) {
  return asOrigin("self_hosted", () =>
    query({
      db: unusedGraphqlDb,
      tenant_id: GRAPHQL_TENANT,
      connector: graphqlConnector(),
      query: "{ a }",
      ...extra,
    }),
  );
}

describe("graphql operation names", () => {
  test.each([
    ["  query   Spaced { a }", "Spaced"],
    ["\nmutation Save($x: Int) { save(x: $x) }", "Save"],
    ["{ a } query NotLeading { b }", "query"],
    ["queryNamed { a }", "query"],
  ])("%p is named %p", async (document, expected) => {
    const { fetchImpl } = recordingFetch(() => Response.json({ data: {} }));
    const res = await run({ fetchImpl, query: document });
    expect(res.operation_name).toBe(expected);
  });

  test("an omitted operation kind defaults to query", async () => {
    const { fetchImpl } = recordingFetch(() => Response.json({ data: {} }));
    const res = await run({ fetchImpl });
    expect(res.operation_name).toBe("query");
  });
});

describe("graphql request validation", () => {
  test("a header conflict names the headers field", async () => {
    const { fetchImpl } = recordingFetch(() => Response.json({ data: {} }));
    const error = (await run({ fetchImpl, extra_headers: { cookie: "a=b" } }).catch(
      (caught: unknown) => caught,
    )) as HttpRequestInvalidError;
    expect(error.message).toBe("request headers conflict with connector authentication");
    expect(error.path).toBe("headers");
  });

  test("a default header whose name is not an RFC 7230 token is refused before any request", async () => {
    const { fetchImpl, requests } = recordingFetch(() => Response.json({ data: {} }));
    const error = await run({
      fetchImpl,
      connector: graphqlConnector({ config: { default_headers: { "bad header": "v" } } }),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpRequestInvalidError);
    expect(requests).toHaveLength(0);
  });

  test("default headers that are not an object are ignored", async () => {
    const { fetchImpl, requests } = recordingFetch(() => Response.json({ data: {} }));
    await run({ fetchImpl, connector: graphqlConnector({ config: { default_headers: "x" } }) });
    expect(requests[0]?.headers.get("0")).toBeNull();
  });

  test("a cross-origin endpoint error carries the connector id", async () => {
    const error = (await run({ endpoint: "https://elsewhere.example/graphql" }).catch(
      (caught: unknown) => caught,
    )) as ConnectorOperationError;
    expect(error.metadata).toEqual({ connector_id: "00000000-0000-4000-8000-0000000000c2" });
  });
});

describe("graphql response handling", () => {
  test("a literal null string in the response is kept when no token was signed", async () => {
    const { fetchImpl } = recordingFetch(() => Response.json({ data: { v: "null" } }));
    const res = await run({ fetchImpl });
    expect(res.body).toEqual({ data: { v: "null" } });
  });

  test("at most five graphql error messages are logged", async () => {
    const warnings: Array<Record<string, unknown>> = [];
    const warn = spyOn(logger, "warn").mockImplementation((entry: unknown) => {
      warnings.push(entry as Record<string, unknown>);
    });
    try {
      const errors = ["1", "2", "3", "4", "5", "6"].map((message) => ({ message }));
      const { fetchImpl } = recordingFetch(() => Response.json({ errors }));
      const res = await run({ fetchImpl });
      expect(warnings[0]?.error_messages).toEqual(["1", "2", "3", "4", "5"]);
      expect((res.body as { errors: unknown[] }).errors).toHaveLength(6);
    } finally {
      warn.mockRestore();
    }
  });

  test("durations are measured from the start of the call", async () => {
    const { fetchImpl } = recordingFetch(() => Response.json({ data: {} }));
    const done = await run({ fetchImpl });
    const refused = await run({ fetchImpl, operation: "subscription" });
    for (const res of [done, refused]) {
      expect(res.duration_ms).toBeGreaterThanOrEqual(0);
      expect(res.duration_ms).toBeLessThan(60_000);
    }
  });

  test("a signed_jwt credential never follows redirects, even without a dispatch policy", async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    const privateKey = await exportPKCS8(pair.privateKey);
    const { fetchImpl, requests } = recordingFetch(
      () => new Response(null, { status: 302, headers: { location: "https://93.184.216.34/x" } }),
    );
    const error = await run({
      fetchImpl,
      connector: graphqlConnector({
        auth_type: "signed_jwt",
        config: { signed_jwt: { algorithm: "ES256", audience: "fixture" } },
      }),
      credential_override: { mode: "signed_jwt", private_key: privateKey },
      before_dispatch: async () => undefined,
    }).catch((caught: unknown) => caught);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.init.redirect).toBe("manual");
    expect((error as Error).message).toContain("requires separate authorization");
  });
});

describe("graphql probe edges", () => {
  function probe(status: number, body: unknown) {
    const { fetchImpl } = recordingFetch(() => Response.json(body, { status }));
    return asOrigin("self_hosted", () =>
      probeGraphQLConnector({
        db: unusedGraphqlDb,
        tenant_id: GRAPHQL_TENANT,
        connector: graphqlConnector(),
        fetchImpl,
      }),
    );
  }

  test("a typename answered with status 300 is not ok", async () => {
    const res = await probe(300, { data: { __typename: "Query" } });
    expect(res.ok).toBe(false);
  });

  test("probe latency is measured from the start of the probe", async () => {
    const ok = await probe(200, { data: { __typename: "Query" } });
    const failed = await probe(500, {});
    const fetchImpl = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const thrown = await asOrigin("self_hosted", () =>
      probeGraphQLConnector({
        db: unusedGraphqlDb,
        tenant_id: GRAPHQL_TENANT,
        connector: graphqlConnector(),
        fetchImpl,
      }),
    );
    const notImplemented = await probe(501, {});
    for (const res of [ok, failed, thrown, notImplemented]) {
      expect(res.latency_ms).toBeGreaterThanOrEqual(0);
      expect(res.latency_ms).toBeLessThan(60_000);
    }
  });
});
