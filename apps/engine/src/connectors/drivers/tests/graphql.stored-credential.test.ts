import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { upsertCredential } from "../../../credentials/service.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { seedTenant } from "../../../test-helpers/seed.ts";
import { createConnector, getConnector } from "../../service.ts";
import type { ConnectorView } from "../../types.ts";
import { probeGraphQLConnector, query } from "../graphql.ts";
import { asOrigin, GRAPHQL_ENDPOINT, recordingFetch } from "./graphql-fixtures.ts";

let ctx: TestDb;
let tenantA: string;
let tenantB: string;
let withCredential: ConnectorView;
let withoutCredential: ConnectorView;

async function seedConnector(tenant_id: string, name: string): Promise<ConnectorView> {
  const created = await createConnector(
    {
      tenant_id,
      input: {
        name,
        driver: "graphql",
        environment: "dev",
        base_url: GRAPHQL_ENDPOINT,
        auth_type: "bearer",
        config: {},
      },
      actor_id: null,
    },
    ctx.db,
  );
  const view = await getConnector(tenant_id, created.id, ctx.db);
  if (!view) throw new Error("connector_fixture_missing");
  return view;
}

beforeAll(async () => {
  ctx = await createTestDb("graphql-stored-credential");
  tenantA = (await seedTenant(ctx.db, { slug: "graphql-cred-a", display_name: "GraphQL A" })).id;
  tenantB = (await seedTenant(ctx.db, { slug: "graphql-cred-b", display_name: "GraphQL B" })).id;
  withCredential = await seedConnector(tenantA, "graphql-with-credential");
  withoutCredential = await seedConnector(tenantA, "graphql-without-credential");
  await upsertCredential(
    {
      tenant_id: tenantA,
      connector_id: withCredential.id,
      environment: "dev",
      mode: "bearer",
      value: { mode: "bearer", token: "stored-graphql-token" },
      actor_id: null,
    },
    ctx.db,
  );
});

afterAll(async () => {
  await ctx.cleanup();
});

function ok(): Response {
  return Response.json({ data: { __typename: "Query" } });
}

describe("graphql stored credentials", () => {
  test("the stored bearer token is applied and reported as a stored credential use", async () => {
    const { fetchImpl, requests } = recordingFetch(ok);
    const res = await asOrigin("self_hosted", () =>
      query({
        db: ctx.db,
        tenant_id: tenantA,
        connector: withCredential,
        query: "{ __typename }",
        fetchImpl,
      }),
    );
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer stored-graphql-token");
    expect(res.credential_id).toEqual(expect.any(String));
    expect(res.stored_credential_used).toBe(true);
    expect(res.auth_method).toBe("bearer");
  });

  test("another tenant addressing the same connector id gets no credential", async () => {
    const { fetchImpl, requests } = recordingFetch(ok);
    const res = await asOrigin("self_hosted", () =>
      query({
        db: ctx.db,
        tenant_id: tenantB,
        connector: { ...withCredential, tenant_id: tenantB },
        query: "{ __typename }",
        fetchImpl,
      }),
    );
    expect(requests[0]?.headers.get("authorization")).toBeNull();
    expect(res.credential_id).toBeNull();
    expect(res.stored_credential_used).toBe(false);
  });

  test("a connector without a stored credential probes as credential_missing without a request", async () => {
    const { fetchImpl, requests } = recordingFetch(ok);
    const res = await asOrigin("self_hosted", () =>
      probeGraphQLConnector({
        db: ctx.db,
        tenant_id: tenantA,
        connector: withoutCredential,
        fetchImpl,
      }),
    );
    expect(requests).toHaveLength(0);
    expect(res.error_code).toBe("credential_missing");
  });

  test("the other tenant cannot probe with tenant A's stored credential", async () => {
    const { fetchImpl, requests } = recordingFetch(ok);
    const res = await asOrigin("self_hosted", () =>
      probeGraphQLConnector({
        db: ctx.db,
        tenant_id: tenantB,
        connector: { ...withCredential, tenant_id: tenantB },
        fetchImpl,
      }),
    );
    expect(requests).toHaveLength(0);
    expect(res.error_code).toBe("credential_missing");
  });

  test("a stored credential probe succeeds with the stored token", async () => {
    const { fetchImpl, requests } = recordingFetch(ok);
    const res = await asOrigin("self_hosted", () =>
      probeGraphQLConnector({
        db: ctx.db,
        tenant_id: tenantA,
        connector: withCredential,
        fetchImpl,
      }),
    );
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer stored-graphql-token");
    expect(res.ok).toBe(true);
  });

  test("before_dispatch receives the stored credential identity and snapshot", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { fetchImpl } = recordingFetch(ok);
    const res = await asOrigin("self_hosted", () =>
      query({
        db: ctx.db,
        tenant_id: tenantA,
        connector: withCredential,
        query: "{ __typename }",
        fetchImpl,
        before_dispatch: async (credential) => {
          seen.push(credential as Record<string, unknown>);
          return undefined;
        },
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.credential_id).toBe(res.credential_id);
    expect(seen[0]?.credential_snapshot).toMatchObject({
      connector_id: withCredential.id,
      environment: "dev",
      credential_id: res.credential_id,
    });
  });
});
