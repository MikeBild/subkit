import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { apiKeys, auditLog, users } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;
let mock: Server;
let mockBase = "";
let hookId = "";

beforeAll(async () => {
  ctx = await createJourneyCtx("hook-deny");

  mock = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
  const addr = mock.address() as AddressInfo;
  mockBase = `http://127.0.0.1:${addr.port}`;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  await new Promise<void>((resolve) => mock.close(() => resolve()));
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey: before-request hook denial", () => {
  test("AC1: admin creates a deny-mutating hook for role admin", async () => {
    const hookCode = `
      var m = (input && input.request && input.request.method) || "";
      if (m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE") {
        return { allow: false, reason: "mutating_denied" };
      }
      return { allow: true };
    `;
    const res = await journeyFetch(ctx, "/v1/auth/request-hooks", {
      method: "POST",
      body: JSON.stringify({
        role: "admin",
        code: hookCode,
        description: "deny mutating methods",
        enabled: true,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; enabled: boolean };
    hookId = body.id;
    expect(body.enabled).toBe(true);
  });

  test("AC2: the hook lands in the list and carries the right role + version", async () => {
    const listRes = await journeyFetch(ctx, "/v1/auth/request-hooks");
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as {
      items: Array<{ id: string; role: string; version: number; enabled: boolean }>;
    };
    const row = body.items.find((r) => r.id === hookId);
    expect(row).toBeDefined();
    expect(row?.role).toBe("admin");
    expect(row?.enabled).toBe(true);
    expect(row?.version).toBeGreaterThanOrEqual(1);
  });

  test("AC3: member-role deny hook blocks workflow run and writes a policy.denied audit row", async () => {
    const memberHookRes = await journeyFetch(ctx, "/v1/auth/request-hooks", {
      method: "POST",
      body: JSON.stringify({
        role: "member",
        code: `return { allow: false, reason: "blocked" };`,
        description: "member deny-all",
        enabled: true,
      }),
    });
    expect(memberHookRes.status).toBe(201);
    const memberHookBody = (await memberHookRes.json()) as { id: string };
    const memberHookId = memberHookBody.id;

    const [memberUser] = await ctx.db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "member-hook-deny@test.local",
        role_id: await builtinRoleId(ctx.db, "member"),
      })
      .returning();
    if (!memberUser) throw new Error("seed member user failed");

    const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: legacy; review before changing
    const plaintext = `wf_live_${rand}`;
    const prefix = plaintext.slice(0, 12);
    const tokenHash = createHash("sha256").update(plaintext).digest("hex");
    await ctx.db.insert(apiKeys).values({
      tenant_id: ctx.tenantId,
      user_id: memberUser.id,
      prefix,
      token_sha256: tokenHash,
      scopes: ["*"],
    });

    const wfRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "member-blocked",
        slug: "member-blocked",
        steps: [
          {
            kind: "request",
            id: "get",
            method: "GET",
            url: `${mockBase}/widgets`,
          },
        ],
      }),
    });
    expect(wfRes.status).toBe(201);
    const wfBody = (await wfRes.json()) as { id: string };
    const wfId = wfBody.id;

    const run = await fetch(`${ctx.baseUrl}/v1/executions`, {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: wfId, input: {} }),
      headers: {
        authorization: `Bearer ${plaintext}`,
        "content-type": "application/json",
      },
    });
    expect(run.status).toBe(200);
    const rb = (await run.json()) as {
      execution_id: string;
      status: string;
      error: { code: string; message: string } | null;
      steps: Array<{ error: { code?: string } | null }>;
    };
    expect(rb.status).toBe("failed");
    const denied = rb.steps.find((s) => s.error && (s.error as { code?: string }).code);
    expect(denied).toBeDefined();
    expect((denied!.error as { code: string }).code).toBe("policy.denied");

    const auditRows = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.action, "policy.denied")));
    const match = auditRows.find((r) => r.resource_id === memberHookId);
    expect(match).toBeDefined();
    expect(match?.result).toBe("denied");
  });

  test("AC4: a GET-only workflow still succeeds while the hook is enabled", async () => {
    const wfRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "readonly",
        slug: "readonly",
        steps: [
          {
            kind: "request",
            id: "get",
            method: "GET",
            url: `${mockBase}/widgets`,
          },
        ],
      }),
    });
    const wfId = ((await wfRes.json()) as { id: string }).id;
    const run = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: wfId, input: {} }),
    });
    const rb = (await run.json()) as { status: string };
    expect(rb.status).toBe("succeeded");
  });
});
