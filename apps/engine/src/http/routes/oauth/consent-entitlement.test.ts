import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, sessions, users } from "../../../db/schema/index.ts";
import { deactivateUser } from "../../../identity/provisioning.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let server: HttpTestServer;

beforeAll(async () => {
  server = await createHttpTestServer("consent-entitlement");
});

afterAll(async () => {
  await server.cleanup();
});

async function seedSession(user_id: string): Promise<string> {
  const [row] = await server.db
    .insert(sessions)
    .values({
      tenant_id: server.tenantId,
      user_id,
      token_sha256: `sha-${user_id}-${Date.now()}`, // allow-wall-clock
      expires_at: new Date(Date.now() + 60 * 60_000), // allow-wall-clock
      absolute_expires_at: new Date(Date.now() + 24 * 60 * 60_000), // allow-wall-clock
      last_seen_at: new Date(),
    })
    .returning({ id: sessions.id });
  if (!row) throw new Error("seed session failed");
  return row.id;
}

describe("deactivating a user severs their browser sessions", () => {
  test("a live session is revoked in the same transaction as the disable", async () => {
    const [user] = await server.db
      .insert(users)
      .values({
        tenant_id: server.tenantId,
        email: `deactivate-sessions-${Date.now()}@test.local`, // allow-wall-clock
        role_id: await builtinRoleId(server.db, "member"),
      })
      .returning({ id: users.id });
    if (!user) throw new Error("seed user failed");
    const sessionId = await seedSession(user.id);

    const result = await deactivateUser(
      { tenant_id: server.tenantId, user_id: user.id, actor_id: server.userId },
      server.db,
    );
    expect(result).not.toBeNull();

    const [session] = await server.db
      .select({ revoked_at: sessions.revoked_at })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(session?.revoked_at).not.toBeNull();

    const revokedAudit = await server.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, server.tenantId),
          eq(auditLog.action, "session.revoked"),
          eq(auditLog.resource_id, sessionId),
        ),
      );
    expect(revokedAudit).toHaveLength(1);
  });

  test("an already-revoked session is not re-revoked, and a live one elsewhere is untouched", async () => {
    const [victim] = await server.db
      .insert(users)
      .values({
        tenant_id: server.tenantId,
        email: `deactivate-scope-${Date.now()}@test.local`, // allow-wall-clock
        role_id: await builtinRoleId(server.db, "member"),
      })
      .returning({ id: users.id });
    const [bystander] = await server.db
      .insert(users)
      .values({
        tenant_id: server.tenantId,
        email: `bystander-${Date.now()}@test.local`, // allow-wall-clock
        role_id: await builtinRoleId(server.db, "member"),
      })
      .returning({ id: users.id });
    if (!victim || !bystander) throw new Error("seed users failed");

    await seedSession(victim.id);
    const bystanderSession = await seedSession(bystander.id);

    await deactivateUser(
      { tenant_id: server.tenantId, user_id: victim.id, actor_id: server.userId },
      server.db,
    );

    const [other] = await server.db
      .select({ revoked_at: sessions.revoked_at })
      .from(sessions)
      .where(eq(sessions.id, bystanderSession));
    expect(other?.revoked_at).toBeNull();
  });
});
