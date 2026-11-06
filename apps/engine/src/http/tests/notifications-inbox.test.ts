import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  apiKeys,
  auditLog,
  cliNotificationInbox,
  cliNotificationInboxReads,
  tenants,
  users,
} from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let tenantBKey: string;
let enduserKey: string;
let colleagueKey: string;
let systemAccountKey: string;

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

let keySeq = 0;
function genKey(): { plaintext: string; prefix: string; hash: string } {
  const rand = `${String(++keySeq).padStart(4, "0")}skcliinboxtestkeypadding`.slice(0, 32);
  const plaintext = `wf_live_${rand}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

async function insertInboxRow(
  tenantId: string,
  opts: { event_type?: string; severity?: string; actionable?: boolean } = {},
): Promise<number> {
  const [row] = await srv.db
    .insert(cliNotificationInbox)
    .values({
      tenant_id: tenantId,
      severity: opts.severity ?? "info",
      event_type: opts.event_type ?? "test.event",
      event_payload: { test: true },
      actionable: opts.actionable ?? false,
    })
    .returning({ id: cliNotificationInbox.id });
  if (!row) throw new Error("inbox row insert failed");
  return row.id;
}

interface InboxItem {
  id: number;
  severity: string;
  event_type: string;
  actionable: boolean;
  resource_type: string | null;
  resource_id: string | null;
  read: boolean;
  read_at: string | null;
}

interface InboxList {
  items: InboxItem[];
  cursor: number;
  unread_count: number;
  actionable_unread_count: number;
}

async function listInbox(query: string, token?: string): Promise<InboxList> {
  const res = await apiFetch(`/v1/notifications/inbox${query}`, {}, token);
  expect(res.status).toBe(200);
  return (await res.json()) as InboxList;
}

function ack(upToCursor: number, token?: string): Promise<Response> {
  return apiFetch(
    "/v1/notifications/inbox/ack",
    { method: "POST", body: JSON.stringify({ up_to_cursor: upToCursor }) },
    token,
  );
}

function apiFetch(path: string, init: RequestInit = {}, token?: string): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token ?? srv.apiKey}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(`${srv.baseUrl}${path}`, { ...init, headers });
}

beforeAll(async () => {
  srv = await createHttpTestServer("notifications-inbox");

  const tB = await seedTenant(srv.db, { slug: "ninbox-b", display_name: "Ninbox B" });

  const [uB] = await srv.db
    .insert(users)
    .values({
      tenant_id: tB.id,
      email: "admin@ninbox-b.local",
      role_id: await builtinRoleId(srv.db, "admin"),
    })
    .returning();
  if (!uB) throw new Error("seed user B failed");
  const kB = genKey();
  await srv.db.insert(apiKeys).values({
    tenant_id: tB.id,
    user_id: uB.id,
    prefix: kB.prefix,
    token_sha256: kB.hash,
    scopes: ["*"],
  });
  tenantBKey = kB.plaintext;

  const [uE] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "enduser@ninbox-a.local",
      role_id: await builtinRoleId(srv.db, "enduser"),
    })
    .returning();
  if (!uE) throw new Error("seed enduser failed");
  const kE = genKey();
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    user_id: uE.id,
    prefix: kE.prefix,
    token_sha256: kE.hash,
    scopes: ["*"],
  });
  enduserKey = kE.plaintext;

  const [uC] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "colleague@ninbox-a.local",
      role_id: await builtinRoleId(srv.db, "admin"),
    })
    .returning();
  if (!uC) throw new Error("seed colleague failed");
  const kC = genKey();
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    user_id: uC.id,
    prefix: kC.prefix,
    token_sha256: kC.hash,
    scopes: ["*"],
  });
  colleagueKey = kC.plaintext;

  const kS = genKey();
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    system_account_id: srv.systemAccountId,
    prefix: kS.prefix,
    token_sha256: kS.hash,
    scopes: ["*"],
  });
  systemAccountKey = kS.plaintext;
}, 60_000);

afterAll(async () => {
  await srv.cleanup();
}, 30_000);

async function clearInbox(): Promise<void> {
  await srv.db.delete(cliNotificationInbox);
  await srv.db.delete(auditLog);
}

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
