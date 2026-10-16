import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PgBoss } from "pg-boss";
import { EngineClient } from "../../../../sk/src/engine-client.ts";
import type { AppSummary, AppView } from "../../api/app-schemas.ts";
import { flushOidcBearerKeys } from "../../auth/providers/oidc-bearer.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { loadConfig } from "../../config/loader.ts";
import {
  apiKeys,
  tenants,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createWorkflowRow } from "../../execution/tests/setup.ts";
import { generateKey as generateApiKey } from "../../identity/api-key.ts";
import { handleGetApp, handleListApps } from "../../mcp/tools/apps.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import {
  BEARER_NOW_SECONDS,
  startTestBearerIssuer,
  type TestBearerIssuer,
} from "../../test-helpers/oidc-bearer-issuer.ts";
import { previewWorkflowAuthority } from "../../workflows/execution-authorities.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
let issuer: TestBearerIssuer;
let brokenIssuer: TestBearerIssuer;
let assistantId: string;
let flowId: string;
let brokenId: string;
let foreignAssistantId: string;
let narrowKey: string;
const TENANT_SLUG = "t-apps-view";
const nextUuid = createDeterministicUuidFactory(517);

const fakeBoss = {
  send: async () => "queued",
} as unknown as PgBoss;

function token(sub: string) {
  return issuer.mint({ sub }, { issuedAt: BEARER_NOW_SECONDS, expiresIn: 10 * 365 * 24 * 3600 });
}

async function call(path: string, bearer: string | null, init: RequestInit = {}) {
  return fetch(`${ctx.baseUrl}${path}`, {
    ...init,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function run(bearer: string, turn_id: string, idempotency_key: string) {
  return call("/v1/executions", bearer, {
    method: "POST",
    body: JSON.stringify({
      workflow_id: assistantId,
      async: true,
      idempotency_key,
      input: { turn_id },
    }),
  });
}

beforeAll(async () => {
  ctx = await createHttpTestServer("apps-view", { appOptions: { boss: fakeBoss } });
  issuer = await startTestBearerIssuer();
  brokenIssuer = await startTestBearerIssuer();

  const assistant = await createWorkflowRow(ctx, {
    name: "apps-assistant",
    slug: "apps-assistant",
    product_id: "testapp",
    required_caller_kind: "user",
    execution_privacy: "sensitive",
    input_schema: {
      type: "object",
      required: ["turn_id"],
      properties: { turn_id: { type: "string" } },
    },
    steps: [{ id: "round", kind: "transform", expression: "return { done: true };" }],
    execution_guards: {
      caller_daily_limit: {
        bucket: "brain",
        limit: 5,
        tz: "Europe/Berlin",
        unit: "turn_id",
        billable_steps: ["round"],
        max_metered: 3,
        commit_when: "true",
      },
    },
  });
  assistantId = assistant.workflow_id;
  const preview = await previewWorkflowAuthority(
    {
      tenant_id: ctx.tenantId,
      workflow_id: assistant.workflow_id,
      workflow_version_id: assistant.version_id,
      execution_environment: "prod",
    },
    ctx.db,
  );
  await ctx.db.insert(workflowExecutionAuthorities).values({
    tenant_id: ctx.tenantId,
    workflow_id: assistant.workflow_id,
    workflow_version_id: assistant.version_id,
    effect_manifest_digest: preview.digest,
    effect_manifest: { ...preview.manifest },
    target_constraints: { targets: [] },
    execution_environment: "prod",
    valid_from: new Date(getTestNow() - 60_000),
    created_by: ctx.userId,
  });

  flowId = (
    await createWorkflowRow(ctx, {
      name: "apps-flow",
      slug: "apps-flow",
      product_id: "flowkit",
      steps: [{ id: "a", kind: "transform", expression: "return {};" }],
    })
  ).workflow_id;

  const [broken] = await ctx.db
    .insert(workflows)
    .values({
      tenant_id: ctx.tenantId,
      slug: "apps-broken",
      name: "apps-broken",
      lifecycle: "active",
    })
    .returning();
  if (!broken) throw new Error("broken workflow insert failed");
  brokenId = broken.id;
  const [brokenVersion] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: broken.id,
      version: 1,
      dag: { name: "apps-broken", product_id: "brokenkit", steps: [] },
    })
    .returning();
  if (!brokenVersion) throw new Error("broken version insert failed");
  const { eq } = await import("drizzle-orm");
  await ctx.db
    .update(workflows)
    .set({ current_version_id: brokenVersion.id })
    .where(eq(workflows.id, broken.id));

  const [other] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-apps-other", display_name: "Other" })
    .returning();
  if (!other) throw new Error("other tenant insert failed");
  const otherCtx = { ...ctx, tenantId: other.id };
  foreignAssistantId = (
    await createWorkflowRow(otherCtx, {
      name: "secret-flow",
      product_id: "secretkit",
      steps: [{ id: "a", kind: "transform", expression: "return {};" }],
    })
  ).workflow_id;

  const narrow = generateApiKey();
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    prefix: narrow.prefix,
    token_sha256: narrow.hash,
    scopes: ["identity:read"],
  });
  narrowKey = narrow.plaintext;

  const dir = mkdtempSync(join(tmpdir(), "sk-apps-config-"));
  const file = join(dir, "subkit.config.json");
  await writeFile(
    file,
    JSON.stringify({
      auth: {
        providers: [
          { protocol: "api_key", id: "api-key", label: "SubKit API key" },
          issuer.provider({ tenant_slug: TENANT_SLUG }),
          brokenIssuer.provider({
            id: "broken-bearer",
            label: "Broken",
            product_id: "brokenkit",
            tenant_slug: TENANT_SLUG,
          }),
          issuer.provider({
            id: "orphan-bearer",
            label: "Orphan",
            issuer_url: "https://orphan.example.test",
            product_id: "orphankit",
            tenant_slug: TENANT_SLUG,
          }),
          issuer.provider({
            id: "other-bearer",
            label: "Other",
            issuer_url: "https://other.example.test",
            product_id: "otherkit",
            tenant_slug: "t-apps-other",
          }),
        ],
        enable_signup: false,
      },
      products: {
        testapp: {
          execution_environment: "prod",
          assistant_workflow_id: assistantId,
          budget_bucket: "brain",
        },
        brokenkit: {
          execution_environment: "prod",
          assistant_workflow_id: brokenId,
          budget_bucket: "brain",
        },
        secretkit: {
          execution_environment: "prod",
          assistant_workflow_id: foreignAssistantId,
          budget_bucket: "brain",
        },
      },
    }),
  );
  flushOidcBearerKeys();
  await loadConfig({
    env: { DATABASE_URL: ctx.testDb.url, NODE_ENV: "test" },
    configPathOverride: file,
  });
}, 60_000);

afterAll(async () => {
  await issuer?.stop();
  await brokenIssuer?.stop();
  if (ctx) await ctx.cleanup();
}, 60_000);

interface Summary {
  id: string;
  configured: boolean;
  ready: boolean;
  failing_checks: string[];
  users: { count: number; last_seen_at: string | null };
  workflow_count: number;
}

describe("apps view over HTTP", () => {
  test("a product principal is refused and its sign-in shows up as an app user", async () => {
    const bearer = await token(nextUuid());
    expect((await call("/v1/apps", bearer)).status).toBe(403);
    expect((await call("/v1/apps/testapp", bearer)).status).toBe(403);
    const whoami = await json<{ product_id: string | null }>(
      await call("/v1/identity/whoami", bearer),
    );
    expect(whoami.product_id).toBe("testapp");
  });

  test("a credential without settings:read is refused", async () => {
    expect((await call("/v1/apps", narrowKey)).status).toBe(403);
    expect((await call("/v1/apps/testapp", narrowKey)).status).toBe(403);
    expect((await call("/v1/apps", null)).status).toBe(401);
  });

  test("the list shows exactly the apps this workspace can see", async () => {
    const res = await call("/v1/apps", ctx.apiKey);
    expect(res.status).toBe(200);
    const { items } = await json<{ items: Summary[] }>(res);
    expect(items.map((item) => item.id)).toEqual(["brokenkit", "flowkit", "orphankit", "testapp"]);
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get("testapp")).toMatchObject({
      configured: true,
      ready: true,
      failing_checks: [],
      workflow_count: 1,
      users: { count: 1 },
    });
    expect(byId.get("testapp")?.users.last_seen_at).not.toBeNull();
    expect(byId.get("orphankit")).toMatchObject({
      configured: false,
      ready: false,
      workflow_count: 0,
    });
    expect(byId.get("orphankit")?.failing_checks).toContain("product_configured");
    expect(byId.get("flowkit")?.failing_checks).toEqual([
      "product_configured",
      "sign_in_provider",
      "assistant_workflow",
      "execution_authority",
      "credentials",
      "budget_guard",
    ]);
  });

  test("another workspace's app answers 404", async () => {
    expect((await call("/v1/apps/secretkit", ctx.apiKey)).status).toBe(404);
    expect((await call("/v1/apps/otherkit", ctx.apiKey)).status).toBe(404);
    expect((await call("/v1/apps/nokit", ctx.apiKey)).status).toBe(404);
  });

  test("an invalid assistant version is reported as not ready instead of failing", async () => {
    const res = await call("/v1/apps/brokenkit", ctx.apiKey);
    expect(res.status).toBe(200);
    const view = await json<{
      workflows: Array<{ id: string; definition_valid: boolean; is_assistant: boolean }>;
      checks: Array<{ key: string; ok: boolean }>;
    }>(res);
    expect(view.workflows).toEqual([
      expect.objectContaining({ id: brokenId, definition_valid: false, is_assistant: true }),
    ]);
    expect(view.checks.find((item) => item.key === "assistant_workflow")?.ok).toBe(false);
    const bearer = await brokenIssuer.mint(
      { sub: nextUuid() },
      { issuedAt: BEARER_NOW_SECONDS, expiresIn: 10 * 365 * 24 * 3600 },
    );
    const health = await call("/v1/health", bearer);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      ok: false,
      version: "1",
      model: { id: null, status: "unchecked" },
      key: "missing",
    });
  });

  test("one app shows settings, sign-in without client secrets, workflows and today's budget", async () => {
    const bearer = await token(nextUuid());
    expect((await run(bearer, "apps-turn", "apps-turn:1")).status).toBe(202);
    expect((await run(bearer, "apps-turn", "apps-turn:2")).status).toBe(409);
    const res = await call("/v1/apps/testapp", ctx.apiKey);
    expect(res.status).toBe(200);
    const view = await json<Record<string, unknown>>(res);
    expect(view).toMatchObject({
      id: "testapp",
      configured: true,
      ready: true,
      settings: {
        execution_environment: "prod",
        budget_bucket: "brain",
        assistant_workflow: { id: assistantId, name: "apps-assistant", slug: "apps-assistant" },
        daily_limit: { bucket: "brain", limit_per_caller: 5, unit: "turn_id", tz: "Europe/Berlin" },
      },
      sign_in: [
        expect.objectContaining({
          id: "testapp-supabase",
          protocol: "oidc_bearer",
          tenant_slug: TENANT_SLUG,
          required_claims: [{ path: "role", equals: "authenticated" }],
        }),
      ],
      workflows: [
        expect.objectContaining({ id: assistantId, is_assistant: true, lifecycle: "active" }),
      ],
      budget_today: expect.objectContaining({
        bucket: "brain",
        tz: "Europe/Berlin",
        consumed: 0,
        reserved: 1,
        refusals_today: 1,
      }),
    });
    expect(view).not.toHaveProperty("failing_checks");
    expect((view.checks as Array<{ ok: boolean }>).every((item) => item.ok)).toBe(true);
  });

  test("users can be filtered by app and carry identities without the subject", async () => {
    const res = await call("/v1/identity/users?product_id=testapp", ctx.apiKey);
    expect(res.status).toBe(200);
    const body = await json<{
      items: Array<{ id: string; identities: Array<Record<string, unknown>> }>;
      total: number;
    }>(res);
    expect(body.total).toBe(2);
    for (const user of body.items) {
      expect(user.identities).toEqual([
        {
          provider_id: "testapp-supabase",
          product_id: "testapp",
          last_seen_at: expect.any(String),
        },
      ]);
    }
    const all = await json<{ items: Array<{ id: string; identities: unknown[] }> }>(
      await call("/v1/identity/users", ctx.apiKey),
    );
    expect(all.items.find((user) => user.id === ctx.userId)?.identities).toEqual([]);
    const detail = await json<{ identities: unknown[] }>(
      await call(`/v1/identity/users/${body.items[0]?.id}`, ctx.apiKey),
    );
    expect(detail.identities).toHaveLength(1);
    expect(
      (
        await json<{ total: number }>(
          await call("/v1/identity/users?product_id=flowkit", ctx.apiKey),
        )
      ).total,
    ).toBe(0);
    expect(
      (await json<{ product_id: string | null }>(await call("/v1/identity/whoami", ctx.apiKey)))
        .product_id,
    ).toBeNull();
  });

  test("an unknown flow app links its workflow", async () => {
    const view = await json<{ workflows: Array<{ id: string; is_assistant: boolean }> }>(
      await call("/v1/apps/flowkit", ctx.apiKey),
    );
    expect(view.workflows).toEqual([expect.objectContaining({ id: flowId, is_assistant: false })]);
  });
});

describe("apps view parity across surfaces", () => {
  function mcpContext() {
    const principal = {
      provider: "api-key",
      kind: "user",
      id: ctx.userId,
      tenant_id: ctx.tenantId,
      roles: ["admin"],
    } as ResolvedPrincipal;
    return { db: ctx.db, principal };
  }

  function wire<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  function client() {
    return new EngineClient({ engine_url: ctx.baseUrl, api_key: ctx.apiKey });
  }

  test("HTTP, MCP get_app and the sk client read equal values for every visible app", async () => {
    const http = await json<{ items: AppSummary[] }>(await call("/v1/apps", ctx.apiKey));
    const mcp = await handleListApps(mcpContext());
    expect(mcp.ok).toBe(true);
    if (!mcp.ok) return;
    expect(wire(mcp.data)).toEqual(http);
    expect(wire((await client().listApps()).items)).toEqual(http.items);

    for (const { id } of http.items) {
      const viaHttp = await json<AppView>(await call(`/v1/apps/${id}`, ctx.apiKey));
      const viaMcp = await handleGetApp(mcpContext(), { id });
      expect(viaMcp.ok).toBe(true);
      if (!viaMcp.ok) return;
      expect(wire(viaMcp.data)).toEqual(viaHttp);
      expect(wire(await client().getApp(id))).toEqual(viaHttp);
    }
  });

  test("a foreign or unknown product id is not found on every surface", async () => {
    for (const id of ["secretkit", "otherkit", "nokit"]) {
      expect((await call(`/v1/apps/${id}`, ctx.apiKey)).status).toBe(404);
      const viaMcp = await handleGetApp(mcpContext(), { id });
      expect(viaMcp).toMatchObject({ ok: false, error_code: "not_found" });
      await expect(client().getApp(id)).rejects.toMatchObject({ status: 404 });
    }
  });

  test("a malformed id is rejected by MCP and HTTP alike", async () => {
    expect(await handleGetApp(mcpContext(), { id: "Not Valid" })).toMatchObject({
      ok: false,
      error_code: "invalid_args",
    });
    expect(await handleGetApp(mcpContext(), {})).toMatchObject({
      ok: false,
      error_code: "invalid_args",
    });
    expect((await call("/v1/apps/Not%20Valid", ctx.apiKey)).status).toBe(400);
  });

  test("the orphan provider app fails readiness on every surface with the same checks", async () => {
    const viaHttp = await json<AppView>(await call("/v1/apps/orphankit", ctx.apiKey));
    const viaMcp = await handleGetApp(mcpContext(), { id: "orphankit" });
    expect(viaHttp.ready).toBe(false);
    expect(viaHttp.checks.find((c) => c.key === "product_configured")?.ok).toBe(false);
    if (!viaMcp.ok) throw new Error("get_app failed");
    expect(wire(viaMcp.data)).toEqual(viaHttp);
  });
});
