import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, systemAccounts } from "../../../../db/schema/index.ts";
import { issueApiKey } from "../../../../identity/service.ts";
import { builtinRoleId } from "../../../../rbac/roles.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../tests/setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("portal-token-actor");
});

afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

const headers = (key = ctx.apiKey) => ({
  authorization: `Bearer ${key}`,
  "content-type": "application/json",
});

describe("portal token revoke actor provenance", () => {
  test("HTTP revoke persists the authenticated actor type and ID", async () => {
    await ctx.db
      .update(systemAccounts)
      .set({ role_id: await builtinRoleId(ctx.db, "admin") })
      .where(eq(systemAccounts.id, ctx.systemAccountId));
    const callerKey = await issueApiKey(
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
    const machineHeaders = headers(callerKey.plaintext);

    const issue = await fetch(`${ctx.baseUrl}/v1/identity/portal-tokens`, {
      method: "POST",
      headers: machineHeaders,
      body: JSON.stringify({
        user_id: ctx.userId,
        allowed_workflows: ["portal-revoke-actor-test"],
      }),
    });
    expect(issue.status).toBe(201);
    const token = (await issue.json()) as { id: string };
    expect(token.id).not.toBe(callerKey.view.id);

    const revoke = await fetch(`${ctx.baseUrl}/v1/identity/portal-tokens/${token.id}`, {
      method: "DELETE",
      headers: machineHeaders,
    });
    expect(revoke.status).toBe(204);

    const [audit] = await ctx.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "portal_token.revoked"),
          eq(auditLog.resource_id, token.id),
        ),
      );
    expect(audit).toEqual({ actor_type: "system_account", actor_id: ctx.systemAccountId });
  });
});
