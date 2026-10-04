// Integration test for /v1/diagnostics/version.
//
// Replaces the test surface that used to cover the public `/health`
// update fields — those moved off that route and now require
// `audit:read`. This test covers:
//
//   - 200 + correct shape on a clean engine
//   - audit row written via the recorder pattern (auditAwait, durable
//     before the response leaves the handler)
//   - the `update_available` / `latest_version` fields reflect what
//     `setUpdateState` set
//   - 403 for a token that lacks `audit:read`
//   - 401 for an absent token

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gte } from "drizzle-orm";
import { apiKeys, auditLog, users } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { resetUpdateState, setUpdateState } from "../../update-state.ts";
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
  srv = await createHttpTestServer("diagnostics_version");

  const [member] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "member-version@test.local",
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
  resetUpdateState();
  await srv.cleanup();
});

function adminHeaders() {
  return {
    authorization: `Bearer ${srv.apiKey}`,
    "content-type": "application/json",
  } as const;
}

describe("/v1/diagnostics/version", () => {
  test("returns engine snapshot and writes a DIAGNOSTICS_VERSION_READ audit row", async () => {
    resetUpdateState();
    // allow-wall-clock: bounded predicate for the audit_log SELECT, not a determinism axis
    const before = new Date();
    const res = await fetch(`${srv.baseUrl}/v1/diagnostics/version`, { headers: adminHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      engine_version: string;
      latest_version?: string;
      update_available: boolean;
      schema_drift: boolean;
      embedded_migrations_count: number;
    };
    expect(typeof body.engine_version).toBe("string");
    expect(body.engine_version.length).toBeGreaterThan(0);
    // No update probe ran in tests, so the boot probe state is null →
    // update_available defaults to false; latest_version is omitted.
    expect(body.update_available).toBe(false);
    expect(body.latest_version).toBeUndefined();
    expect(body.schema_drift).toBe(false);
    expect(body.embedded_migrations_count).toBeGreaterThan(0);

    const rows = await srv.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, srv.tenantId),
          eq(auditLog.action, "diagnostics.version_read"),
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
      engine_version?: string;
      update_available?: boolean;
      schema_drift?: boolean;
    };
    expect(meta.engine_version).toBe(body.engine_version);
    expect(meta.update_available).toBe(false);
    expect(meta.schema_drift).toBe(false);
  });

  test("surfaces update_available + latest_version when set by the boot probe", async () => {
    setUpdateState({ update_available: true, latest_version: "9.9.9" });
    try {
      const res = await fetch(`${srv.baseUrl}/v1/diagnostics/version`, { headers: adminHeaders() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        update_available: boolean;
        latest_version?: string;
      };
      expect(body.update_available).toBe(true);
      expect(body.latest_version).toBe("9.9.9");
    } finally {
      resetUpdateState();
    }
  });

  test("audit:read is required — member key gets 403", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/diagnostics/version`, {
      headers: { authorization: `Bearer ${memberKey}` },
    });
    expect(res.status).toBe(403);
  });

  test("absent auth gets 401", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/diagnostics/version`);
    expect(res.status).toBe(401);
  });
});
