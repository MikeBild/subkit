// GC6 — session sliding + absolute TTL enforcement.
//
// The identity service `createSession` helper seeds a fresh session
// row with `last_seen_at = now` and `absolute_expires_at = now + 30d`.
// `resolveSession` bumps `last_seen_at` on each successful resolve and
// rejects with typed reasons:
//   - `expired_sliding`  : now - last_seen_at > 8h
//   - `expired_absolute` : now > absolute_expires_at
// Both rejections write a `session.revoked` audit row.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, sessions } from "../../db/schema/index.ts";
import { createSession, resolveSession } from "../../identity/service.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

const TEST_NOW_MS = 1_700_000_000_000;

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("session-ttl");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("identity/service session TTL", () => {
  test("sliding expiry: last_seen_at older than 8h -> rejected", async () => {
    const session = await createSession({ tenant_id: ctx.tenantId, user_id: ctx.userId }, ctx.db);
    // Force last_seen_at 9h in the past so the sliding window has
    // elapsed on the next resolve.
    const nineHoursAgo = new Date(TEST_NOW_MS - 9 * 60 * 60 * 1000);
    await ctx.db
      .update(sessions)
      .set({ last_seen_at: nineHoursAgo })
      .where(eq(sessions.id, session.id));

    const result = await resolveSession(session.id, ctx.db);
    expect(result.session).toBeNull();
    expect(result.reason).toBe("expired_sliding");

    // Audit row with reason=expired_sliding must exist.
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.resource_id, session.id), eq(auditLog.action, "session.revoked")));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.reason).toBe("expired_sliding");
  });

  test("absolute expiry: absolute_expires_at in the past -> rejected", async () => {
    const session = await createSession({ tenant_id: ctx.tenantId, user_id: ctx.userId }, ctx.db);
    const past = new Date(TEST_NOW_MS - 1000);
    await ctx.db
      .update(sessions)
      .set({ absolute_expires_at: past, last_seen_at: new Date(TEST_NOW_MS) })
      .where(eq(sessions.id, session.id));

    const result = await resolveSession(session.id, ctx.db);
    expect(result.session).toBeNull();
    expect(result.reason).toBe("expired_absolute");

    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.resource_id, session.id), eq(auditLog.action, "session.revoked")));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.reason === "expired_absolute")).toBe(true);
  });

  test("valid session: resolves and bumps last_seen_at", async () => {
    const session = await createSession({ tenant_id: ctx.tenantId, user_id: ctx.userId }, ctx.db);
    // Move last_seen_at back a few seconds so the bump is observable.
    const backdate = new Date(TEST_NOW_MS - 5_000);
    await ctx.db
      .update(sessions)
      .set({ last_seen_at: backdate })
      .where(eq(sessions.id, session.id));

    const result = await resolveSession(session.id, ctx.db);
    expect(result.session).not.toBeNull();
    expect(result.reason).toBeUndefined();
    expect(result.session?.last_seen_at.getTime()).toBeGreaterThan(backdate.getTime());
  });
});
