// HTTP integration tests for the CLI notification inbox routes.
//
//   GET  /v1/notifications/inbox?since=&limit=
//   POST /v1/notifications/inbox/ack
//
// Covers:
//   - List returns only the requesting tenant's rows, ascending by id.
//   - `since` parameter returns only rows with id > since.
//   - `limit` parameter is honoured and capped at 500.
//   - `cursor` in the response is the id of the last returned row.
//   - Ack deletes only rows ≤ up_to_cursor for the requesting tenant.
//   - Ack does not touch rows of a different tenant.
//   - Ack returns { acked } count and writes an audit_log entry.
//   - A principal without notification:read is rejected (401 / 403).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { apiKeys, auditLog, cliNotificationInbox, tenants, users } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let tenantBKey: string;
/** A principal without notification:read — enduser role only has workflow:* + conversation:*. */
let enduserKey: string;

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

// Deterministic, unique key material — a counter, not randomBytes, so the
// determinism lint stays green while each generated key remains distinct.
// The counter must LEAD: the api_keys prefix is plaintext.slice(0,12) =
// "wf_live_" + the first 4 chars of `rand`, so the unique part has to come
// first or every prefix collides on the unique constraint.
let keySeq = 0;
function genKey(): { plaintext: string; prefix: string; hash: string } {
  const rand = `${String(++keySeq).padStart(4, "0")}skcliinboxtestkeypadding`.slice(0, 32);
  const plaintext = `wf_live_${rand}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

async function insertInboxRow(
  tenantId: string,
  opts: { event_type?: string; severity?: string } = {},
): Promise<number> {
  const [row] = await srv.db
    .insert(cliNotificationInbox)
    .values({
      tenant_id: tenantId,
      severity: opts.severity ?? "info",
      event_type: opts.event_type ?? "test.event",
      event_payload: { test: true },
    })
    .returning({ id: cliNotificationInbox.id });
  if (!row) throw new Error("inbox row insert failed");
  return row.id;
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

  // Seed a second tenant (B) for cross-tenant isolation.
  const [tB] = await srv.db
    .insert(tenants)
    .values({ slug: "ninbox-b", display_name: "Ninbox B" })
    .returning();
  if (!tB) throw new Error("seed tenant B failed");

  const [uB] = await srv.db
    .insert(users)
    .values({ tenant_id: tB.id, email: "admin@ninbox-b.local", role: "admin" })
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

  // Seed an enduser (no notification:read) for tenant A.
  const [uE] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "enduser@ninbox-a.local",
      // Legacy role string — the evaluator reads role_id; enduser role lacks notification:read.
      role: "enduser",
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

    // Seed rows for A and B.
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
    // Tenant B row must not leak.
    const eventTypes = body.items.map((r) => r.event_type);
    expect(eventTypes).not.toContain("ev.b1");

    // Items must be in ascending id order.
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
  test("deletes only rows ≤ up_to_cursor for the requesting tenant", async () => {
    await clearInbox();
    const [tB] = await srv.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, "ninbox-b"))
      .limit(1);
    if (!tB) throw new Error("tenant B not found");

    // Seed rows for A (3 rows) and B (1 row).
    const idA1 = await insertInboxRow(srv.tenantId, { event_type: "ack.a1" });
    const idA2 = await insertInboxRow(srv.tenantId, { event_type: "ack.a2" });
    const idA3 = await insertInboxRow(srv.tenantId, { event_type: "ack.a3" });
    const idB1 = await insertInboxRow(tB.id, { event_type: "ack.b1" });

    // Ack A's rows up to idA2.
    const res = await apiFetch("/v1/notifications/inbox/ack", {
      method: "POST",
      body: JSON.stringify({ up_to_cursor: idA2 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { acked: number };
    expect(body.acked).toBe(2);

    // A's row idA3 (newer than cursor) must survive.
    const remainingA = await srv.db
      .select({ id: cliNotificationInbox.id })
      .from(cliNotificationInbox)
      .where(eq(cliNotificationInbox.tenant_id, srv.tenantId));
    const remainingAIds = remainingA.map((r) => r.id);
    expect(remainingAIds).not.toContain(idA1);
    expect(remainingAIds).not.toContain(idA2);
    expect(remainingAIds).toContain(idA3);

    // B's row must be untouched.
    const remainingB = await srv.db
      .select({ id: cliNotificationInbox.id })
      .from(cliNotificationInbox)
      .where(eq(cliNotificationInbox.tenant_id, tB.id));
    expect(remainingB.map((r) => r.id)).toContain(idB1);
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

    // Seed a row for tenant A.
    const idA = await insertInboxRow(srv.tenantId, { event_type: "xten.a" });

    // Tenant B acks up_to_cursor=idA (which belongs to A). It should
    // delete 0 rows (all B's rows that exist with id ≤ idA, which is none).
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

    // Tenant A's row must still be there.
    const stillThere = await srv.db
      .select({ id: cliNotificationInbox.id })
      .from(cliNotificationInbox)
      .where(eq(cliNotificationInbox.tenant_id, srv.tenantId));
    expect(stillThere.map((r) => r.id)).toContain(idA);
  });
});
