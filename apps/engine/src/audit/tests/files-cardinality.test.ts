import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { SizeBucket } from "../../audit/buckets.ts";
import { bucketSize } from "../../audit/buckets.ts";
import { AuditAction, auditAwait, FileCreatedMetadataSchema } from "../../audit/index.ts";
import { auditLog, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";

const uuid = createDeterministicUuidFactory(0xfacaad);

const VALID_BUCKETS: SizeBucket[] = ["<1KB", "<1MB", "<10MB", "<100MB", ">=100MB"];

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("files-audit-cardinality");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "audit-card-t", display_name: "Audit Cardinality" })
    .returning();
  if (!t) throw new Error("seed tenant");
  tenant_id = t.id;
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

const TEST_SIZES = [
  512, 2048, 900_000, 2_000_000, 15_000_000, 200_000_000, 50_000_000, 99_999_999, 100_000_000, 1,
];

async function emitFileEvent(
  action: keyof typeof AuditAction,
  sizeBytes: number,
  filename?: string,
) {
  const file_id = uuid();
  await auditAwait(
    {
      tenant_id,
      actor_type: "user",
      actor_id: uuid(),
      action: AuditAction[action],
      resource_type: "file",
      resource_id: file_id,
      result: "success",
      metadata: {
        filename: filename ?? undefined,
        size_bytes_bucket: bucketSize(sizeBytes),
        dedup: false,
      },
    },
    ctx.db,
  );
  return file_id;
}

describe("files audit cardinality", () => {
  test("emitting 100 file events: size_bytes_bucket always one of 5 valid values", async () => {
    const sizes = Array.from({ length: 100 }, (_, i) => 512 * (i + 1));
    for (const size of sizes) {
      await emitFileEvent("FILE_CREATED", size);
    }

    const rows = await ctx.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.action, "file.created")));

    for (const row of rows) {
      const meta = row.metadata as Record<string, unknown>;
      expect(meta.size_bytes_bucket).toBeDefined();
      expect(VALID_BUCKETS).toContain(meta.size_bytes_bucket as SizeBucket);
      expect(meta.size_bytes).toBeUndefined();
    }
  });

  test("all 5 bucket values are produced by the test size set", async () => {
    const buckets = new Set(TEST_SIZES.map((s) => bucketSize(s)));
    expect(buckets.size).toBe(5);
    for (const b of VALID_BUCKETS) {
      expect(buckets.has(b)).toBe(true);
    }
  });

  test("FILE_CREATED rows may carry filename; other actions must not", async () => {
    const createdId = await emitFileEvent("FILE_CREATED", 1024, "report.pdf");
    const downloadedId = uuid();
    await auditAwait(
      {
        tenant_id,
        actor_type: "user",
        actor_id: uuid(),
        action: AuditAction.FILE_DOWNLOADED,
        resource_type: "file",
        resource_id: downloadedId,
        result: "success",
        metadata: {
          size_bytes_bucket: bucketSize(1024),
          range: false,
          content_type: "application/pdf",
        },
      },
      ctx.db,
    );

    const createdRows = await ctx.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenant_id),
          eq(auditLog.action, "file.created"),
          eq(auditLog.resource_id, createdId),
        ),
      );
    expect(createdRows.length).toBe(1);
    const createdMeta = createdRows[0]!.metadata as Record<string, unknown>;
    expect(createdMeta.filename).toBe("report.pdf");

    const downloadedRows = await ctx.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenant_id),
          eq(auditLog.action, "file.downloaded"),
          eq(auditLog.resource_id, downloadedId),
        ),
      );
    expect(downloadedRows.length).toBe(1);
    const downloadedMeta = downloadedRows[0]!.metadata as Record<string, unknown>;
    expect(downloadedMeta.filename).toBeUndefined();
  });

  test("FileCreatedMetadataSchema rejects filenames longer than 255 chars", () => {
    const tooLong = "x".repeat(256);
    const justRight = "x".repeat(255);
    const result = FileCreatedMetadataSchema.safeParse({
      file_id: "11111111-1111-4111-9111-111111111111",
      size_bytes_bucket: "<1KB",
      content_type: null,
      filename: tooLong,
    });
    expect(result.success).toBe(false);
    const ok = FileCreatedMetadataSchema.safeParse({
      file_id: "11111111-1111-4111-9111-111111111111",
      size_bytes_bucket: "<1KB",
      content_type: null,
      filename: justRight,
    });
    expect(ok.success).toBe(true);
  });

  test("bucketSize produces correct bucket for boundary values", () => {
    expect(bucketSize(0)).toBe("<1KB");
    expect(bucketSize(1023)).toBe("<1KB");
    expect(bucketSize(1024)).toBe("<1MB");
    expect(bucketSize(1024 * 1024 - 1)).toBe("<1MB");
    expect(bucketSize(1024 * 1024)).toBe("<10MB");
    expect(bucketSize(10 * 1024 * 1024 - 1)).toBe("<10MB");
    expect(bucketSize(10 * 1024 * 1024)).toBe("<100MB");
    expect(bucketSize(100 * 1024 * 1024 - 1)).toBe("<100MB");
    expect(bucketSize(100 * 1024 * 1024)).toBe(">=100MB");
    expect(bucketSize(Number.POSITIVE_INFINITY)).toBe("<1KB");
    expect(bucketSize(Number.NaN)).toBe("<1KB");
    expect(bucketSize(-1)).toBe("<1KB");
  });
});
