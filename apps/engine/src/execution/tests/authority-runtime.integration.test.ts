import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { upsertCredential } from "../../credentials/service.ts";
import {
  connectors,
  executionSteps,
  users,
  workflowExecutionAuthorities,
} from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { previewWorkflowAuthority } from "../../workflows/execution-authorities.ts";
import {
  admitAuthorizedWorkflowExecution,
  assertExecutionAuthorityCurrent,
} from "../authority-admission.ts";
import { callerFromPrincipal } from "../caller-context.ts";
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
        sub: "externally-reported-account",
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

async function fixture(
  driver: "http" | "graphql" | "s3" = "http",
  steps = 1,
  withOAuth = false,
  shape?: Record<string, unknown>,
  sensitive = false,
) {
  const slug = `authority-runtime-${++sequence}`;
  const db = ctx.testDb.db;
  let principal: ResolvedPrincipal | null = null;
  if (sensitive) {
    const roleId = await builtinRoleId(db, "member");
    const [person] = await db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: `${slug}@example.test`,
        role_id: roleId,
        status: "active",
      })
      .returning();
    if (!person) throw new Error("sensitive caller fixture missing");
    principal = {
      provider: "test",
      kind: "user",
      id: person.id,
      tenant_id: ctx.tenantId,
      roles: ["member"],
    };
  }
  const caller = callerFromPrincipal(principal, ctx.tenantId);
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
      ...(driver === "s3"
        ? {
            config: {
              endpoint: mock.baseUrl,
              bucket: "reports",
              region: "us-east-1",
              force_path_style: true,
            },
          }
        : {}),
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
        oauth2_expires_at: new Date(Date.now() + 30_000), // allow-wall-clock: actual OAuth refresh deadline
      },
      db,
    );
  }
  const workflow = await createWorkflowRow(ctx, {
    ...(sensitive ? { execution_privacy: "sensitive" } : {}),
    name: slug,
    slug,
    steps: Array.from({ length: steps }, (_, index) => ({
      id: `send${index}`,
      kind: "request",
      connector_id: connector.id,
      ...(index > 0 ? { depends_on: [`send${index - 1}`] } : {}),
      ...(shape
        ? shape
        : driver === "s3"
          ? {
              protocol: "s3",
              method: "PUT",
              body: "report",
              s3: {
                key: "${input.key}",
                scope: { key_prefix: "daily/", max_bytes: 1000 },
              },
            }
          : driver === "http"
            ? { method: "POST", path: "/messages", body: { recipient: "reviewed@example.test" } }
            : {
                protocol: "graphql",
                graphql: { operation: "mutation", query: "mutation { sendMessage { id } }" },
              }),
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
    admit(input: Record<string, unknown> = {}) {
      return admitAuthorizedWorkflowExecution(
        {
          tenant_id: ctx.tenantId,
          workflow_id: workflow.workflow_id,
          execution_environment: "dev",
          request_source: "api",
          input,
        },
        db,
        caller,
      );
    },
    async run(input: Record<string, unknown> = {}) {
      const admitted = await admitAuthorizedWorkflowExecution(
        {
          tenant_id: ctx.tenantId,
          workflow_id: workflow.workflow_id,
          execution_environment: "dev",
          request_source: "api",
          input,
        },
        db,
        caller,
      );
      return runExecution({
        db,
        tenant_id: ctx.tenantId,
        source: { kind: "saved", workflow_id: workflow.workflow_id },
        input,
        options: {
          existing_execution_id: admitted.execution_id,
          ...(principal ? { principal } : {}),
        },
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
  await expect(f.run()).rejects.toMatchObject({ code: "execution_authority_exhausted" });
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
  expect(result.steps[1]?.error).toMatchObject({ code: "execution_authority_revoked" });
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
  expect(result.steps[0]?.error).toMatchObject({ code: "execution_authority_revoked" });
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
    expect(result.steps[0]?.error).toMatchObject({ code: "execution_authority_changed" });
    expect(writes).toBe(0);
    const stored = await ctx.testDb.db
      .select()
      .from(executionSteps)
      .where(
        and(
          eq(executionSteps.tenant_id, ctx.tenantId),
          eq(executionSteps.execution_id, result.execution_id),
        ),
      );
    expect(stored.flatMap((row) => row.credential_snapshots)).toEqual([]);
    expect(
      stored.some(
        (row) =>
          (row.request_meta as { extras?: { effect_kind?: string } } | null)?.extras
            ?.effect_kind !== undefined,
      ),
    ).toBe(false);
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
    const result = await f.run();
    expect(result.status).toBe("succeeded");
    const stored = await ctx.testDb.db
      .select()
      .from(executionSteps)
      .where(
        and(
          eq(executionSteps.tenant_id, ctx.tenantId),
          eq(executionSteps.execution_id, result.execution_id),
        ),
      );
    expect(stored.flatMap((row) => row.credential_snapshots)).toEqual([
      expect.objectContaining({
        connector_id: f.connector.id,
        credential_generation: 2,
        identity: {
          issuer: oauth.baseUrl,
          subject: "externally-reported-account",
          source: "token_endpoint",
        },
      }),
    ]);
    expect(stored[0]?.request_meta).toMatchObject({ extras: { effect_kind: "write" } });
    expect(refreshes).toBe(before + 1);
    expect(writes).toBe(1);
  });
}

test("S3 runtime enforces the reviewed folder before any outbound write", async () => {
  const f = await fixture("s3");
  let requests = 0;
  mock.setHandler((_, res) => {
    requests++;
    res.writeHead(200, { etag: '"fixture"' });
    res.end();
  });
  expect((await f.run({ key: "daily/report.json" })).status).toBe("succeeded");
  expect(requests).toBe(1);
  const denied = await f.run({ key: "private/report.json" });
  expect(denied.status).toBe("failed");
  expect(requests).toBe(1);
});

test("an http boundary refuses an unreviewed target or an oversize body before any outbound request", async () => {
  const bounded = {
    method: "POST",
    path: "/sites/${input.site}/releases",
    body: { retire: "${input.ids}" },
    boundary: {
      variables: { "input.site": { enum: ["alpha"] } },
      max_body_bytes: 100,
      max_calls: 1,
    },
  };
  const reached: string[] = [];
  mock.setHandler((req, res) => {
    reached.push(`${req.method} ${req.url}`);
    jsonResponse(res, 200, { ok: true });
  });
  const target = await fixture("http", 1, false, bounded);
  expect((await target.run({ site: "alpha", ids: ["a"] })).status).toBe("succeeded");
  expect(reached).toEqual(["POST /endpoint/sites/alpha/releases"]);
  const elsewhere = await target.run({ site: "beta", ids: ["a"] });
  expect(elsewhere.status).toBe("failed");
  expect(elsewhere.steps[0]?.error).toMatchObject({ code: "request_outside_declared_boundary" });
  expect(reached).toHaveLength(1);

  const size = await fixture("http", 1, false, bounded);
  const oversize = await size.run({ site: "alpha", ids: "x".repeat(500) });
  expect(oversize.status).toBe("failed");
  expect(oversize.steps[0]?.error).toMatchObject({ code: "request_outside_declared_boundary" });
  expect(reached).toHaveLength(1);
  expect((await size.run({ site: "alpha", ids: ["b"] })).status).toBe("succeeded");
  expect(reached).toHaveLength(2);
});

test("the granted boundary is checked again at dispatch, independently of the step's own check", async () => {
  const f = await fixture("http", 1, false, {
    method: "POST",
    path: "/sites/${input.site}/releases",
    body: { retire: ["a"] },
    boundary: {
      variables: { "input.site": { enum: ["alpha"] } },
      max_body_bytes: 100,
      max_calls: 1,
    },
  });
  const manifest = f.authority.effect_manifest as {
    effects: Array<{ step_id: string; configuration_digest: string }>;
  };
  const effect = manifest.effects[0];
  if (!effect) throw new Error("missing granted effect");
  const admitted = await f.admit({ site: "alpha" });
  const check = (url: string, body: unknown) =>
    assertExecutionAuthorityCurrent(ctx.testDb.db, ctx.tenantId, admitted.execution_id, {
      step_id: effect.step_id,
      configuration_digest: effect.configuration_digest,
      credential_id: null,
      credential_revision: null,
      connection_authority: null,
      request: { method: "POST", url, headers: {}, body: body as never },
    });
  const granted = `${mock.baseUrl}/endpoint/sites/alpha/releases`;
  await expect(check(granted, { retire: ["a"] })).resolves.toBeDefined();
  await expect(check(`${mock.baseUrl}/endpoint/sites/beta/releases`, {})).rejects.toMatchObject({
    code: "execution_authority_changed",
  });
  await expect(check(granted, { retire: "x".repeat(500) })).rejects.toMatchObject({
    code: "execution_authority_changed",
  });
});

test("sensitive steps retain verified credential attribution and only the connector reference", async () => {
  refreshedScope = "write";
  const f = await fixture("http", 1, true, undefined, true);
  mock.setHandler((_, res) => jsonResponse(res, 200, { ok: true }));
  const result = await f.run();
  expect(result.status).toBe("succeeded");
  const [stored] = await ctx.testDb.db
    .select()
    .from(executionSteps)
    .where(
      and(
        eq(executionSteps.tenant_id, ctx.tenantId),
        eq(executionSteps.execution_id, result.execution_id),
      ),
    );
  expect(stored?.request_meta).toEqual({
    driver: "sensitive",
    connector: { connector_id: expect.any(String), connector_slug: expect.any(String) },
  });
  expect(stored?.credential_snapshots).toEqual([
    expect.objectContaining({
      credential_generation: 2,
      identity: {
        issuer: oauth.baseUrl,
        subject: "externally-reported-account",
        source: "token_endpoint",
      },
    }),
  ]);
});
