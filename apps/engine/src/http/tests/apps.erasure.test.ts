import { describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { EngineClient } from "../../../../sk/src/engine-client.ts";
import {
  apiKeys,
  auditLog,
  callerBudgetUnits,
  executions,
  productIdentityTombstones,
  sessions,
  tenants,
  userIdentities,
  users,
} from "../../db/schema/index.ts";
import { generateKey as generateApiKey } from "../../identity/api-key.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import {
  assistantId,
  call,
  ctx,
  json,
  narrowKey,
  nextUuid,
  run,
  setupAppsHttp,
  token,
} from "./apps-fixtures.ts";

setupAppsHttp();

describe("erasing an app user over HTTP", () => {
  async function appUser() {
    const subject = nextUuid();
    const bearer = await token(subject);
    expect((await call("/v1/identity/whoami", bearer)).status).toBe(200);
    const [identity] = await ctx.db
      .select()
      .from(userIdentities)
      .where(and(eq(userIdentities.tenant_id, ctx.tenantId), eq(userIdentities.subject, subject)));
    if (!identity) throw new Error("identity missing");
    return { subject, bearer, userId: identity.user_id };
  }

  function erase(appId: string, userId: string, bearer: string | null = ctx.apiKey) {
    return call(`/v1/apps/${appId}/users/${userId}`, bearer, { method: "DELETE" });
  }

  async function eraseAudits(userId: string) {
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_id, userId)))
      .orderBy(desc(auditLog.ts));
    return rows.filter((row) => row.action === "user.deleted");
  }

  test("erasing removes the person's data, audits the operator once and refuses the subject afterwards", async () => {
    const { subject, bearer, userId } = await appUser();
    expect((await run(bearer, "erase-turn", `erase-turn:${userId}`)).status).toBe(202);
    const [key] = [generateApiKey()];
    await ctx.db.insert(apiKeys).values({
      tenant_id: ctx.tenantId,
      user_id: userId,
      prefix: key.prefix,
      token_sha256: key.hash,
      scopes: ["identity:read"],
    });
    await ctx.db.insert(sessions).values({
      tenant_id: ctx.tenantId,
      user_id: userId,
      product_id: "testapp",
      expires_at: new Date(getTestNow() + 3_600_000),
    });
    const before = await ctx.db
      .select()
      .from(callerBudgetUnits)
      .where(
        and(
          eq(callerBudgetUnits.tenant_id, ctx.tenantId),
          eq(callerBudgetUnits.principal_id, userId),
        ),
      );
    expect(before.length).toBeGreaterThan(0);

    const res = await erase("testapp", userId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: userId, app_id: "testapp", erased: true });

    expect(
      await ctx.db.select().from(userIdentities).where(eq(userIdentities.user_id, userId)),
    ).toEqual([]);
    expect(
      await ctx.db
        .select()
        .from(callerBudgetUnits)
        .where(eq(callerBudgetUnits.principal_id, userId)),
    ).toEqual([]);
    const openSessions = await ctx.db.select().from(sessions).where(eq(sessions.user_id, userId));
    expect(openSessions.every((row) => row.revoked_at !== null)).toBe(true);
    const keys = await ctx.db.select().from(apiKeys).where(eq(apiKeys.user_id, userId));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((row) => row.revoked_at !== null)).toBe(true);
    const [user] = await ctx.db.select().from(users).where(eq(users.id, userId));
    expect(user).toMatchObject({
      status: "disabled",
      email: `erased:${userId}@invalid`,
      display_name: null,
    });
    expect(user?.deleted_at).not.toBeNull();
    const tombstones = await ctx.db
      .select()
      .from(productIdentityTombstones)
      .where(eq(productIdentityTombstones.tenant_id, ctx.tenantId));
    expect(tombstones.length).toBeGreaterThan(0);
    expect(JSON.stringify(tombstones)).not.toContain(subject);
    const runs = await ctx.db
      .select()
      .from(executions)
      .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.workflow_id, assistantId)));
    const mine = runs.filter(
      (row) => (row.caller_context as { principalId?: string } | null)?.principalId === userId,
    );
    expect(mine.length).toBeGreaterThan(0);
    for (const row of mine)
      expect((row.caller_context as { subject?: unknown }).subject ?? null).toBeNull();

    const audits = await eraseAudits(userId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_type: "user",
      actor_id: ctx.userId,
      resource_type: "user",
      result: "success",
    });
    expect(audits[0]?.metadata).toMatchObject({
      source: "operator_erasure",
      erased_user_id: userId,
      product_id: "testapp",
    });

    expect((await call("/v1/identity/whoami", bearer)).status).toBeGreaterThanOrEqual(401);
  });

  test("a repeated identical request answers 404 and adds no second audit entry", async () => {
    const { userId } = await appUser();
    expect((await erase("testapp", userId)).status).toBe(200);
    expect((await erase("testapp", userId)).status).toBe(404);
    expect(await eraseAudits(userId)).toHaveLength(1);
  });

  test("a user with sign-in links to another app is refused and keeps everything", async () => {
    const { userId } = await appUser();
    await ctx.db.insert(userIdentities).values({
      tenant_id: ctx.tenantId,
      user_id: userId,
      provider_id: "second-app-bearer",
      product_id: "flowkit",
      subject: nextUuid(),
      email: "second-app-user@example.test",
    });
    const res = await erase("testapp", userId);
    expect(res.status).toBe(409);
    expect(
      await ctx.db.select().from(userIdentities).where(eq(userIdentities.user_id, userId)),
    ).toHaveLength(2);
    const [own] = await ctx.db.select().from(users).where(eq(users.id, userId));
    expect(own?.deleted_at).toBeNull();
    expect(await eraseAudits(userId)).toHaveLength(0);
  });

  test("an id of another app, a foreign workspace or nobody is not found and changes nothing", async () => {
    const { userId } = await appUser();
    expect((await erase("flowkit", userId)).status).toBe(404);
    expect((await erase("nokit", userId)).status).toBe(404);
    expect((await erase("testapp", nextUuid())).status).toBe(404);

    const [other] = await ctx.db.select().from(tenants).where(eq(tenants.slug, "t-apps-other"));
    if (!other) throw new Error("other tenant missing");
    const [foreignUser] = await ctx.db
      .insert(users)
      .values({
        tenant_id: other.id,
        email: "foreign-app-user@example.test",
        role_id: nextUuid(),
      })
      .returning();
    if (!foreignUser) throw new Error("foreign user insert failed");
    await ctx.db.insert(userIdentities).values({
      tenant_id: other.id,
      user_id: foreignUser.id,
      provider_id: "other-bearer",
      product_id: "testapp",
      subject: nextUuid(),
      email: "foreign-app-user@example.test",
    });
    expect((await erase("testapp", foreignUser.id)).status).toBe(404);
    const [stillThere] = await ctx.db.select().from(users).where(eq(users.id, foreignUser.id));
    expect(stillThere?.deleted_at).toBeNull();
    expect(await eraseAudits(foreignUser.id)).toHaveLength(0);
    const [own] = await ctx.db.select().from(users).where(eq(users.id, userId));
    expect(own?.deleted_at).toBeNull();
    expect((await erase("testapp", "not-a-uuid")).status).toBe(400);
  });

  test("a product principal and a credential without identity:write are refused", async () => {
    const { bearer, userId } = await appUser();
    expect((await erase("testapp", userId, bearer)).status).toBe(403);
    expect((await erase("testapp", userId, narrowKey)).status).toBe(403);
    expect((await erase("testapp", userId, null)).status).toBe(401);
    const [own] = await ctx.db.select().from(users).where(eq(users.id, userId));
    expect(own?.deleted_at).toBeNull();
  });

  test("the identity user deactivation still only deactivates", async () => {
    const { userId } = await appUser();
    expect(
      (await call(`/v1/identity/users/${userId}`, ctx.apiKey, { method: "DELETE" })).status,
    ).toBe(204);
    expect(
      await ctx.db.select().from(userIdentities).where(eq(userIdentities.user_id, userId)),
    ).toHaveLength(1);
    const [user] = await ctx.db.select().from(users).where(eq(users.id, userId));
    expect(user?.email).not.toContain("erased:");
    const audits = await eraseAudits(userId);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).not.toHaveProperty("source");
  });
});

describe("erasing an app user parity between HTTP and the sk client", () => {
  async function appUser() {
    const subject = nextUuid();
    const bearer = await token(subject);
    expect((await call("/v1/identity/whoami", bearer)).status).toBe(200);
    const [identity] = await ctx.db
      .select()
      .from(userIdentities)
      .where(and(eq(userIdentities.tenant_id, ctx.tenantId), eq(userIdentities.subject, subject)));
    if (!identity) throw new Error("identity missing");
    return { bearer, userId: identity.user_id };
  }

  function client(apiKey: string) {
    return new EngineClient({ engine_url: ctx.baseUrl, api_key: apiKey });
  }

  test("the same fixture yields the same body and the same repeat failure on both surfaces", async () => {
    const viaHttp = await appUser();
    const viaClient = await appUser();
    const httpRes = await call(`/v1/apps/testapp/users/${viaHttp.userId}`, ctx.apiKey, {
      method: "DELETE",
    });
    expect(httpRes.status).toBe(200);
    const httpBody = await json<{ user_id: string; app_id: string; erased: true }>(httpRes);
    const clientBody = await client(ctx.apiKey).eraseAppUser("testapp", viaClient.userId);
    expect({ ...clientBody, user_id: "x" }).toEqual({ ...httpBody, user_id: "x" });
    expect(clientBody).toEqual({ user_id: viaClient.userId, app_id: "testapp", erased: true });

    await expect(
      client(ctx.apiKey).eraseAppUser("testapp", viaClient.userId),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (await call(`/v1/apps/testapp/users/${viaHttp.userId}`, ctx.apiKey, { method: "DELETE" }))
        .status,
    ).toBe(404);
  });

  test("unknown ids, foreign apps and refused callers fail the same on the sk client", async () => {
    const { bearer, userId } = await appUser();
    await expect(client(ctx.apiKey).eraseAppUser("nokit", userId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(client(ctx.apiKey).eraseAppUser("testapp", nextUuid())).rejects.toMatchObject({
      status: 404,
    });
    await expect(client(bearer).eraseAppUser("testapp", userId)).rejects.toMatchObject({
      status: 403,
    });
    await expect(client(narrowKey).eraseAppUser("testapp", userId)).rejects.toMatchObject({
      status: 403,
    });
    const [own] = await ctx.db.select().from(users).where(eq(users.id, userId));
    expect(own?.deleted_at).toBeNull();
  });

  test("a user with access outside the app is a conflict on the sk client", async () => {
    const { userId } = await appUser();
    await ctx.db.insert(userIdentities).values({
      tenant_id: ctx.tenantId,
      user_id: userId,
      provider_id: "second-app-bearer",
      product_id: "flowkit",
      subject: nextUuid(),
      email: "second-app-user@example.test",
    });
    await expect(client(ctx.apiKey).eraseAppUser("testapp", userId)).rejects.toMatchObject({
      status: 409,
    });
    const [own] = await ctx.db.select().from(users).where(eq(users.id, userId));
    expect(own?.deleted_at).toBeNull();
  });
});
