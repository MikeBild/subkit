import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  auditLog,
  cliNotificationInbox,
  cliNotificationInboxReads,
  tenants,
} from "../../db/schema/index.ts";
import {
  ack,
  apiFetch,
  clearInbox,
  colleagueKey,
  enduserKey,
  insertInboxRow,
  listInbox,
  setupNotificationsInbox,
  srv,
  tenantBKey,
} from "./notifications-inbox-fixtures.ts";

setupNotificationsInbox();

describe("GET /v1/notifications/inbox", () => {
  test("returns only tenant A rows in ascending id order", async () => {
    await clearInbox();
    const [tB] = await srv.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, "ninbox-b"))
      .limit(1);
    if (!tB) throw new Error("tenant B not found");

    const idA1 = await insertInboxRow(srv.tenantId, { event_type: "ev.a1" });
    const idA2 = await insertInboxRow(srv.tenantId, { event_type: "ev.a2" });
    await insertInboxRow(tB.id, { event_type: "ev.b1" });

    const res = await apiFetch("/v1/notifications/inbox?since=0");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: number; event_type: string }>;
      cursor: number;
    };

    expect(Array.isArray(body.items)).toBe(true);
    const ids = body.items.map((r) => r.id);
    expect(ids).toContain(idA1);
    expect(ids).toContain(idA2);
    const eventTypes = body.items.map((r) => r.event_type);
    expect(eventTypes).not.toContain("ev.b1");

    for (let i = 1; i < body.items.length; i++) {
      expect(body.items[i]!.id).toBeGreaterThan(body.items[i - 1]!.id);
    }
  });

  test("since parameter returns only rows with id > since", async () => {
    await clearInbox();

    const idOld = await insertInboxRow(srv.tenantId, { event_type: "ev.old" });
    const idNew = await insertInboxRow(srv.tenantId, { event_type: "ev.new" });

    const res = await apiFetch(`/v1/notifications/inbox?since=${idOld}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: number }>; cursor: number };

    const ids = body.items.map((r) => r.id);
    expect(ids).not.toContain(idOld);
    expect(ids).toContain(idNew);
  });

  test("cursor equals the id of the last returned row", async () => {
    await clearInbox();

    const id1 = await insertInboxRow(srv.tenantId);
    const id2 = await insertInboxRow(srv.tenantId);

    const res = await apiFetch("/v1/notifications/inbox?since=0");
    const body = (await res.json()) as { items: Array<{ id: number }>; cursor: number };

    const maxId = Math.max(id1, id2);
    expect(body.cursor).toBe(maxId);
  });

  test("cursor equals since when no rows match", async () => {
    await clearInbox();

    const res = await apiFetch("/v1/notifications/inbox?since=9999999");
    const body = (await res.json()) as { items: unknown[]; cursor: number };

    expect(body.items.length).toBe(0);
    expect(body.cursor).toBe(9999999);
  });

  test("limit parameter is honoured", async () => {
    await clearInbox();

    for (let i = 0; i < 5; i++) {
      await insertInboxRow(srv.tenantId, { event_type: `ev.limit.${i}` });
    }

    const res = await apiFetch("/v1/notifications/inbox?since=0&limit=2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items.length).toBe(2);
  });

  test("unauthenticated request → 401", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/notifications/inbox`);
    expect(res.status).toBe(401);
  });

  test("enduser principal (no notification:read) → 403", async () => {
    const res = await apiFetch("/v1/notifications/inbox", {}, enduserKey);
    expect(res.status).toBe(403);
  });
});

describe("POST /v1/notifications/inbox/ack", () => {
  test("marks rows ≤ up_to_cursor read for the caller without deleting them", async () => {
    await clearInbox();
    const [tB] = await srv.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, "ninbox-b"))
      .limit(1);
    if (!tB) throw new Error("tenant B not found");

    const idA1 = await insertInboxRow(srv.tenantId, { event_type: "ack.a1" });
    const idA2 = await insertInboxRow(srv.tenantId, { event_type: "ack.a2" });
    const idA3 = await insertInboxRow(srv.tenantId, { event_type: "ack.a3" });
    const idB1 = await insertInboxRow(tB.id, { event_type: "ack.b1" });

    const res = await ack(idA2);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { acked: number };
    expect(body.acked).toBe(2);

    const remainingA = await srv.db
      .select({ id: cliNotificationInbox.id })
      .from(cliNotificationInbox)
      .where(eq(cliNotificationInbox.tenant_id, srv.tenantId));
    const remainingAIds = remainingA.map((r) => r.id);
    expect(remainingAIds).toContain(idA1);
    expect(remainingAIds).toContain(idA2);
    expect(remainingAIds).toContain(idA3);

    const list = await listInbox("?since=0");
    const byId = new Map(list.items.map((i) => [i.id, i]));
    expect(byId.get(idA1)?.read).toBe(true);
    expect(byId.get(idA2)?.read).toBe(true);
    expect(byId.get(idA1)?.read_at).not.toBeNull();
    expect(byId.get(idA3)?.read).toBe(false);
    expect(byId.get(idA3)?.read_at).toBeNull();
    expect(list.unread_count).toBe(1);

    const remainingB = await srv.db
      .select({ id: cliNotificationInbox.id })
      .from(cliNotificationInbox)
      .where(eq(cliNotificationInbox.tenant_id, tB.id));
    expect(remainingB.map((r) => r.id)).toContain(idB1);
  });

  test("acking twice is idempotent: the second ack marks nothing new", async () => {
    await clearInbox();
    const id1 = await insertInboxRow(srv.tenantId, { event_type: "ack.twice.1" });
    const id2 = await insertInboxRow(srv.tenantId, { event_type: "ack.twice.2" });

    const first = (await (await ack(id2)).json()) as { acked: number };
    expect(first.acked).toBe(2);
    const second = (await (await ack(id2)).json()) as { acked: number };
    expect(second.acked).toBe(0);
    expect(id1).toBeLessThan(id2);
  });

  test("one operator's ack does not empty a colleague's inbox in the same tenant", async () => {
    await clearInbox();
    const id1 = await insertInboxRow(srv.tenantId, { event_type: "shared.1" });
    const id2 = await insertInboxRow(srv.tenantId, { event_type: "shared.2" });

    const acked = (await (await ack(id2)).json()) as { acked: number };
    expect(acked.acked).toBe(2);

    const colleagueView = await listInbox("?since=0", colleagueKey);
    const colleagueIds = colleagueView.items.map((i) => i.id);
    expect(colleagueIds).toContain(id1);
    expect(colleagueIds).toContain(id2);
    expect(colleagueView.items.every((i) => i.read === false)).toBe(true);
    expect(colleagueView.unread_count).toBe(2);

    const colleagueUnread = await listInbox("?since=0&unread_only=true", colleagueKey);
    expect(colleagueUnread.items.length).toBe(2);

    const ackerUnread = await listInbox("?since=0&unread_only=true");
    expect(ackerUnread.items.length).toBe(0);
    expect(ackerUnread.unread_count).toBe(0);
  });

  test("ack writes an audit_log row with action sk_cli.inbox_acked", async () => {
    await clearInbox();
    const id = await insertInboxRow(srv.tenantId, { event_type: "ack.audit" });

    await apiFetch("/v1/notifications/inbox/ack", {
      method: "POST",
      body: JSON.stringify({ up_to_cursor: id }),
    });

    const auditRows = await srv.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenant_id, srv.tenantId));
    const ackRow = auditRows.find((r) => r.action === "sk_cli.inbox_acked");
    expect(ackRow).toBeDefined();
  });

  test("ack returns { acked: 0 } when cursor is before all rows", async () => {
    await clearInbox();
    await insertInboxRow(srv.tenantId);

    const res = await apiFetch("/v1/notifications/inbox/ack", {
      method: "POST",
      body: JSON.stringify({ up_to_cursor: 0 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { acked: number };
    expect(body.acked).toBe(0);
  });

  test("unauthenticated ack → 401", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/notifications/inbox/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ up_to_cursor: 1 }),
    });
    expect(res.status).toBe(401);
  });

  test("enduser principal (no notification:read) ack → 403", async () => {
    const res = await apiFetch(
      "/v1/notifications/inbox/ack",
      {
        method: "POST",
        body: JSON.stringify({ up_to_cursor: 1 }),
      },
      enduserKey,
    );
    expect(res.status).toBe(403);
  });

  test("cross-tenant: tenant B cannot ack tenant A rows by targeting same cursor ids", async () => {
    await clearInbox();
    const [tB] = await srv.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, "ninbox-b"))
      .limit(1);
    if (!tB) throw new Error("tenant B not found");

    const idA = await insertInboxRow(srv.tenantId, { event_type: "xten.a" });

    const res = await apiFetch(
      "/v1/notifications/inbox/ack",
      {
        method: "POST",
        body: JSON.stringify({ up_to_cursor: idA }),
      },
      tenantBKey,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { acked: number };
    expect(body.acked).toBe(0);

    const stillThere = await srv.db
      .select({ id: cliNotificationInbox.id })
      .from(cliNotificationInbox)
      .where(eq(cliNotificationInbox.tenant_id, srv.tenantId));
    expect(stillThere.map((r) => r.id)).toContain(idA);
  });

  test("cross-tenant: tenant B's ack writes no read mark against tenant A's rows", async () => {
    await clearInbox();
    const [tB] = await srv.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, "ninbox-b"))
      .limit(1);
    if (!tB) throw new Error("tenant B not found");

    const idA = await insertInboxRow(srv.tenantId, { event_type: "xten.mark.a" });
    await ack(idA, tenantBKey);

    const marks = await srv.db
      .select({ inbox_id: cliNotificationInboxReads.inbox_id })
      .from(cliNotificationInboxReads)
      .where(eq(cliNotificationInboxReads.tenant_id, srv.tenantId));
    expect(marks.map((m) => m.inbox_id)).not.toContain(idA);

    const list = await listInbox("?since=0");
    expect(list.items.find((i) => i.id === idA)?.read).toBe(false);
  });
});
