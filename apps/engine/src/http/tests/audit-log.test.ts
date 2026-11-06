import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { auditAwait } from "../../audit/audit.ts";
import { apiKeys, users } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { adminHeaders } from "../../test-helpers/seed.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let memberKey = "";
let seededIds: string[] = [];
let seedStartIso = "";
let seedEndIso = "";

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

function newKey(): { plaintext: string; prefix: string; hash: string } {
  const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: legacy; review before changing
  const plaintext = `wf_live_${rand}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

async function seedAudit(action: string, delay = 10): Promise<string> {
  await new Promise((r) => setTimeout(r, delay)); // allow-wall-clock: delay-bounded helper used by audit-log retention assertions
  const row = await auditAwait(
    {
      tenant_id: srv.tenantId,
      actor_type: "user",
      actor_id: srv.userId,
      action: action as never,
      resource_type: "audit_test",
      resource_id: crypto.randomUUID(), // allow-random: legacy; review before changing
      result: "success",
      metadata: { seeded: true },
    },
    srv.db,
  );
  return row.id;
}

beforeAll(async () => {
  srv = await createHttpTestServer("audit-log");

  seedStartIso = new Date(getTestNow() - 1000).toISOString();
  seededIds = [];
  seededIds.push(await seedAudit("workflow.created"));
  seededIds.push(await seedAudit("workflow.updated"));
  seededIds.push(await seedAudit("workflow.deleted"));
  seededIds.push(await seedAudit("connector.created"));
  seededIds.push(await seedAudit("connector.updated"));
  seedEndIso = new Date(getTestNow() + 1000).toISOString();

  const [member] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "member-audit@test.local",
      role_id: await builtinRoleId(srv.db, "member"),
    })
    .returning();
  if (!member) throw new Error("seed member failed");
  const key = newKey();
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    user_id: member.id,
    prefix: key.prefix,
    token_sha256: key.hash,
    scopes: ["*"],
  });
  memberKey = key.plaintext;
});

afterAll(async () => {
  await srv.cleanup();
});

describe("/v1/audit-log", () => {
  test("lists rows for the caller's tenant", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/audit-log?limit=500`, {
      headers: adminHeaders(srv.apiKey),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: string; action: string; tenant_id: string }>;
      next_cursor: string | null;
    };
    for (const row of body.items) expect(row.tenant_id).toBe(srv.tenantId);
    const ids = new Set(body.items.map((r) => r.id));
    for (const id of seededIds) expect(ids.has(id)).toBe(true);
  });

  test("filters by action", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/audit-log?action=workflow.created`, {
      headers: adminHeaders(srv.apiKey),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ action: string }> };
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    for (const row of body.items) expect(row.action).toBe("workflow.created");
  });

  test("resource type groups filter list and export identically before pagination", async () => {
    const filter = new URLSearchParams({
      resource_types: " audit_test , absent_resource ",
      action:
        "workflow.created,workflow.updated,workflow.deleted,connector.created,connector.updated",
    });
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const pageQuery = new URLSearchParams(filter);
      pageQuery.set("limit", "2");
      if (cursor) pageQuery.set("cursor", cursor);
      const response = await fetch(`${srv.baseUrl}/v1/audit-log?${pageQuery}`, {
        headers: adminHeaders(srv.apiKey),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        items: Array<{ id: string; resource_type: string }>;
        next_cursor: string | null;
      };
      for (const row of body.items) {
        expect(row.resource_type).toBe("audit_test");
        expect(ids).not.toContain(row.id);
        ids.push(row.id);
      }
      cursor = body.next_cursor;
    } while (cursor);
    expect(new Set(ids)).toEqual(new Set(seededIds));
    const exported = await fetch(`${srv.baseUrl}/v1/audit-log/export.ndjson?${filter}`, {
      headers: adminHeaders(srv.apiKey),
    });
    expect(exported.status).toBe(200);
    const exportIds = (await exported.text())
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { id: string }).id);
    expect(exportIds).toEqual(ids);
    filter.set("resource_type", "absent_resource");
    const narrowed = await fetch(`${srv.baseUrl}/v1/audit-log?${filter}`, {
      headers: adminHeaders(srv.apiKey),
    });
    expect(narrowed.status).toBe(200);
    expect((await narrowed.json()).items).toEqual([]);
    const narrowedExport = await fetch(`${srv.baseUrl}/v1/audit-log/export.ndjson?${filter}`, {
      headers: adminHeaders(srv.apiKey),
    });
    expect(narrowedExport.status).toBe(200);
    expect(await narrowedExport.text()).toBe("");
  });

  test("ts_from / ts_to window narrows", async () => {
    const res = await fetch(
      `${srv.baseUrl}/v1/audit-log?ts_from=${encodeURIComponent(seedStartIso)}&ts_to=${encodeURIComponent(seedEndIso)}&limit=500`,
      { headers: adminHeaders(srv.apiKey) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    const ids = new Set(body.items.map((r) => r.id));
    for (const id of seededIds) expect(ids.has(id)).toBe(true);
  });

  test("cursor pagination with limit=2", async () => {
    const p1Res = await fetch(
      `${srv.baseUrl}/v1/audit-log?action=workflow.created,workflow.updated,workflow.deleted,connector.created,connector.updated&limit=2`,
      { headers: adminHeaders(srv.apiKey) },
    );
    expect(p1Res.status).toBe(200);
    const p1 = (await p1Res.json()) as {
      items: Array<{ id: string; ts: string }>;
      next_cursor: string | null;
    };
    expect(p1.items.length).toBe(2);
    expect(p1.next_cursor).toBeTruthy();

    const p2Res = await fetch(
      `${srv.baseUrl}/v1/audit-log?action=workflow.created,workflow.updated,workflow.deleted,connector.created,connector.updated&limit=2&cursor=${encodeURIComponent(p1.next_cursor ?? "")}`,
      { headers: adminHeaders(srv.apiKey) },
    );
    expect(p2Res.status).toBe(200);
    const p2 = (await p2Res.json()) as {
      items: Array<{ id: string }>;
      next_cursor: string | null;
    };
    expect(p2.items.length).toBe(2);
    const ids1 = new Set(p1.items.map((r) => r.id));
    for (const row of p2.items) expect(ids1.has(row.id)).toBe(false);
  });

  test("malformed cursor is 400, not 500", async () => {
    for (const bad of ["abc|def", "not-a-cursor", "|", "2026-01-01T00:00:00Z|nope"]) {
      const res = await fetch(`${srv.baseUrl}/v1/audit-log?cursor=${encodeURIComponent(bad)}`, {
        headers: adminHeaders(srv.apiKey),
      });
      expect(res.status, `cursor=${bad}`).toBe(400);
    }
  });

  test("a real cursor still round-trips after the shape check", async () => {
    const first = await fetch(`${srv.baseUrl}/v1/audit-log?limit=1`, {
      headers: adminHeaders(srv.apiKey),
    });
    const p1 = (await first.json()) as { next_cursor: string | null };
    expect(p1.next_cursor).toBeTruthy();
    const res = await fetch(
      `${srv.baseUrl}/v1/audit-log?limit=1&cursor=${encodeURIComponent(p1.next_cursor ?? "")}`,
      { headers: adminHeaders(srv.apiKey) },
    );
    expect(res.status).toBe(200);
  });

  test("GET /v1/audit-log/:id returns a single row", async () => {
    const id = seededIds[0] as string;
    const res = await fetch(`${srv.baseUrl}/v1/audit-log/${id}`, {
      headers: adminHeaders(srv.apiKey),
    });
    expect(res.status).toBe(200);
    const row = (await res.json()) as { id: string; tenant_id: string };
    expect(row.id).toBe(id);
    expect(row.tenant_id).toBe(srv.tenantId);
  });

  test("404 for a non-existent id", async () => {
    // allow-random: unique per-test id for a 404 lookup.
    const res = await fetch(`${srv.baseUrl}/v1/audit-log/${crypto.randomUUID()}`, {
      headers: adminHeaders(srv.apiKey),
    });
    expect(res.status).toBe(404);
  });

  test("export.ndjson streams a valid ndjson body", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/audit-log/export.ndjson`, {
      headers: { authorization: `Bearer ${srv.apiKey}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const body = await res.text();
    const lines = body.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(seededIds.length);
    for (const line of lines) {
      const obj = JSON.parse(line) as { id: string; tenant_id: string };
      expect(obj.id).toBeTruthy();
      expect(obj.tenant_id).toBe(srv.tenantId);
    }
  });

  test("permission gate: member API key gets 403", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/audit-log`, {
      headers: { authorization: `Bearer ${memberKey}` },
    });
    expect(res.status).toBe(403);
  });

  test("permission gate: admin API key gets 200", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/audit-log?limit=1`, {
      headers: adminHeaders(srv.apiKey),
    });
    expect(res.status).toBe(200);
  });
});
