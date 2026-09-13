import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { upsertCredential } from "../../credentials/service.ts";
import { connectors, workflowExecutionAuthorities } from "../../db/schema/index.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { previewWorkflowAuthority } from "../../workflows/execution-authorities.ts";
import { admitAuthorizedWorkflowExecution } from "../authority-admission.ts";
import { runExecution } from "../engine.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "./setup.ts";

let ctx: EngineTestCtx;
let mock: MockServer;
let oauth: MockServer;
let refreshedScope = "write";
let refreshes = 0;
let sequence = 0;
const actor = "00000000-0000-4000-8000-000000000001";

beforeAll(async () => {
  ctx = await createEngineCtx("authority-runtime");
  mock = await createMockServer((_, res) => jsonResponse(res, 200, { ok: true }));
  oauth = await createMockServer((req, res) => {
    if (req.url === "/.well-known/openid-configuration") {
      jsonResponse(res, 200, {
        issuer: oauth.baseUrl,
        authorization_endpoint: `${oauth.baseUrl}/authorize`,
        token_endpoint: `${oauth.baseUrl}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["refresh_token"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      });
    } else if (req.url === "/token" && req.method === "POST") {
      refreshes++;
      jsonResponse(res, 200, {
        access_token: `refreshed-${refreshes}`,
        refresh_token: "refresh-fixture",
        token_type: "Bearer",
        scope: refreshedScope,
        expires_in: 3600,
      });
    } else jsonResponse(res, 404, { error: "unknown fixture endpoint" });
  });
});
afterAll(async () => {
  await mock.close();
  await oauth.close();
  await ctx.cleanup();
});

async function fixture(driver: "http" | "graphql" = "http", steps = 1, withOAuth = false) {
  const slug = `authority-runtime-${++sequence}`;
  const db = ctx.testDb.db;
  const [connector] = await db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug,
      display_name: slug,
      driver,
      auth_type: withOAuth ? "oauth2" : "none",
      environment: "dev",
      base_url: `${mock.baseUrl}/endpoint`,
      ...(withOAuth
        ? {
            config: {
              oauth: {
                issuer_url: oauth.baseUrl,
                client_id: "authority-fixture",
                client_secret: "fixture-only-secret",
                scope: "write",
              },
            },
          }
        : {}),
    })
    .returning();
  if (!connector) throw new Error("missing connector fixture");
  if (withOAuth) {
    await upsertCredential(
      {
        tenant_id: ctx.tenantId,
        connector_id: connector.id,
        environment: "dev",
        mode: "oauth2",
        actor_id: null,
        value: {
          mode: "oauth2",
          access_token: "initial-fixture",
          token_type: "Bearer",
          scope: "write",
        },
        oauth2_refresh_token: "refresh-fixture",
        // Fresh enough for admission, but inside the inline refresh lead window.
        oauth2_expires_at: new Date(Date.now() + 30_000), // allow-wall-clock: actual OAuth refresh deadline
      },
      db,
    );
  }
  const workflow = await createWorkflowRow(ctx, {
    name: slug,
    slug,
    steps: Array.from({ length: steps }, (_, index) => ({
      id: `send${index}`,
      kind: "request",
      connector_id: connector.id,
      ...(index > 0 ? { depends_on: [`send${index - 1}`] } : {}),
      ...(driver === "http"
        ? { method: "POST", path: "/messages", body: { recipient: "reviewed@example.test" } }
        : { graphql: { operation: "mutation", query: "mutation { sendMessage { id } }" } }),
      max_retries: 2,
      retry_backoff_ms: 50,
    })),
  });
  const preview = await previewWorkflowAuthority(
    {
      tenant_id: ctx.tenantId,
      workflow_id: workflow.workflow_id,
      workflow_version_id: workflow.version_id,
      execution_environment: "dev",
    },
    db,
  );
  expect(preview.eligible_for_repeated_runs).toBe(true);
  const now = await databaseNow(db);
  // Human consent is covered by the grant service and HTTP tests. Install
  // its exact server-resolved result here to exercise real outbound dispatch.
  const [authority] = await db
    .insert(workflowExecutionAuthorities)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: workflow.workflow_id,
      workflow_version_id: workflow.version_id,
      effect_manifest_digest: preview.digest,
      effect_manifest: { ...preview.manifest },
      target_constraints: {
        targets: preview.manifest.effects.flatMap((effect) =>
          effect.target ? [effect.target] : [],
        ),
      },
      execution_environment: "dev",
      valid_from: new Date(now.getTime() - 60_000),
      valid_until: new Date(now.getTime() + 60 * 60_000),
      max_runs: 2,
      created_by: actor,
    })
    .returning();
  if (!authority) throw new Error("missing authority fixture");
  return {
    authority,
    connector,
    async run() {
      const admitted = await admitAuthorizedWorkflowExecution(
        {
          tenant_id: ctx.tenantId,
          workflow_id: workflow.workflow_id,
          execution_environment: "dev",
          request_source: "api",
          input: {},
        },
        db,
      );
      return runExecution({
        db,
        tenant_id: ctx.tenantId,
        source: { kind: "saved", workflow_id: workflow.workflow_id },
        input: {},
        options: { existing_execution_id: admitted.execution_id },
      });
    },
    async revoke() {
      await db
        .update(workflowExecutionAuthorities)
        .set({ revoked_at: await databaseNow(db), revoked_by: actor })
        .where(eq(workflowExecutionAuthorities.id, authority.id));
    },
  };
}

test("two authorized runs reach the remote without another grant, including the last reservation", async () => {
  const f = await fixture();
  let requests = 0;
  mock.setHandler((_, res) => {
    requests++;
    jsonResponse(res, 200, { ok: true });
  });
  expect((await f.run()).status).toBe("succeeded");
  expect((await f.run()).status).toBe("succeeded");
  await expect(f.run()).rejects.toMatchObject({ code: "execution_authority_unavailable" });
  expect(requests).toBe(2);
});

test("revocation after the first write prevents the next step from reaching the remote", async () => {
  const f = await fixture("http", 2);
  let requests = 0;
  mock.setHandler(async (_, res) => {
    requests++;
    await f.revoke();
    jsonResponse(res, 200, { ok: true });
  });
  const result = await f.run();
  expect(result.status).toBe("failed");
  expect(result.steps[0]?.status).toBe("succeeded");
  expect(result.steps[1]?.error).toMatchObject({ code: "authority_invalid" });
  expect(requests).toBe(1);
});

test("a GraphQL retry rechecks authority and does not send after revocation", async () => {
  const f = await fixture("graphql");
  let requests = 0;
  mock.setHandler(async (_, res) => {
    requests++;
    await f.revoke();
    res.setHeader("Retry-After", "0");
    jsonResponse(res, 429, { errors: [{ message: "throttled" }] });
  });
  const result = await f.run();
  expect(result.status).toBe("failed");
  expect(result.steps[0]?.error).toMatchObject({ code: "authority_invalid" });
  expect(requests).toBe(1);
});

for (const driver of ["http", "graphql"] as const) {
  test(`${driver}: a scope change during inline token refresh blocks the business request`, async () => {
    refreshedScope = "write admin";
    const f = await fixture(driver, 1, true);
    const before = refreshes;
    let writes = 0;
    mock.setHandler((_, res) => {
      writes++;
      jsonResponse(res, 200, { data: { sendMessage: { id: "fixture" } } });
    });
    const result = await f.run();
    expect(refreshes).toBe(before + 1);
    expect(result.status).toBe("failed");
    expect(result.steps[0]?.error).toMatchObject({ code: "authority_invalid" });
    expect(writes).toBe(0);
  });

  test(`${driver}: routine token refresh with unchanged scopes preserves authority`, async () => {
    refreshedScope = "write";
    const f = await fixture(driver, 1, true);
    const before = refreshes;
    let writes = 0;
    mock.setHandler((_, res) => {
      writes++;
      jsonResponse(res, 200, { data: { sendMessage: { id: "fixture" } } });
    });
    expect((await f.run()).status).toBe("succeeded");
    expect(refreshes).toBe(before + 1);
    expect(writes).toBe(1);
  });
}
