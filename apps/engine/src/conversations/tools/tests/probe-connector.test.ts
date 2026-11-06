import { describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
import { upsertCredential } from "../../../credentials/service.ts";
import { auditLog, roles, users } from "../../../db/schema/index.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import { grantApproval } from "../../../tools/approval.ts";
import { dispatchTool } from "../../../tools/dispatcher.ts";
import { conversationToolProvider } from "../../../tools/providers/conversation.ts";
import { buildRegistry } from "../../../tools/registry.ts";
import { checkToolPermission } from "../permission-gate.ts";
import { probeConnectorTool } from "../probe-connector.ts";
import {
  CANARY,
  captured,
  ctx,
  makeToolContext,
  seedProbeConnector,
  useProbeConnectorSetup,
} from "./probe-connector-fixtures.ts";

useProbeConnectorSetup();

const nextActorId = createDeterministicUuidFactory(0xeac5f7);

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
      response_mode: "full",
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

  test("default read probe returns field shape without response values", async () => {
    const env = await seedProbeConnector({ slug: "shape_probe", tokenValue: CANARY });
    const result = await probeConnectorTool.execute(makeToolContext(env), {
      connector_slug: "shape_probe",
      method: "GET",
      path: "/v1/customers",
      environment: "dev",
    });
    expect(result.ok).toBe(true);
    const body = (result.data as { body: { fields: Array<{ path: string }> } }).body;
    expect(body.fields.some((field) => field.path === "data[0].id")).toBe(true);
    expect(JSON.stringify(body)).not.toContain("cust_42");
    expect(JSON.stringify(body)).not.toContain(CANARY);
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

  test("probe audit preserves the resolved system-account actor", async () => {
    const env = await seedProbeConnector({ slug: "system_actor_probe", tokenValue: CANARY });
    const actorId = nextActorId();
    const tctx = makeToolContext(env);
    tctx.actor_id = actorId;
    tctx.principal = {
      provider: "test",
      kind: "system_account",
      id: actorId,
      tenant_id: env.tenant_id,
      roles: ["admin"],
    };
    tctx.engineClient = new EngineClient({
      tenant_id: env.tenant_id,
      actor_id: actorId,
      actor_type: "system_account",
      db: ctx.db,
    });

    const result = await probeConnectorTool.execute(tctx, {
      connector_slug: "system_actor_probe",
      method: "GET",
      path: "/ping",
      environment: "dev",
    });
    expect(result.ok).toBe(true);

    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenant_id, env.tenant_id))
      .orderBy(desc(auditLog.ts));
    const row = rows.find((entry) => entry.action === "conversation.probe_connector");
    expect(row?.actor_type).toBe("system_account");
    expect(row?.actor_id).toBe(actorId);
  });
});
