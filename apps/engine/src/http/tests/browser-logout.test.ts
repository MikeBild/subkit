import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, sessions } from "../../db/schema/index.ts";
import { browserSessionHeaders, createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("browser-logout");
});

afterAll(async () => {
  await ctx.cleanup();
});

function sessionIdFrom(headers: Record<string, string>): string {
  const raw = decodeURIComponent((headers.cookie ?? "").split("=")[1] ?? "");
  const claims = JSON.parse(Buffer.from(raw.split(".")[1] ?? "", "base64url").toString());
  return claims.session_id as string;
}

function sessionCookies(res: Response): string[] {
  return res.headers.getSetCookie().filter((cookie) => cookie.startsWith("subkit_session="));
}

async function revokedAt(sessionId: string): Promise<Date | null> {
  const [row] = await ctx.db.select().from(sessions).where(eq(sessions.id, sessionId));
  return row?.revoked_at ?? null;
}

describe("browser logout and session expiry", () => {
  test("logout revokes the session and clears its cookie once", async () => {
    const headers = await browserSessionHeaders(ctx, ctx.userId);
    const res = await fetch(`${ctx.baseUrl}/v1/identity/logout`, { method: "POST", headers });
    expect(res.status).toBe(204);
    const cleared = sessionCookies(res);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toContain("Max-Age=0");
    expect(await revokedAt(sessionIdFrom(headers))).not.toBeNull();

    const after = await fetch(`${ctx.baseUrl}/v1/identity/whoami`, { headers });
    expect(after.status).toBe(401);
  });

  test("logout with a dead session still clears the cookie", async () => {
    const headers = await browserSessionHeaders(ctx, ctx.userId);
    await ctx.db
      .update(sessions)
      .set({ revoked_at: new Date() }) // allow-wall-clock: live browser fixture
      .where(eq(sessions.id, sessionIdFrom(headers)));
    const res = await fetch(`${ctx.baseUrl}/v1/identity/logout`, { method: "POST", headers });
    expect(res.status).toBe(204);
    expect(sessionCookies(res)).toHaveLength(1);
  });

  test("an expired session is marked once and its cookie is cleared", async () => {
    const headers = await browserSessionHeaders(ctx, ctx.userId);
    const sessionId = sessionIdFrom(headers);
    await ctx.db
      .update(sessions)
      .set({ last_seen_at: new Date(Date.now() - 9 * 60 * 60 * 1000) }) // allow-wall-clock: live browser fixture
      .where(eq(sessions.id, sessionId));

    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${ctx.baseUrl}/v1/identity/whoami`, { headers });
      expect(res.status).toBe(401);
      const cleared = sessionCookies(res);
      expect(cleared).toHaveLength(1);
      expect(cleared[0]).toContain("Max-Age=0");
    }

    expect(await revokedAt(sessionId)).not.toBeNull();
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.resource_id, sessionId), eq(auditLog.action, "session.revoked")));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.reason).toBe("expired_sliding");
  });
});
