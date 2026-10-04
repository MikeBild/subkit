// Integration test for /v1/diagnostics/drift.
//
// Drives a real engine, plants synthetic rows in
// `subkit.__drizzle_migrations`, and confirms the route surfaces them
// to operator clients. Without this surface, drift is invisible until
// a downstream subsystem fails.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { apiKeys, auditLog, users } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let memberKey = "";

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

function newKey(): { plaintext: string; prefix: string; hash: string } {
  const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: legacy; review before changing
  const plaintext = `wf_live_${rand}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

beforeAll(async () => {
  srv = await createHttpTestServer("diagnostics_drift");

  const [member] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "member-drift@test.local",
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

function adminHeaders() {
  return {
    authorization: `Bearer ${srv.apiKey}`,
    "content-type": "application/json",
  } as const;
}

describe("/v1/diagnostics/drift", () => {
  test("clean DB reports no drift and writes a DIAGNOSTICS_DRIFT_READ audit row (review R2-W3)", async () => {
    // allow-wall-clock: bound for the audit_log SELECT predicate; not a determinism axis
    const before = new Date();
    const res = await fetch(`${srv.baseUrl}/v1/diagnostics/drift`, { headers: adminHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      embedded_migration_count: number;
      db_migration_count: number;
      unknown_in_db: unknown[];
      historical_in_db: unknown[];
      missing_in_db: unknown[];
    };
    expect(body.embedded_migration_count).toBe(body.db_migration_count);
    expect(body.unknown_in_db).toEqual([]);
    expect(body.historical_in_db).toEqual([]);
    expect(body.missing_in_db).toEqual([]);

    // R2-W3: assert the audit row landed in audit_log. With auditAwait
    // on the route, this is durable before the response was returned.
    const rows = await srv.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, srv.tenantId),
          eq(auditLog.action, "diagnostics.drift_read"),
          gte(auditLog.ts, before),
        ),
      )
      .orderBy(desc(auditLog.ts))
      .limit(1);
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.actor_id).toBe(srv.userId);
    expect(row.result).toBe("success");
    const meta = row.metadata as {
      embedded?: number;
      db?: number;
      unknown?: number;
      historical?: number;
      missing?: number;
    };
    expect(meta.embedded).toBe(body.embedded_migration_count);
    expect(meta.db).toBe(body.db_migration_count);
    expect(meta.unknown).toBe(0);
    expect(meta.historical).toBe(0);
    expect(meta.missing).toBe(0);
  });

  test("an unknown tagged row surfaces in unknown_in_db", async () => {
    const fakeHash = "deadbeefcafebabefacefeed".padEnd(64, "0");
    await srv.db.execute(
      sql`INSERT INTO "subkit"."__drizzle_migrations" ("hash", "created_at", "tag")
          VALUES (${fakeHash}, ${999_999_999_999}, ${"9999_foreign_lineage"})`,
    );
    try {
      const res = await fetch(`${srv.baseUrl}/v1/diagnostics/drift`, { headers: adminHeaders() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        unknown_in_db: Array<{ hash: string }>;
        db_migration_count: number;
        embedded_migration_count: number;
      };
      const hashes = body.unknown_in_db.map((r) => r.hash);
      expect(hashes).toContain(fakeHash);
      expect(body.db_migration_count).toBe(body.embedded_migration_count + 1);
    } finally {
      await srv.db.execute(
        sql`DELETE FROM "subkit"."__drizzle_migrations" WHERE hash = ${fakeHash}`,
      );
    }
  });

  test("a tagless pre-squash row is reported as accepted history", async () => {
    const historicalHash = "pre-squash-history".padEnd(64, "0");
    await srv.db.execute(
      sql`INSERT INTO "subkit"."__drizzle_migrations" ("hash", "created_at", "tag")
          VALUES (${historicalHash}, ${999_999_999_998}, NULL)`,
    );
    try {
      const res = await fetch(`${srv.baseUrl}/v1/diagnostics/drift`, { headers: adminHeaders() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        unknown_in_db: unknown[];
        historical_in_db: Array<{ hash: string }>;
        db_migration_count: number;
        embedded_migration_count: number;
      };
      expect(body.unknown_in_db).toEqual([]);
      expect(body.historical_in_db.map((r) => r.hash)).toContain(historicalHash);
      expect(body.db_migration_count).toBe(body.embedded_migration_count + 1);
    } finally {
      await srv.db.execute(
        sql`DELETE FROM "subkit"."__drizzle_migrations" WHERE hash = ${historicalHash}`,
      );
    }
  });

  test("audit:read is required — member gets 403", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/diagnostics/drift`, {
      headers: { authorization: `Bearer ${memberKey}` },
    });
    expect(res.status).toBe(403);
  });
});
