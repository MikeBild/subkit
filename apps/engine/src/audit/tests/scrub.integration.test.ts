import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/audit.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { _drainAuditWritesForTests, audit, auditAwait } from "../audit.ts";
import { queryAuditLog } from "../query.ts";
import { tenantA, tenantB, testDb, useAuditContractsDb } from "./contracts-fixtures.ts";

useAuditContractsDb();

const uuid = createDeterministicUuidFactory(0x5c4b);
const PAT = "dop_v1_persistscrubabcdefabcdefabcdefabcdefabcd";

async function rowsFor(resourceId: string) {
  return testDb.db.select().from(auditLog).where(eq(auditLog.resource_id, resourceId));
}

describe("persisted redaction", () => {
  test("secrets inside metadata arrays never reach the stored row", async () => {
    const resourceId = uuid();
    await auditAwait(
      {
        tenant_id: tenantA,
        action: "credential.created",
        resource_type: "credential",
        resource_id: resourceId,
        metadata: {
          attempts: [
            { password: "hunter2-array" },
            { headers: { authorization: `Bearer ${PAT}` } },
          ],
          tags: ["public", PAT],
        },
      },
      testDb.db,
    );
    const [row] = await rowsFor(resourceId);
    const blob = JSON.stringify(row?.metadata);
    expect(blob).not.toContain("hunter2-array");
    expect(blob).not.toContain(PAT);
    expect(((row?.metadata ?? { tags: [] }) as { tags: unknown[] }).tags[0]).toBe("public");
  });

  test("a NUL byte in caller text is stored as a replacement character instead of losing the row", async () => {
    const resourceId = `upload\u0000${uuid()}`;
    const entry = await auditAwait(
      {
        tenant_id: tenantA,
        action: "file.created",
        resource_type: "file",
        resource_id: resourceId,
        reason: "name had\u0000a NUL",
        metadata: { filename: "report\u0000.pdf", parts: ["a\u0000"] },
        after: { filename: "report\u0000.pdf" },
      },
      testDb.db,
    );
    const [row] = await rowsFor(resourceId.replace("\u0000", "�"));
    expect(row?.id).toBe(entry.id);
    expect(row?.reason).toBe("name had�a NUL");
    expect(row?.metadata).toEqual({ filename: "report�.pdf", parts: ["a�"] });
    expect(row?.after).toEqual({ filename: "report�.pdf" });
  });

  test("the fire-and-forget writer keeps the evidence row for NUL-bearing metadata", async () => {
    const resourceId = uuid();
    audit(
      {
        tenant_id: tenantA,
        action: "file.created",
        resource_type: "file",
        resource_id: resourceId,
        metadata: { filename: "x\u0000y" },
      },
      testDb.db,
    );
    await _drainAuditWritesForTests(testDb.db);
    const [row] = await rowsFor(resourceId);
    expect(row?.metadata).toEqual({ filename: "x�y" });
    const other = await queryAuditLog(testDb.db, { tenant_id: tenantB, resource_id: resourceId });
    expect(other.items).toEqual([]);
  });
});
