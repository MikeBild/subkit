import { describe, expect, test } from "bun:test";
import { probeGraphQLConnector } from "../graphql.ts";
import { probeConnector } from "../index.ts";
import {
  asOrigin,
  GRAPHQL_TENANT,
  graphqlConnector,
  recordingFetch,
  unusedGraphqlDb,
} from "./graphql-fixtures.ts";

type ProbeParams = Parameters<typeof probeGraphQLConnector>[0];

function probe(extra: Partial<ProbeParams>) {
  return asOrigin("self_hosted", () =>
    probeGraphQLConnector({
      db: unusedGraphqlDb,
      tenant_id: GRAPHQL_TENANT,
      connector: graphqlConnector(),
      ...extra,
    }),
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("graphql probe", () => {
  test("a __typename answer reports ok and sends the typename query", async () => {
    const { fetchImpl, requests } = recordingFetch(() => json({ data: { __typename: "Query" } }));
    const res = await probe({ fetchImpl });
    expect(requests[0]?.body).toEqual({ query: "{ __typename }", variables: {} });
    expect(res).toMatchObject({ ok: true, status: 200 });
    expect(res.error_code).toBeUndefined();
  });

  test("a 2xx answer without a string __typename is not ok", async () => {
    const { fetchImpl } = recordingFetch(() => json({ data: { __typename: 1 } }));
    const res = await probe({ fetchImpl });
    expect(res).toMatchObject({ ok: false, status: 200, detail: "HTTP 200" });
  });

  test("a typename on a 3xx answer is not ok", async () => {
    const { fetchImpl } = recordingFetch(() => json({ data: { __typename: "Query" } }, 304));
    const res = await probe({ fetchImpl });
    expect(res.ok).toBe(false);
  });

  test("an authentication error message on 200 is classified as an invalid credential", async () => {
    const { fetchImpl } = recordingFetch(() => json({ errors: [{ message: "Unauthorized" }] }));
    const res = await probe({ fetchImpl });
    expect(res).toMatchObject({
      ok: false,
      status: 200,
      detail: "Unauthorized",
      error_code: "credential_invalid",
    });
    expect(res.body_snippet).toContain("Unauthorized");
  });

  test.each([
    [401, "credential_invalid"],
    [404, "remote_resource_not_found"],
    [500, "unknown_upstream_error"],
  ])("HTTP %d without graphql errors is classified as %s", async (status, code) => {
    const { fetchImpl } = recordingFetch(() => json({}, status));
    const res = await probe({ fetchImpl });
    expect(res).toMatchObject({ ok: false, status, detail: `HTTP ${status}`, error_code: code });
  });

  test("a 501 answer reports the endpoint as not implemented", async () => {
    const { fetchImpl } = recordingFetch(() => json({}, 501));
    const res = await probe({ fetchImpl });
    expect(res).toMatchObject({
      ok: false,
      status: 501,
      detail: "graphql endpoint returned 501 (not implemented)",
      error_code: "unknown_upstream_error",
    });
  });

  test("a network failure is reported with its message", async () => {
    const fetchImpl = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    const res = await probe({ fetchImpl });
    expect(res).toMatchObject({
      ok: false,
      detail: "socket hang up",
      error_code: "unknown_upstream_error",
    });
  });

  test("an authenticated connector without a credential reports credential_missing without a request", async () => {
    const { fetchImpl, requests } = recordingFetch(() => json({ data: { __typename: "Query" } }));
    const res = await probe({
      fetchImpl,
      connector: graphqlConnector({ auth_type: "bearer" }),
      credential_override: null,
    });
    expect(requests).toHaveLength(0);
    expect(res).toEqual({
      ok: false,
      latency_ms: 0,
      detail: "credential_required",
      error_code: "credential_missing",
    });
  });

  test("an authenticated connector probes with the supplied credential", async () => {
    const { fetchImpl, requests } = recordingFetch(() => json({ data: { __typename: "Query" } }));
    const res = await probe({
      fetchImpl,
      connector: graphqlConnector({ auth_type: "bearer" }),
      credential_override: { mode: "bearer", token: "probe-token" },
    });
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer probe-token");
    expect(res.ok).toBe(true);
  });
});

describe("driver probe dispatch", () => {
  test("an unknown driver is reported without contacting anything", async () => {
    const res = await probeConnector({
      db: unusedGraphqlDb,
      tenant_id: GRAPHQL_TENANT,
      connector: graphqlConnector({ driver: "ftp" as never, enabled: true }),
    });
    expect(res).toEqual({ ok: false, latency_ms: 0, detail: "unknown driver: ftp" });
  });

  test("a disabled connector is never probed", async () => {
    const res = await probeConnector({
      db: unusedGraphqlDb,
      tenant_id: GRAPHQL_TENANT,
      connector: graphqlConnector({ enabled: false }),
    });
    expect(res.error_code).toBe("connector_disabled");
  });

  test("a graphql connector is probed by the graphql driver", async () => {
    const res = await asOrigin("self_service", () =>
      probeConnector({
        db: unusedGraphqlDb,
        tenant_id: GRAPHQL_TENANT,
        connector: graphqlConnector({ base_url: "http://10.0.0.7/graphql", enabled: true }),
      }),
    );
    expect(res).toMatchObject({ ok: false, error_code: "unknown_upstream_error" });
    expect(res.detail).toContain("private_ip_blocked");
  });
});
