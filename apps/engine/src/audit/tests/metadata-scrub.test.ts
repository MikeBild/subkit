// Audit metadata scrub regression test.
//
// Audit rows are append-only — once a secret leaks into `metadata`,
// `before`, `after`, or `reason` it is durable forever. The `audit()`
// + `auditAwait()` path runs every entry through `scrubSecrets()` in
// `buildEntry()` so PATs / JWTs / Bearer headers / sensitive-key
// values never reach the `audit_log` table.
//
// This test records an entry whose metadata carries a DigitalOcean
// PAT, a sensitive `token` key, and a JWT in a free-form string,
// then SELECTs the row back from the test database and asserts that
// none of the original token substrings survived.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { auditAwait } from "../audit.ts";

let testDb: TestDb;
let tenantId = "";

describe("audit writer — metadata scrubbing", () => {
  beforeAll(async () => {
    testDb = await createTestDb("audit-scrub");
    const [row] = await testDb.db
      .insert(tenants)
      .values({ slug: "scrub-tenant", display_name: "Scrub Tenant" })
      .returning();
    if (!row) throw new Error("seed failed");
    tenantId = row.id;
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  test("scrubs PAT / JWT / sensitive-key values from metadata before persist", async () => {
    const pat = "dop_v1_a9053683abcdefabcdefabcdefabcdefabcdef";
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefSignature";
    const bearer = "Bearer abc123.def-456_xyz";

    const entry = await auditAwait(
      {
        tenant_id: tenantId,
        action: "credential.created",
        resource_type: "credential",
        resource_id: "cred-1",
        result: "success",
        reason: `operator pasted ${pat} into the form`,
        metadata: {
          token: "should-be-replaced",
          notes: `JWT seen: ${jwt}`,
          headers: { authorization: bearer },
        },
      },
      testDb.db,
    );

    // Returned entry has scrubbed payload (callers downstream rely on this).
    expect(JSON.stringify(entry.metadata)).not.toContain(pat);
    expect(JSON.stringify(entry.metadata)).not.toContain(jwt);
    expect(JSON.stringify(entry.metadata)).not.toContain(bearer);
    expect(JSON.stringify(entry.metadata)).not.toContain("should-be-replaced");
    expect(entry.reason).not.toContain(pat);
    expect(entry.reason).toContain("***REDACTED:pat***");

    // Row on disk has the same redactions — this is the durability gate.
    const rows = await testDb.db.execute(
      sql`SELECT metadata, reason FROM audit_log WHERE id = ${entry.id}::uuid`,
    );
    const list = (
      rows as unknown as {
        rows: Array<{ metadata: Record<string, unknown>; reason: string | null }>;
      }
    ).rows;
    expect(list.length).toBe(1);
    const persistedJson = JSON.stringify(list[0]);
    expect(persistedJson).not.toContain(pat);
    expect(persistedJson).not.toContain(jwt);
    expect(persistedJson).not.toContain(bearer);
    expect(persistedJson).not.toContain("should-be-replaced");
  });
});
