import { describe, expect, test } from "bun:test";
import { upsertCredential } from "../../../credentials/service.ts";
import { connectors, tenants } from "../../../db/schema/index.ts";
import { probeConnectorTool } from "../probe-connector.ts";
import {
  baseUrl,
  captured,
  ctx,
  makeToolContext,
  seedProbeConnector,
  setNextResponse,
  useProbeConnectorSetup,
} from "./probe-connector-fixtures.ts";

useProbeConnectorSetup();

describe("probe_connector — rate limit", () => {
  test("21st call in <60s returns probe_rate_limited without dispatching", async () => {
    const env = await seedProbeConnector({ slug: "rate1" });
    const tctx = makeToolContext(env);

    let lastResult: Awaited<ReturnType<typeof probeConnectorTool.execute>> | null = null;
    for (let i = 0; i < 20; i++) {
      const r = await probeConnectorTool.execute(tctx, {
        connector_slug: "rate1",
        method: "GET",
        environment: "dev",
      });
      expect(r.ok).toBe(true);
      lastResult = r;
    }
    const overLimit = await probeConnectorTool.execute(tctx, {
      connector_slug: "rate1",
      method: "GET",
      environment: "dev",
    });
    expect(overLimit.ok).toBe(false);
    const err = (overLimit.data as { error: { code: string } }).error;
    expect(err.code).toBe("probe_rate_limited");
    expect(captured.length).toBe(20);
    expect(lastResult).toBeTruthy();
  });
});

describe("probe_connector — credential pre-gate (oauth2)", () => {
  test("oauth2 connector with a valid access_token → dispatches and returns credential descriptor", async () => {
    const [tenant] = await ctx.db
      .insert(tenants)
      .values({
        slug: `t-oauth2-ok-${Math.random().toString(36).slice(2, 8)}`, // allow-random: unique slug
        display_name: "T",
      })
      .returning();

    const [conn] = await ctx.db
      .insert(connectors)
      .values({
        tenant_id: tenant!.id,
        slug: "oauth2-live",
        display_name: "oauth2-live",
        driver: "http",
        environment: "dev",
        auth_type: "oauth2",
        base_url: baseUrl,
      })
      .returning();

    await upsertCredential(
      {
        tenant_id: tenant!.id,
        connector_id: conn!.id,
        environment: "dev",
        mode: "oauth2",
        value: {
          mode: "oauth2",
          access_token: "live-oauth2-token-xyz",
          token_type: "Bearer",
          refresh_token: null,
          expires_at: null,
        },
        actor_id: null,
      },
      ctx.db,
    );

    const tctx = makeToolContext({ tenant_id: tenant!.id, conversation_id: crypto.randomUUID() }); // allow-random: unique per test

    const result = await probeConnectorTool.execute(tctx, {
      connector_slug: "oauth2-live",
      method: "GET",
      path: "/health",
      environment: "dev",
    });

    expect(result.ok).toBe(true);
    const out = result.data as Record<string, unknown>;
    expect(out.status_code).toBe(200);

    const cred = out.credential as { mode: string; present: boolean } | undefined;
    expect(cred).toBeDefined();
    expect(cred!.mode).toBe("oauth2");
    expect(cred!.present).toBe(true);

    expect(captured.length).toBeGreaterThan(0);
    const req = captured[captured.length - 1]!;
    expect(req.headers.authorization).toBe("Bearer live-oauth2-token-xyz");
  });

  test("oauth2 connector with NO credential row → credential_required pre-gate fires before dispatch", async () => {
    const [tenant] = await ctx.db
      .insert(tenants)
      .values({
        slug: `t-oauth2-nocred-${Math.random().toString(36).slice(2, 8)}`, // allow-random: unique slug
        display_name: "T",
      })
      .returning();

    await ctx.db
      .insert(connectors)
      .values({
        tenant_id: tenant!.id,
        slug: "oauth2-nocred",
        display_name: "oauth2-nocred",
        driver: "http",
        environment: "dev",
        auth_type: "oauth2",
        base_url: baseUrl,
      })
      .returning();

    const tctx = makeToolContext({ tenant_id: tenant!.id, conversation_id: crypto.randomUUID() }); // allow-random: unique per test

    const prevCapturedLen = captured.length;
    const result = await probeConnectorTool.execute(tctx, {
      connector_slug: "oauth2-nocred",
      method: "GET",
      environment: "dev",
    });

    expect(result.ok).toBe(false);
    const err = (result.data as { error: { code: string; message: string } }).error;
    expect(err.code).toBe("credential_required");
    expect(err.message).toContain("oauth2-nocred");
    expect(captured.length).toBe(prevCapturedLen);
  });

  test("oauth2 connector with credential but empty access_token → authenticate_oauth_required fires before dispatch", async () => {
    const [tenant] = await ctx.db
      .insert(tenants)
      .values({
        slug: `t-oauth2-empty-${Math.random().toString(36).slice(2, 8)}`, // allow-random: unique slug
        display_name: "T",
      })
      .returning();

    const [conn] = await ctx.db
      .insert(connectors)
      .values({
        tenant_id: tenant!.id,
        slug: "oauth2-empty-tok",
        display_name: "oauth2-empty-tok",
        driver: "http",
        environment: "dev",
        auth_type: "oauth2",
        base_url: baseUrl,
      })
      .returning();

    await upsertCredential(
      {
        tenant_id: tenant!.id,
        connector_id: conn!.id,
        environment: "dev",
        mode: "oauth2",
        value: {
          mode: "oauth2",
          access_token: "",
          token_type: "Bearer",
          refresh_token: null,
          expires_at: null,
        },
        actor_id: null,
      },
      ctx.db,
    );

    const tctx = makeToolContext({ tenant_id: tenant!.id, conversation_id: crypto.randomUUID() }); // allow-random: unique per test

    const prevCapturedLen = captured.length;
    const result = await probeConnectorTool.execute(tctx, {
      connector_slug: "oauth2-empty-tok",
      method: "GET",
      environment: "dev",
    });

    expect(result.ok).toBe(false);
    const err = (result.data as { error: { code: string; message: string } }).error;
    expect(err.code).toBe("authenticate_oauth_required");
    expect(err.message).toContain("oauth2-empty-tok");
    expect(captured.length).toBe(prevCapturedLen);
  });

  test("auth_type:none connector → no credential check at all, dispatches directly", async () => {
    const env = await seedProbeConnector({ slug: "no-auth-conn", authType: "none" });
    const tctx = makeToolContext(env);

    const result = await probeConnectorTool.execute(tctx, {
      connector_slug: "no-auth-conn",
      method: "GET",
      environment: "dev",
    });

    expect(result.ok).toBe(true);
    const out = result.data as Record<string, unknown>;
    expect(out.status_code).toBe(200);
    expect(out.credential).toBeUndefined();
  });
});

describe("probe_connector — downstream error handling", () => {
  test("server 500 still returns ok:true with status_code=500 (probe surfaces the response)", async () => {
    setNextResponse({
      status: 500,
      body: JSON.stringify({ error: "boom" }),
      headers: { "content-type": "application/json" },
    });
    const env = await seedProbeConnector({ slug: "err1" });
    const tctx = makeToolContext(env);

    const result = await probeConnectorTool.execute(tctx, {
      connector_slug: "err1",
      method: "GET",
      environment: "dev",
      response_mode: "full",
    });
    expect(result.ok).toBe(true);
    const out = result.data as { status_code: number; body: { error: string } };
    expect(out.status_code).toBe(500);
    expect(out.body.error).toBe("boom");
  });

  test("connection failure returns ok:false with probe_fetch_failed", async () => {
    const [tenant] = await ctx.db
      .insert(tenants)
      .values({ slug: `t-fail-${Math.random().toString(36).slice(2, 8)}`, display_name: "T" }) // allow-random: legacy; review before changing
      .returning();
    await ctx.db
      .insert(connectors)
      .values({
        tenant_id: tenant!.id,
        slug: "bad_host",
        display_name: "bad_host",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        base_url: "http://127.0.0.1:1",
      })
      .returning();
    const tctx = makeToolContext({
      tenant_id: tenant!.id,
      conversation_id: crypto.randomUUID(), // allow-random: legacy; review before changing
    });
    const result = await probeConnectorTool.execute(tctx, {
      connector_slug: "bad_host",
      method: "GET",
      environment: "dev",
    });
    expect(result.ok).toBe(false);
    const err = (result.data as { error: { code: string } }).error;
    expect(err.code).toBe("probe_fetch_failed");
  });

  test("timeout returns ok:false with probe_timeout", async () => {
    const env = await seedProbeConnector({ slug: "slow_probe", authType: "none" });
    const tctx = makeToolContext(env);
    const result = await probeConnectorTool.execute(tctx, {
      connector_slug: "slow_probe",
      method: "GET",
      path: "/slow",
      environment: "dev",
      timeout_ms: 100,
    });
    expect(result.ok).toBe(false);
    const err = (result.data as { error: { code: string; message: string } }).error;
    expect(err.code).toBe("probe_timeout");
    expect(err.message).toContain("timed out");
  });
});
