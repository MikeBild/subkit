import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { desc, eq } from "drizzle-orm";
import { upsertCredential } from "../../../credentials/service.ts";
import { auditLog, connectors, roles, tenants, users } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { grantApproval } from "../../../tools/approval.ts";
import { dispatchTool } from "../../../tools/dispatcher.ts";
import { conversationToolProvider } from "../../../tools/providers/conversation.ts";
import { buildRegistry } from "../../../tools/registry.ts";
import type { ToolContext } from "../index.ts";
import { checkToolPermission } from "../permission-gate.ts";
import { probeConnectorTool, resetProbeRateLimit } from "../probe-connector.ts";

interface CapturedReq {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

const CANARY = "SHOULD-NEVER-APPEAR-IN-AUDIT-c4n4ry";

let ctx: TestDb;
let server: Server;
let baseUrl: string;
let captured: CapturedReq[] = [];
let nextResponse: { status: number; body: string; headers?: Record<string, string> } = {
  status: 200,
  body: JSON.stringify({ data: [{ id: "cust_42", email: "ada@example.test" }] }),
  headers: { "content-type": "application/json" },
};

beforeAll(async () => {
  ctx = await createTestDb("probe_connector");
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const url = req.url ?? "";
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k.toLowerCase()] = v;
      }
      captured.push({
        method: req.method ?? "GET",
        url,
        headers,
        body,
      });
      if (url.includes("/slow")) {
        // allow-wall-clock: simulates a slow upstream; the timeout is bounded.
        setTimeout(() => {
          const h = nextResponse.headers ?? { "content-type": "application/json" };
          res.writeHead(nextResponse.status, h);
          res.end(nextResponse.body);
        }, 250);
        return;
      }
      const h = nextResponse.headers ?? { "content-type": "application/json" };
      res.writeHead(nextResponse.status, h);
      res.end(nextResponse.body);
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      resolve();
    }),
  );
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  await ctx.cleanup();
});

beforeEach(() => {
  captured = [];
  nextResponse = {
    status: 200,
    body: JSON.stringify({ data: [{ id: "cust_42", email: "ada@example.test" }] }),
    headers: { "content-type": "application/json" },
  };
  resetProbeRateLimit();
});

afterEach(() => {
  resetProbeRateLimit();
});

async function seedProbeConnector(opts: {
  slug: string;
  environment?: "dev" | "prod";
  tokenValue?: string;
  authType?: "bearer" | "none";
}): Promise<{ tenant_id: string; conversation_id: string; connector_id: string }> {
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({
      slug: `t-probe-${Math.random().toString(36).slice(2, 10)}`, // allow-random: legacy; review before changing
      display_name: "T",
    })
    .returning();
  const [conn] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: tenant!.id,
      slug: opts.slug,
      display_name: opts.slug,
      driver: "http",
      environment: opts.environment ?? "dev",
      auth_type: opts.authType ?? "bearer",
      base_url: baseUrl,
    })
    .returning();
  if ((opts.authType ?? "bearer") === "bearer") {
    await upsertCredential(
      {
        tenant_id: tenant!.id,
        connector_id: conn!.id,
        environment: opts.environment ?? "dev",
        mode: "bearer",
        value: { mode: "bearer", token: opts.tokenValue ?? CANARY },
        actor_id: null,
      },
      ctx.db,
    );
  }
  return {
    tenant_id: tenant!.id,
    conversation_id: crypto.randomUUID(), // allow-random: legacy; review before changing
    connector_id: conn!.id,
  };
}

function makeToolContext(env: { tenant_id: string; conversation_id: string }): ToolContext {
  const engineClient = new EngineClient({
    tenant_id: env.tenant_id,
    actor_id: null,
    db: ctx.db,
  });
  return {
    db: ctx.db,
    tenant_id: env.tenant_id,
    conversation_id: env.conversation_id,
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient,
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  };
}

describe("probe_connector — dispatch + credential substitution", () => {
  for (const tool of ["call_connector", "probe_connector"] as const) {
    for (const rotate of [false, true]) {
      test(`${tool} confirmed MCP call ${rotate ? "refuses changed credentials" : "uses the exact approved credentials"}`, async () => {
        const slug = `bound_${tool}_${rotate}`;
        const env = await seedProbeConnector({ slug });
        const principal = {
          provider: "test",
          kind: "user" as const,
          id: "11111111-1111-4111-8111-111111111111",
          tenant_id: env.tenant_id,
          roles: ["admin"],
        };
        const deps = {
          registry: buildRegistry([conversationToolProvider]),
          db: ctx.db,
          principal,
          mcpMode: "authoring" as const,
          buildMcpStubCtx: () => makeToolContext(env),
        };
        const pending = await dispatchTool(deps, {
          surface: "mcp",
          name: tool,
          args: {
            ...(tool === "call_connector"
              ? { connector_id: env.connector_id }
              : { connector_slug: slug, environment: "dev" }),
            method: "POST",
            path: "/orders",
            body: { item: "book" },
          },
        });
        expect(pending.status).toBe("needs_confirm");
        if (pending.status !== "needs_confirm") throw new Error("approval missing");
        expect(captured).toHaveLength(0);
        const granted = await grantApproval({
          db: ctx.db,
          tenant_id: env.tenant_id,
          approval_id: pending.confirm.tool_call_id,
          granted_by_user_id: principal.id,
          via: "portal",
        });
        expect(granted.ok).toBe(true);
        if (rotate)
          await upsertCredential(
            {
              tenant_id: env.tenant_id,
              connector_id: env.connector_id,
              environment: "dev",
              mode: "bearer",
              value: { mode: "bearer", token: "replacement-private-token" },
              actor_id: null,
            },
            ctx.db,
          );
        const result = await dispatchTool(deps, {
          surface: "mcp",
          name: tool,
          args: {},
          meta: { sk_confirm: true, sk_confirm_id: pending.confirm.tool_call_id },
        });
        expect(result.status).toBe(rotate ? "error" : "ok");
        expect(captured).toHaveLength(rotate ? 0 : 1);
        if (rotate) expect(JSON.stringify(result)).toContain("connector_authority_changed");
        expect(JSON.stringify(result)).not.toContain(CANARY);
      });
    }
  }

  test("MCP rejects an excluded probe target before approval or network dispatch", async () => {
    const env = await seedProbeConnector({ slug: "mcp_excluded_probe" });
    const tctx = makeToolContext(env);
    const principal = {
      provider: "test",
      kind: "user" as const,
      id: "11111111-1111-4111-8111-111111111111",
      tenant_id: env.tenant_id,
      roles: ["admin"],
      scopes: ["connector:read"],
      allowed_connectors: [],
    };
    const result = await dispatchTool(
      {
        registry: buildRegistry([conversationToolProvider]),
        db: ctx.db,
        principal,
        mcpMode: "authoring",
        buildMcpStubCtx: () => tctx,
      },
      {
        surface: "mcp",
        name: "probe_connector",
        args: { connector_slug: "mcp_excluded_probe", environment: "dev", method: "POST" },
      },
    );
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error_code).toBe("policy_denied");
    expect(captured).toHaveLength(0);
    const rows = await ctx.db.select().from(auditLog).where(eq(auditLog.tenant_id, env.tenant_id));
    expect(rows.some((row) => row.action === "policy.denied")).toBe(true);
    expect(rows.some((row) => row.action === "approval.requested")).toBe(false);

    const permission = probeConnectorTool.permission;
    if (!permission) throw new Error("probe permission missing");
    const decision = await checkToolPermission({ ...tctx, principal }, permission, {
      connector_slug: "mcp_excluded_probe",
      environment: "dev",
    });
    expect(decision.allow).toBe(false);
    const allowed = await dispatchTool(
      {
        registry: buildRegistry([conversationToolProvider]),
        db: ctx.db,
        principal: { ...principal, allowed_connectors: [env.connector_id] },
        mcpMode: "authoring",
        buildMcpStubCtx: () => tctx,
      },
      {
        surface: "mcp",
        name: "probe_connector",
        args: { connector_slug: "mcp_excluded_probe", method: "GET" },
      },
    );
    expect(allowed.status).toBe("ok");
    expect(captured).toHaveLength(1);
  });

  test("the central permission gate rejects a principal without access to the probe target", async () => {
    const env = await seedProbeConnector({ slug: "probe_target_rbac" });
    const [role] = await ctx.db
      .insert(roles)
      .values({
        tenant_id: env.tenant_id,
        name: "probe-no-access",
        description: "No connector permissions",
      })
      .returning();
    const [user] = await ctx.db
      .insert(users)
      .values({
        tenant_id: env.tenant_id,
        email: "probe-no-access@example.test",
        role_id: role!.id,
      })
      .returning();
    const tctx = makeToolContext(env);
    tctx.actor_id = user!.id;
    tctx.engineClient = new EngineClient({
      tenant_id: env.tenant_id,
      actor_id: user!.id,
      actor_type: "user",
      db: ctx.db,
    });
    const permission = probeConnectorTool.permission;
    if (!permission) throw new Error("probe target permission descriptor is missing");
    const decision = await checkToolPermission(tctx, permission, {
      connector_slug: "probe_target_rbac",
      environment: "dev",
      method: "GET",
    });
    expect(decision.allow).toBe(false);
    expect(captured).toHaveLength(0);
    const rows = await ctx.db.select().from(auditLog).where(eq(auditLog.tenant_id, env.tenant_id));
    expect(rows.some((row) => row.action === "policy.denied" && row.result === "denied")).toBe(
      true,
    );
  });

  test("a credential reference preserves the caller's connector restrictions", async () => {
    const env = await seedProbeConnector({ slug: "restricted_probe", tokenValue: CANARY });
    const tctx = makeToolContext(env);
    tctx.principal = {
      provider: "test",
      kind: "user",
      id: "11111111-1111-4111-8111-111111111111",
      tenant_id: env.tenant_id,
      roles: [],
      scopes: [],
    };
    const result = await probeConnectorTool.execute(tctx, {
      connector_slug: "restricted_probe",
      method: "GET",
      path: "/v1/customers",
      headers: { "x-custom-token": `\${cred.restricted_probe.token}` },
      environment: "dev",
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.data)).toContain("rbac_denied");
    expect(JSON.stringify(result.data)).not.toContain(CANARY);
    expect(captured).toHaveLength(0);
  });

  test("happy path: GET dispatches, resolves cred token, returns truncated body", async () => {
    const env = await seedProbeConnector({ slug: "stripe_mock", tokenValue: CANARY });
    const tctx = makeToolContext(env);

    const result = await probeConnectorTool.execute(tctx, {
      connector_slug: "stripe_mock",
      method: "GET",
      path: "/v1/customers",
      query: { limit: 2 },
      environment: "dev",
    });

    expect(result.ok).toBe(true);
    const out = result.data as Record<string, unknown>;
    expect(out.status_code).toBe(200);
    expect(out.persistence).toBe("none");
    expect(Array.isArray(out.placeholders_used)).toBe(true);
    const body = out.body as { data: Array<{ id: string }> };
    expect(body.data[0]!.id).toBe("cust_42");

    expect(captured.length).toBe(1);
    const req = captured[0]!;
    expect(req.method).toBe("GET");
    expect(req.url).toContain("/v1/customers");
    expect(req.url).toContain("limit=2");
    expect(req.headers.authorization).toBe(`Bearer ${CANARY}`);
  });

  test("unresolved placeholder in custom header fails before dispatch", async () => {
    const env = await seedProbeConnector({ slug: "hd1", tokenValue: "custom-auth-v2" });
    const tctx = makeToolContext(env);

    const result = await probeConnectorTool.execute(tctx, {
      connector_slug: "hd1",
      method: "GET",
      path: "/status",
      headers: { "x-request-id": `req-\${input.trace}` },
      environment: "dev",
    });

    expect(result.ok).toBe(false);
    const data = (result.data ?? {}) as Record<string, unknown>;
    const err = (data.error ?? {}) as {
      code?: string;
      details?: { unresolved?: Array<{ token: string }> };
    };
    expect(err.code).toBe("placeholder_unresolved");
    expect(err.details?.unresolved?.[0]?.token).toBe(`\${input.trace}`);
    expect(captured.length).toBe(0);
  });

  test("non-existent slug → connector_not_found", async () => {
    const env = await seedProbeConnector({ slug: "existing" });
    const tctx = makeToolContext(env);

    const result = await probeConnectorTool.execute(tctx, {
      connector_slug: "not-here",
      method: "GET",
      environment: "dev",
    });
    expect(result.ok).toBe(false);
    const err = (result.data as { error: { code: string } }).error;
    expect(err.code).toBe("connector_not_found");
    expect(captured.length).toBe(0);
  });
});

describe("probe_connector — audit hygiene", () => {
  test("audit row records slug + host + status + placeholder names, but NOT the credential value", async () => {
    const env = await seedProbeConnector({ slug: "aud1", tokenValue: CANARY });
    const tctx = makeToolContext(env);

    const probeResult = await probeConnectorTool.execute(tctx, {
      connector_slug: "aud1",
      method: "GET",
      path: "/ping",
      environment: "dev",
    });
    expect(probeResult.ok).toBe(true);

    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenant_id, env.tenant_id))
      .orderBy(desc(auditLog.ts));
    const row = rows.find((r) => r.action === "conversation.probe_connector");
    expect(row).toBeTruthy();
    const meta = (row!.metadata ?? {}) as Record<string, unknown>;
    expect(meta.connector_slug).toBe("aud1");
    expect(meta.environment).toBe("dev");
    expect(meta.method).toBe("GET");
    expect(meta.status_code).toBe(200);
    expect(typeof meta.url_host).toBe("string");
    expect((meta.url_host as string).startsWith("127.0.0.1")).toBe(true);
    const serialised = JSON.stringify(row);
    expect(serialised.includes(CANARY)).toBe(false);
  });
});

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
    nextResponse = {
      status: 500,
      body: JSON.stringify({ error: "boom" }),
      headers: { "content-type": "application/json" },
    };
    const env = await seedProbeConnector({ slug: "err1" });
    const tctx = makeToolContext(env);

    const result = await probeConnectorTool.execute(tctx, {
      connector_slug: "err1",
      method: "GET",
      environment: "dev",
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
