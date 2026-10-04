// HTTP integration tests for the /v1/self-healing routes.
//
// Covers the operator-facing surface:
//   - POST /v1/self-healing/scans triggers a scan as admin, persists
//     a self_healing_scans row, and emits TRIGGERED + COMPLETED audit
//     entries.
//   - Non-admin principals get 403.
//   - Idempotency-Key returns the prior result with 202 on replay.
//   - GET /v1/self-healing/scans lists the row.
//   - GET /v1/self-healing/scans/{id} returns the row.
//
// The scan path in these tests deliberately exercises the
// "no signals" branch: we don't seed any drift, so scanForDrift
// returns an empty signal list and no Patch Candidates are
// created. The unit tests in self-healing/tests/proactive-scanner
// cover the per-signal scanner logic directly; here we're proving
// the HTTP envelope (auth, idempotency, persistence, audit) — not
// re-testing scanner internals.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import { auditLog } from "../../db/schema/audit.ts";
import { apiKeys, selfHealingScans, users } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let memberKey = "";

const apiKeyHex = createDeterministicHexFactory(0xa11);
const idemHex = createDeterministicHexFactory(0xbeef);

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

function newKey() {
  const rand = apiKeyHex(24).slice(0, 32);
  const plaintext = `wf_live_${rand}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

beforeAll(async () => {
  srv = await createHttpTestServer("self-healing");

  const [member] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "member-self-healing@test.local",
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

function adminHeaders(extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${srv.apiKey}`,
    "content-type": "application/json",
    ...extra,
  } as const;
}

function memberHeaders() {
  return {
    authorization: `Bearer ${memberKey}`,
    "content-type": "application/json",
  } as const;
}

describe("/v1/self-healing/scans", () => {
  test("admin POST triggers a scan and persists a self_healing_scans row", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/self-healing/scans`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scan_id: string;
      signals_detected: number;
      candidates_created: number;
      duration_ms: number;
      candidates: unknown[];
    };
    expect(body.scan_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.signals_detected).toBe(0);
    expect(body.candidates_created).toBe(0);
    expect(Array.isArray(body.candidates)).toBe(true);

    // Row persisted.
    const rows = await srv.db
      .select()
      .from(selfHealingScans)
      .where(eq(selfHealingScans.id, body.scan_id));
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("succeeded");
    expect(rows[0]?.source).toBe("admin_http");
    expect(rows[0]?.tenant_id).toBe(srv.tenantId);

    // Both lifecycle audit rows exist.
    const audits = await srv.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, srv.tenantId), eq(auditLog.resource_id, body.scan_id)));
    const actions = audits.map((a) => a.action);
    expect(actions).toContain(AuditAction.SELF_HEALING_SCAN_TRIGGERED);
    expect(actions).toContain(AuditAction.SELF_HEALING_SCAN_COMPLETED);
  });

  test("non-admin POST is denied with 403", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/self-healing/scans`, {
      method: "POST",
      headers: memberHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  test("Idempotency-Key replay returns the prior scan with 202", async () => {
    const key = `test-key-${idemHex(8)}`;
    const first = await fetch(`${srv.baseUrl}/v1/self-healing/scans`, {
      method: "POST",
      headers: adminHeaders({ "idempotency-key": key }),
      body: JSON.stringify({}),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { scan_id: string };

    const replay = await fetch(`${srv.baseUrl}/v1/self-healing/scans`, {
      method: "POST",
      headers: adminHeaders({ "idempotency-key": key }),
      body: JSON.stringify({}),
    });
    expect(replay.status).toBe(202);
    const replayBody = (await replay.json()) as {
      scan_id: string;
      idempotent_replay?: boolean;
    };
    expect(replayBody.scan_id).toBe(firstBody.scan_id);
    expect(replayBody.idempotent_replay).toBe(true);

    // Exactly one persisted row for this idempotency key.
    const rows = await srv.db
      .select()
      .from(selfHealingScans)
      .where(
        and(
          eq(selfHealingScans.tenant_id, srv.tenantId),
          eq(selfHealingScans.idempotency_key, key),
        ),
      );
    expect(rows.length).toBe(1);
  });

  test("GET /v1/self-healing/scans lists rows for the tenant", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/self-healing/scans?limit=50`, {
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: string; tenant_id: string; source: string; status: string }>;
    };
    expect(body.items.length).toBeGreaterThan(0);
    for (const row of body.items) expect(row.tenant_id).toBe(srv.tenantId);
  });

  test("GET /v1/self-healing/scans/{id} returns one row", async () => {
    const list = await fetch(`${srv.baseUrl}/v1/self-healing/scans?limit=1`, {
      headers: adminHeaders(),
    });
    const listBody = (await list.json()) as { items: Array<{ id: string }> };
    const id = listBody.items[0]?.id;
    if (!id) throw new Error("expected at least one scan row");

    const res = await fetch(`${srv.baseUrl}/v1/self-healing/scans/${id}`, {
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    const row = (await res.json()) as { id: string; tenant_id: string; source: string };
    expect(row.id).toBe(id);
    expect(row.tenant_id).toBe(srv.tenantId);
  });

  test("non-admin GET list is denied with 403", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/self-healing/scans`, {
      headers: memberHeaders(),
    });
    expect(res.status).toBe(403);
  });

  test("concurrent Idempotency-Key races resolve to a single scan row", async () => {
    const key = `race-key-${idemHex(8)}`;
    // Fire both POSTs in parallel so one of them is guaranteed to lose
    // the unique-constraint race on (tenant_id, idempotency_key). The
    // route's ON CONFLICT DO NOTHING + re-read fallback must convert
    // the loser into a 202 replay rather than a 500.
    const [a, b] = await Promise.all([
      fetch(`${srv.baseUrl}/v1/self-healing/scans`, {
        method: "POST",
        headers: adminHeaders({ "idempotency-key": key }),
        body: JSON.stringify({}),
      }),
      fetch(`${srv.baseUrl}/v1/self-healing/scans`, {
        method: "POST",
        headers: adminHeaders({ "idempotency-key": key }),
        body: JSON.stringify({}),
      }),
    ]);
    const statuses = [a.status, b.status].sort();
    // One success (200), one replay (202) — neither 500.
    expect(statuses).toEqual([200, 202]);
    const aBody = (await a.json()) as { scan_id: string };
    const bBody = (await b.json()) as { scan_id: string };
    expect(aBody.scan_id).toBe(bBody.scan_id);

    // Exactly one row landed for the race key.
    const rows = await srv.db
      .select()
      .from(selfHealingScans)
      .where(
        and(
          eq(selfHealingScans.tenant_id, srv.tenantId),
          eq(selfHealingScans.idempotency_key, key),
        ),
      );
    expect(rows.length).toBe(1);
  });

  test("response includes unanchored_detected count", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/self-healing/scans`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { unanchored_detected: number; unanchored: unknown[] };
    expect(typeof body.unanchored_detected).toBe("number");
    expect(body.unanchored_detected).toBe(body.unanchored.length);
  });
});
