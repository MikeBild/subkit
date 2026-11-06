import { describe, expect, test } from "bun:test";
import { EngineClient } from "../../../../sk/src/engine-client.ts";
import type { AppSummary, AppView } from "../../api/app-schemas.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { handleGetApp, handleListApps } from "../../mcp/tools/apps.ts";
import { BEARER_NOW_SECONDS } from "../../test-helpers/oidc-bearer-issuer.ts";
import {
  assistantId,
  brokenId,
  brokenIssuer,
  call,
  ctx,
  flowId,
  json,
  narrowKey,
  nextUuid,
  run,
  type Summary,
  setupAppsHttp,
  TENANT_SLUG,
  token,
} from "./apps-fixtures.ts";

setupAppsHttp();

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
