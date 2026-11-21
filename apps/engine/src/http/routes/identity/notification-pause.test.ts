import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../../audit/types.ts";
import { auditLog } from "../../../db/schema/index.ts";
import { personalDelivery, streamDeliveryState } from "../../../notifications/index.ts";
import { ctx, login, setupBrowserMemberships } from "../../tests/memberships-fixtures.ts";

setupBrowserMemberships();

type Session = Awaited<ReturnType<typeof login>>;

function headers(session: Session) {
  return {
    cookie: session.cookie,
    "x-subkit-tenant": session.payload.tenant_id,
    "x-subkit-csrf": session.csrf,
    "content-type": "application/json",
  };
}

async function call(method: string, session: Session, body?: unknown) {
  const response = await fetch(`${ctx.baseUrl}/v1/identity/me/notification-pause`, {
    method,
    headers: headers(session),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("the personal notification pause", () => {
  test("starts off, pauses for an hour, is shared by every client and resumes", async () => {
    const person = await login("pause-hour");
    expect(await call("GET", person)).toEqual({
      status: 200,
      body: { paused: false, mode: null, paused_at: null, until: null },
    });

    const paused = await call("PUT", person, { mode: "for", minutes: 60 });
    expect(paused.status).toBe(200);
    expect(paused.body).toMatchObject({ paused: true, mode: "until" });
    const started = Date.parse(String(paused.body.paused_at));
    expect(Date.parse(String(paused.body.until)) - started).toBe(60 * 60_000);
    expect((await call("GET", person)).body).toEqual(paused.body);

    const owner = { tenant_id: person.payload.tenant_id, user_id: person.payload.user_id };
    const delivery = await personalDelivery(ctx.db, owner, new Date(started + 1_000));
    expect(streamDeliveryState(delivery)).toMatchObject({ delivery: "held", held_by: "pause" });

    const resumed = await call("DELETE", person);
    expect(resumed.body).toEqual({ paused: false, mode: null, paused_at: null, until: null });

    const actions = (
      await ctx.db
        .select({ action: auditLog.action, actor: auditLog.actor_id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, person.payload.tenant_id),
            eq(auditLog.resource_id, person.payload.user_id),
          ),
        )
    ).map((row) => row.action);
    expect(actions).toContain(AuditAction.USER_NOTIFICATIONS_PAUSED);
    expect(actions).toContain(AuditAction.USER_NOTIFICATIONS_RESUMED);
  });

  test("a pause until resumed has no end", async () => {
    const person = await login("pause-open");
    const paused = await call("PUT", person, { mode: "until_resumed" });
    expect(paused.body).toMatchObject({ paused: true, mode: "until_resumed", until: null });
  });

  test("an end in the past and an unknown mode are refused", async () => {
    const person = await login("pause-refused");
    const past = await call("PUT", person, { mode: "until", until: "2000-01-01T00:00:00Z" });
    expect(past.status).toBe(422);
    expect(past.body.code).toBe("pause_in_past");
    const unknown = await call("PUT", person, { mode: "forever" });
    expect(unknown.status).toBe(400);
    expect((await call("GET", person)).body.paused).toBe(false);
  });

  test("without a session nothing is read", async () => {
    const response = await fetch(`${ctx.baseUrl}/v1/identity/me/notification-pause`);
    expect(response.status).toBe(401);
  });
});
