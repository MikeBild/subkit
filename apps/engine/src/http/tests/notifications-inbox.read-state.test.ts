import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cliNotificationInboxReads, tenants } from "../../db/schema/index.ts";
import {
  ack,
  apiFetch,
  clearInbox,
  colleagueKey,
  insertInboxRow,
  listInbox,
  setupNotificationsInbox,
  srv,
  systemAccountKey,
} from "./notifications-inbox-fixtures.ts";

setupNotificationsInbox();

describe("inbox filters", () => {
  test("unread_only excludes rows this caller already read", async () => {
    await clearInbox();
    const id1 = await insertInboxRow(srv.tenantId, { event_type: "filter.unread.1" });
    const id2 = await insertInboxRow(srv.tenantId, { event_type: "filter.unread.2" });

    await ack(id1);

    const unread = await listInbox("?since=0&unread_only=true");
    const ids = unread.items.map((i) => i.id);
    expect(ids).not.toContain(id1);
    expect(ids).toContain(id2);
    expect(unread.unread_count).toBe(1);

    const all = await listInbox("?since=0");
    expect(all.items.length).toBe(2);
  });

  test("actionable_only filters on the persisted column and pages without empty pages", async () => {
    await clearInbox();
    const ids: number[] = [];
    for (const actionable of [false, true, false, false, true]) {
      ids.push(
        await insertInboxRow(srv.tenantId, {
          event_type: actionable ? "page.actionable" : "page.info",
          actionable,
        }),
      );
    }
    const expectedActionable = [ids[1], ids[4]];

    const seen: number[] = [];
    let pages = 0;
    let cursor = 0;
    for (let i = 0; i < 10; i++) {
      const page = await listInbox(`?since=${cursor}&limit=1&actionable_only=true`);
      if (page.items.length === 0) break;
      pages++;
      for (const item of page.items) {
        expect(item.actionable).toBe(true);
        seen.push(item.id);
      }
      cursor = page.cursor;
    }

    expect(seen).toEqual(expectedActionable as number[]);
    expect(pages).toBe(2);
  });

  test("actionable_unread_count tracks the actionable slice of the unread set", async () => {
    await clearInbox();
    await insertInboxRow(srv.tenantId, { event_type: "count.info", actionable: false });
    const act1 = await insertInboxRow(srv.tenantId, {
      event_type: "count.act1",
      actionable: true,
    });
    await insertInboxRow(srv.tenantId, { event_type: "count.act2", actionable: true });

    const before = await listInbox("?since=0");
    expect(before.unread_count).toBe(3);
    expect(before.actionable_unread_count).toBe(2);

    await ack(act1);

    const after = await listInbox("?since=0");
    expect(after.unread_count).toBe(1);
    expect(after.actionable_unread_count).toBe(1);
  });
});

describe("POST /v1/notifications/inbox/{read,unread}", () => {
  test("read marks the listed ids and unread restores them", async () => {
    await clearInbox();
    const id1 = await insertInboxRow(srv.tenantId, { event_type: "mark.1", actionable: true });
    const id2 = await insertInboxRow(srv.tenantId, { event_type: "mark.2" });

    const readRes = await apiFetch("/v1/notifications/inbox/read", {
      method: "POST",
      body: JSON.stringify({ ids: [id1] }),
    });
    expect(readRes.status).toBe(200);
    expect((await readRes.json()) as { marked: number }).toEqual({ marked: 1 });

    const afterRead = await listInbox("?since=0");
    expect(afterRead.items.find((i) => i.id === id1)?.read).toBe(true);
    expect(afterRead.items.find((i) => i.id === id2)?.read).toBe(false);
    expect(afterRead.unread_count).toBe(1);
    expect(afterRead.actionable_unread_count).toBe(0);

    const unreadRes = await apiFetch("/v1/notifications/inbox/unread", {
      method: "POST",
      body: JSON.stringify({ ids: [id1] }),
    });
    expect(unreadRes.status).toBe(200);
    expect((await unreadRes.json()) as { unmarked: number }).toEqual({ unmarked: 1 });

    const afterUnread = await listInbox("?since=0");
    expect(afterUnread.items.find((i) => i.id === id1)?.read).toBe(false);
    expect(afterUnread.items.find((i) => i.id === id1)?.read_at).toBeNull();
    expect(afterUnread.unread_count).toBe(2);
    expect(afterUnread.actionable_unread_count).toBe(1);
  });

  test("read is idempotent and never marks another tenant's rows", async () => {
    await clearInbox();
    const [tB] = await srv.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, "ninbox-b"))
      .limit(1);
    if (!tB) throw new Error("tenant B not found");

    const idA = await insertInboxRow(srv.tenantId, { event_type: "mark.iso.a" });
    const idB = await insertInboxRow(tB.id, { event_type: "mark.iso.b" });

    const first = await apiFetch("/v1/notifications/inbox/read", {
      method: "POST",
      body: JSON.stringify({ ids: [idA, idB] }),
    });
    expect((await first.json()) as { marked: number }).toEqual({ marked: 1 });

    const second = await apiFetch("/v1/notifications/inbox/read", {
      method: "POST",
      body: JSON.stringify({ ids: [idA] }),
    });
    expect((await second.json()) as { marked: number }).toEqual({ marked: 0 });

    const marksForB = await srv.db
      .select({ inbox_id: cliNotificationInboxReads.inbox_id })
      .from(cliNotificationInboxReads)
      .where(eq(cliNotificationInboxReads.tenant_id, tB.id));
    expect(marksForB.length).toBe(0);
  });

  test("unread only removes the caller's own mark", async () => {
    await clearInbox();
    const id = await insertInboxRow(srv.tenantId, { event_type: "mark.own" });

    await ack(id);
    await ack(id, colleagueKey);

    const unmark = await apiFetch("/v1/notifications/inbox/unread", {
      method: "POST",
      body: JSON.stringify({ ids: [id] }),
    });
    expect((await unmark.json()) as { unmarked: number }).toEqual({ unmarked: 1 });

    expect((await listInbox("?since=0")).items[0]?.read).toBe(false);
    expect((await listInbox("?since=0", colleagueKey)).items[0]?.read).toBe(true);
  });
});

describe("system-account principal has no read state of its own", () => {
  test("GET reports read:false on every item", async () => {
    await clearInbox();
    const id = await insertInboxRow(srv.tenantId, { event_type: "sysacct.1" });
    await ack(id);

    const list = await listInbox("?since=0", systemAccountKey);
    expect(list.items.length).toBe(1);
    expect(list.items[0]?.read).toBe(false);
    expect(list.items[0]?.read_at).toBeNull();
    expect(list.unread_count).toBe(1);
  });

  test("POST /read → 400 principal_not_user", async () => {
    await clearInbox();
    const id = await insertInboxRow(srv.tenantId, { event_type: "sysacct.2" });

    const res = await apiFetch(
      "/v1/notifications/inbox/read",
      { method: "POST", body: JSON.stringify({ ids: [id] }) },
      systemAccountKey,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; error?: { code?: string } };
    expect(body.code ?? body.error?.code).toBe("principal_not_user");

    const marks = await srv.db.select().from(cliNotificationInboxReads);
    expect(marks.length).toBe(0);
  });

  test("POST /ack → 400 principal_not_user", async () => {
    await clearInbox();
    const id = await insertInboxRow(srv.tenantId, { event_type: "sysacct.3" });

    const res = await ack(id, systemAccountKey);
    expect(res.status).toBe(400);
  });
});
