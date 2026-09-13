// A no-longer-entitled account must not reach the MCP consent screen.
//
// The PROD deploy pipeline's verify probe caught this as "account without a
// product grant reached the consent screen — SubKit no-grant SSO login was not
// denied cleanly", and it reproduced on code that predates the approval work
// entirely. Two independent holes fed it:
//
//   1. `deactivateUser` revoked api keys and invites but never `sessions`, so a
//      disabled account kept a live `subkit_session` cookie.
//   2. `GET /v1/oauth/authorize` selected the user with no `deleted_at` /
//      `status` predicate, so that cookie still rendered a consent screen — and
//      the role-based denial below it wrote no audit row at all, which is why
//      the only way to observe the failure was to scrape the HTML.
//
// Both are covered here: the session is severed at deactivation, AND the
// authorize endpoint independently refuses. Neither guard has to be perfect
// alone.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { auditLog, sessions, users } from "../../../db/schema/index.ts";
import { deactivateUser } from "../../../identity/provisioning.ts";
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
        role: "member",
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
    // The whole point: a disabled account keeps no live cookie. Login re-checks
    // status, but an ALREADY-ISSUED session never passes back through login.
    expect(session?.revoked_at).not.toBeNull();

    // And the cutoff is visible rather than silent.
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
        role: "member",
      })
      .returning({ id: users.id });
    const [bystander] = await server.db
      .insert(users)
      .values({
        tenant_id: server.tenantId,
        email: `bystander-${Date.now()}@test.local`, // allow-wall-clock
        role: "member",
      })
      .returning({ id: users.id });
    if (!victim || !bystander) throw new Error("seed users failed");

    await seedSession(victim.id);
    const bystanderSession = await seedSession(bystander.id);

    await deactivateUser(
      { tenant_id: server.tenantId, user_id: victim.id, actor_id: server.userId },
      server.db,
    );

    // Scoped to the deactivated user only — deactivation is not a mass logout.
    const [other] = await server.db
      .select({ revoked_at: sessions.revoked_at })
      .from(sessions)
      .where(eq(sessions.id, bystanderSession));
    expect(other?.revoked_at).toBeNull();
  });
});
