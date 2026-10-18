import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { apiKeys, auditLog, systemAccounts, users } from "../../../../db/schema/index.ts";
import { issueApiKey } from "../../../../identity/service.ts";
import { builtinRoleId } from "../../../../rbac/roles.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../tests/setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("api-key-creators");
});

afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

const headers = (key = ctx.apiKey) => ({
  authorization: `Bearer ${key}`,
  "content-type": "application/json",
});

describe("API key creator provenance", () => {
  test("user A issues for user B and response/list preserve separate typed references", async () => {
    const [owner] = await ctx.db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "key-owner-b@test.local",
        role_id: await builtinRoleId(ctx.db, "member"),
      })
      .returning({ id: users.id });
    if (!owner) throw new Error("key owner was not created");

    const response = await fetch(`${ctx.baseUrl}/v1/identity/api-keys`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ owner_kind: "user", owner_id: owner.id, name: "owned by B" }),
    });
    expect(response.status).toBe(201);
    const issued = (await response.json()) as {
      id: string;
      user_id: string | null;
      system_account_id: string | null;
      creator: { kind: string; id: string | null } | null;
    };
    expect(issued).toMatchObject({
      user_id: owner.id,
      system_account_id: null,
      creator: { kind: "user", id: ctx.userId },
    });

    const listResponse = await fetch(`${ctx.baseUrl}/v1/identity/api-keys`, {
      headers: headers(),
    });
    expect(listResponse.status).toBe(200);
    const list = (await listResponse.json()) as { items: (typeof issued)[] };
    expect(list.items.find((item) => item.id === issued.id)).toMatchObject({
      user_id: owner.id,
      creator: { kind: "user", id: ctx.userId },
    });
  });

  test("issue and rotation expose creator separately from the inherited owner", async () => {
    const issuedResponse = await fetch(`${ctx.baseUrl}/v1/identity/api-keys`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        owner_kind: "system_account",
        owner_id: ctx.systemAccountId,
        name: "system-owned key",
      }),
    });
    expect(issuedResponse.status).toBe(201);
    const issued = (await issuedResponse.json()) as {
      id: string;
      user_id: string | null;
      system_account_id: string | null;
      creator: { kind: string; id: string | null } | null;
    };
    expect(issued).toMatchObject({
      user_id: null,
      system_account_id: ctx.systemAccountId,
      creator: { kind: "user", id: ctx.userId },
    });

    const rotationResponse = await fetch(
      `${ctx.baseUrl}/v1/identity/api-keys/${issued.id}/rotate`,
      { method: "POST", headers: headers(), body: JSON.stringify({ overlap_minutes: 30 }) },
    );
    expect(rotationResponse.status).toBe(200);
    const rotation = (await rotationResponse.json()) as {
      new: {
        user_id: string | null;
        system_account_id: string | null;
        rotated_from_id: string | null;
        creator: { kind: string; id: string | null } | null;
      };
    };
    expect(rotation.new).toMatchObject({
      user_id: null,
      system_account_id: ctx.systemAccountId,
      rotated_from_id: issued.id,
      creator: { kind: "user", id: ctx.userId },
    });
  });

  test("pre-existing rows have unavailable creator provenance", async () => {
    const [row] = await ctx.db
      .select({ creator_kind: apiKeys.creator_kind, creator_id: apiKeys.creator_id })
      .from(apiKeys)
      .where(and(eq(apiKeys.tenant_id, ctx.tenantId), eq(apiKeys.id, ctx.apiKeyId)))
      .limit(1);
    expect(row).toEqual({ creator_kind: null, creator_id: null });

    const list = await fetch(`${ctx.baseUrl}/v1/identity/api-keys`, { headers: headers() });
    expect(list.status).toBe(200);
    const keys = (await list.json()) as {
      items: Array<{ id: string; creator: { kind: string; id: string | null } | null }>;
    };
    expect(keys.items.find((item) => item.id === ctx.apiKeyId)?.creator).toBeNull();
  });

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

    const issue = await fetch(`${ctx.baseUrl}/v1/identity/api-keys`, {
      method: "POST",
      headers: machineHeaders,
      body: JSON.stringify({
        owner_kind: "user",
        owner_id: ctx.userId,
        name: "system-account revoke target",
      }),
    });
    expect(issue.status).toBe(201);
    const key = (await issue.json()) as { id: string };
    expect(key.id).not.toBe(callerKey.view.id);

    const revoke = await fetch(`${ctx.baseUrl}/v1/identity/api-keys/${key.id}`, {
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
          eq(auditLog.action, "api_key.revoked"),
          eq(auditLog.resource_id, key.id),
        ),
      );
    expect(audit).toEqual({ actor_type: "system_account", actor_id: ctx.systemAccountId });
  });
});
