import { describe, expect, spyOn, test } from "bun:test";
import { ConnectorOperationError } from "@shared/index.ts";
import { logger } from "../../../logging/index.ts";
import { withDriverFetchForTests } from "../../../test-helpers/driver-fetch.ts";
import { graphqlErrorMessages, query } from "../graphql.ts";
import { HttpRequestInvalidError } from "../http.ts";
import {
  asOrigin,
  GRAPHQL_ENDPOINT,
  GRAPHQL_TENANT,
  graphqlConnector,
  recordingFetch,
  unusedGraphqlDb,
} from "./graphql-fixtures.ts";

type QueryParams = Parameters<typeof query>[0];

function run(extra: Partial<QueryParams>, origin: "self_hosted" | "self_service" = "self_hosted") {
  return asOrigin(origin, () =>
    query({
      db: unusedGraphqlDb,
      tenant_id: GRAPHQL_TENANT,
      connector: graphqlConnector(),
      query: "query Viewer { viewer { id } }",
      ...extra,
    }),
  );
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("graphql request shaping", () => {
  test("posts the query with empty variables and JSON headers to the endpoint", async () => {
    const { fetchImpl, requests } = recordingFetch(() => json({ data: { viewer: { id: "1" } } }));
    const res = await run({ fetchImpl });
    expect(requests).toHaveLength(1);
    const sent = requests[0];
    expect(sent?.url.href).toBe(GRAPHQL_ENDPOINT);
    expect(sent?.init.method).toBe("POST");
    expect(sent?.headers.get("content-type")).toBe("application/json");
    expect(sent?.headers.get("accept")).toBe("application/json");
    expect(sent?.body).toEqual({ query: "query Viewer { viewer { id } }", variables: {} });
    expect(res).toMatchObject({
      status: 200,
      body: { data: { viewer: { id: "1" } } },
      operation_name: "Viewer",
      credential_id: null,
      auth_method: "none",
      stored_credential_used: false,
    });
  });

  test("passes variables through and names anonymous operations after their kind", async () => {
    const { fetchImpl, requests } = recordingFetch(() => json({ data: {} }));
    const res = await run({
      fetchImpl,
      query: "{ createThing(name: $name) { id } }",
      operation: "mutation",
      variables: { name: "a'b" },
    });
    expect(requests[0]?.body.variables).toEqual({ name: "a'b" });
    expect(res.operation_name).toBe("mutation");
  });

  test("applies configured default headers and caller headers", async () => {
    const { fetchImpl, requests } = recordingFetch(() => json({ data: {} }));
    await run({
      fetchImpl,
      connector: graphqlConnector({ config: { default_headers: { "x-api-version": "7" } } }),
      extra_headers: { "x-request-tag": "nightly" },
    });
    expect(requests[0]?.headers.get("x-api-version")).toBe("7");
    expect(requests[0]?.headers.get("x-request-tag")).toBe("nightly");
  });

  test("a caller header cannot override a configured default header", async () => {
    const { fetchImpl, requests } = recordingFetch(() => json({ data: {} }));
    const error = await run({
      fetchImpl,
      connector: graphqlConnector({ config: { default_headers: { "x-api-version": "7" } } }),
      extra_headers: { "X-Api-Version": "8" },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpRequestInvalidError);
    expect(requests).toHaveLength(0);
  });

  test("a caller Authorization header is refused when the connector owns authentication", async () => {
    const { fetchImpl, requests } = recordingFetch(() => json({ data: {} }));
    const error = await run({
      fetchImpl,
      connector: graphqlConnector({ auth_type: "bearer" }),
      credential_override: { mode: "bearer", token: "stored-token" },
      extra_headers: { authorization: "Bearer caller" },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpRequestInvalidError);
    expect(requests).toHaveLength(0);
  });

  test("a caller Authorization header is forwarded when the connector has no authentication", async () => {
    const { fetchImpl, requests } = recordingFetch(() => json({ data: {} }));
    await run({ fetchImpl, extra_headers: { authorization: "Bearer caller" } });
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer caller");
  });

  test("a bearer credential is sent as an Authorization header", async () => {
    const { fetchImpl, requests } = recordingFetch(() => json({ data: {} }));
    const res = await run({
      fetchImpl,
      connector: graphqlConnector({ auth_type: "bearer" }),
      credential_override: { mode: "bearer", token: "stored-token" },
    });
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer stored-token");
    expect(res.auth_method).toBe("bearer");
    expect(res.stored_credential_used).toBe(false);
  });

  test("a query credential and static query parameters are added to the URL", async () => {
    const { fetchImpl, requests } = recordingFetch(() => json({ data: {} }));
    await run({
      fetchImpl,
      connector: graphqlConnector({ auth_type: "query", config: { static_query: { v: "2" } } }),
      credential_override: { mode: "query", query: { api_key: "k-1" } },
    });
    expect(requests[0]?.url.searchParams.get("api_key")).toBe("k-1");
    expect(requests[0]?.url.searchParams.get("v")).toBe("2");
  });

  test("an endpoint override on the same origin is used", async () => {
    const { fetchImpl, requests } = recordingFetch(() => json({ data: {} }));
    await asOrigin("self_hosted", () =>
      query({
        db: unusedGraphqlDb,
        tenant_id: GRAPHQL_TENANT,
        connector: graphqlConnector(),
        endpoint: "https://93.184.216.34/v2/graphql",
        query: "{ a }",
        fetchImpl,
      }),
    );
    expect(requests[0]?.url.pathname).toBe("/v2/graphql");
  });

  test("an endpoint override on another origin is refused before any request", async () => {
    const { fetchImpl, requests } = recordingFetch(() => json({ data: {} }));
    const error = await run({ fetchImpl, endpoint: "https://evil.example/graphql" }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ConnectorOperationError);
    expect((error as ConnectorOperationError).code).toBe("graphql_endpoint_invalid");
    expect(requests).toHaveLength(0);
  });

  test("a connector without base_url is refused", async () => {
    const { fetchImpl, requests } = recordingFetch(() => json({ data: {} }));
    const error = await run({ fetchImpl, connector: graphqlConnector({ base_url: null }) }).catch(
      (caught: unknown) => caught,
    );
    expect((error as Error).message).toContain("missing base_url");
    expect(requests).toHaveLength(0);
  });

  test("subscriptions answer 501 without contacting the endpoint", async () => {
    const { fetchImpl, requests } = recordingFetch(() => json({ data: {} }));
    const res = await run({
      fetchImpl,
      operation: "subscription",
      query: "subscription OnEvent { event { id } }",
    });
    expect(requests).toHaveLength(0);
    expect(res).toMatchObject({
      status: 501,
      body: { error: { code: "not_implemented" } },
      operation_name: "OnEvent",
      credential_id: null,
      auth_method: "none",
      stored_credential_used: false,
    });
  });
});

describe("graphql response mapping", () => {
  test("a non-JSON body is returned as data text with headers and byte count", async () => {
    const { fetchImpl } = recordingFetch(
      () => new Response("plain ü", { status: 502, headers: { "x-upstream": "edge" } }),
    );
    const res = await run({ fetchImpl });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ data: "plain ü" });
    expect(res.headers["x-upstream"]).toBe("edge");
    expect(res.bytes_in).toBe(8);
  });

  test("an empty body maps to an empty object", async () => {
    const { fetchImpl } = recordingFetch(() => new Response(""));
    const res = await run({ fetchImpl });
    expect(res.body).toEqual({});
    expect(res.bytes_in).toBe(0);
  });

  test("graphql errors on a 200 answer are logged with their messages", async () => {
    const warnings: Array<Record<string, unknown>> = [];
    const warn = spyOn(logger, "warn").mockImplementation((entry: unknown) => {
      warnings.push(entry as Record<string, unknown>);
    });
    try {
      const { fetchImpl } = recordingFetch(() =>
        json({ errors: [{ message: "field missing" }, { extensions: {} }] }),
      );
      const res = await run({ fetchImpl });
      expect(res.status).toBe(200);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        action: "graphql.request.error",
        status: 200,
        has_graphql_errors: true,
        error_messages: ["field missing", "graphql error"],
      });
    } finally {
      warn.mockRestore();
    }
  });

  test("an HTTP error without graphql errors is logged once", async () => {
    const warnings: Array<Record<string, unknown>> = [];
    const warn = spyOn(logger, "warn").mockImplementation((entry: unknown) => {
      warnings.push(entry as Record<string, unknown>);
    });
    try {
      const { fetchImpl } = recordingFetch(() => json({ data: null }, { status: 400 }));
      await run({ fetchImpl });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ status: 400, has_graphql_errors: false });
    } finally {
      warn.mockRestore();
    }
  });

  test("a clean 200 answer logs no warning", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const { fetchImpl } = recordingFetch(() => json({ data: { a: 1 } }));
      await run({ fetchImpl });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("graphqlErrorMessages ignores missing and empty error lists", () => {
    expect(graphqlErrorMessages(null)).toBeNull();
    expect(graphqlErrorMessages({ errors: [] })).toBeNull();
    expect(graphqlErrorMessages({ errors: "boom" })).toBeNull();
    expect(graphqlErrorMessages({ errors: [null, { message: "" }, { message: "x" }] })).toEqual([
      "graphql error",
      "graphql error",
      "x",
    ]);
  });
});

describe("graphql egress and dispatch policy", () => {
  test("a private endpoint is refused in strict mode before any request", async () => {
    const { fetchImpl, requests } = recordingFetch(() => json({ data: {} }));
    const error = await run(
      { fetchImpl, connector: graphqlConnector({ base_url: "http://10.0.0.7/graphql" }) },
      "self_service",
    ).catch((caught: unknown) => caught);
    expect((error as Error).message).toContain("private_ip_blocked");
    expect(requests).toHaveLength(0);
  });

  test("before_dispatch sees the credential identity and its redirect policy is applied", async () => {
    const seen: unknown[] = [];
    const { fetchImpl, requests } = recordingFetch(
      () => new Response(null, { status: 302, headers: { location: "https://93.184.216.34/x" } }),
    );
    const error = await run({
      fetchImpl,
      before_dispatch: async (credential) => {
        seen.push(credential);
        return { redirect: "manual" };
      },
    }).catch((caught: unknown) => caught);
    expect(seen).toEqual([
      { credential_id: null, credential_revision: null, connection_authority: null },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.init.redirect).toBe("manual");
    expect((error as Error).message).toContain("requires separate authorization");
  });

  test("without a dispatch policy the redirect mode is left to the guard", async () => {
    const { fetchImpl, requests } = recordingFetch(() => json({ data: {} }));
    await run({ fetchImpl });
    expect(requests[0]?.init.redirect).toBeUndefined();
  });

  test("without an injected fetch the request goes through the driver fetch seam", async () => {
    const { fetchImpl, requests } = recordingFetch(() => json({ data: { ok: true } }));
    const res = await withDriverFetchForTests(fetchImpl, () =>
      run({ connector: graphqlConnector({ base_url: "http://127.0.0.1:1/graphql" }) }),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.href).toBe("http://127.0.0.1:1/graphql");
    expect(res.body).toEqual({ data: { ok: true } });
  });
});
