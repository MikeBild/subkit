import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, systemAccounts } from "../../../../db/schema/index.ts";
import { issueApiKey } from "../../../../identity/service.ts";
import { builtinRoleId } from "../../../../rbac/roles.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../tests/setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("system-account-actor");
});

afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

describe("system-account administration actor provenance", () => {
  test("admin system account create and delete retain the authenticated actor kind", async () => {
    const userCreate = await fetch(`${ctx.baseUrl}/v1/identity/system-accounts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "created-by-user" }),
    });
    expect(userCreate.status).toBe(201);
    const userCreated = (await userCreate.json()) as { id: string };
    const userAudit = await ctx.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "system_account.created"),
          eq(auditLog.resource_id, userCreated.id),
        ),
      );
    expect(userAudit).toEqual([{ actor_type: "user", actor_id: ctx.userId }]);

    await ctx.db
      .update(systemAccounts)
      .set({ role_id: await builtinRoleId(ctx.db, "admin") })
      .where(
        and(eq(systemAccounts.tenant_id, ctx.tenantId), eq(systemAccounts.id, ctx.systemAccountId)),
      );

    const key = await issueApiKey(
      {
        issuer: { kind: "system" },
        tenant_id: ctx.tenantId,
        owner_kind: "system_account",
        owner_id: ctx.systemAccountId,
        scopes: ["*"],
        actor: { kind: "user", id: ctx.userId },
      },
      ctx.db,
    );
    const headers = {
      authorization: `Bearer ${key.plaintext}`,
      "content-type": "application/json",
    };

    const createdResponse = await fetch(`${ctx.baseUrl}/v1/identity/system-accounts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "created-by-system-account" }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as { id: string };
    const createdAudit = await ctx.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "system_account.created"),
          eq(auditLog.resource_id, created.id),
        ),
      );
    expect(createdAudit).toEqual([{ actor_type: "system_account", actor_id: ctx.systemAccountId }]);

    const deletedResponse = await fetch(
      `${ctx.baseUrl}/v1/identity/system-accounts/${created.id}`,
      { method: "DELETE", headers },
    );
    expect(deletedResponse.status).toBe(204);
    const deletedAudit = await ctx.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "system_account.deleted"),
          eq(auditLog.resource_id, created.id),
        ),
      );
    expect(deletedAudit).toEqual([{ actor_type: "system_account", actor_id: ctx.systemAccountId }]);
  });
});
