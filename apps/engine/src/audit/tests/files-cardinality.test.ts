// Audit cardinality tests for the files subsystem.
//
// Asserts:
//   - audit rows never carry raw `size_bytes`; only `size_bytes_bucket`
//   - `size_bytes_bucket` is always one of the 5 valid values
//   - filenames only appear on FILE_CREATED action rows
//
// This is an integration test because it uses a real Postgres DB to
// round-trip the audit rows through the full audit.ts write path.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { SizeBucket } from "../../audit/buckets.ts";
import { bucketSize } from "../../audit/buckets.ts";
import { AuditAction, auditAwait, FileCreatedMetadataSchema } from "../../audit/index.ts";
import { auditLog, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";

// Deterministic uuid source: seeded so the test replays identically and
// `no-random-uuid-in-tests` stays green. createTestDb provisions a fresh
// DB per run, so per-call uniqueness within the test is sufficient.
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

// Representative sizes that span all 5 buckets
const TEST_SIZES = [
  512, // <1KB
  2048, // <1MB
  900_000, // <1MB
  2_000_000, // <10MB
  15_000_000, // <100MB
  200_000_000, // >=100MB
  50_000_000, // <100MB (boundary)
  99_999_999, // <100MB
  100_000_000, // >=100MB (boundary)
  1, // <1KB (minimum)
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
    // Emit 100 events across a range of sizes
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
      // Must have size_bytes_bucket
      expect(meta.size_bytes_bucket).toBeDefined();
      // Must be one of 5 valid values
      expect(VALID_BUCKETS).toContain(meta.size_bytes_bucket as SizeBucket);
      // Must NOT have raw size_bytes
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
          // No filename here — only FILE_CREATED should carry it
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
    // FILE_CREATED may carry filename
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
    // FILE_DOWNLOADED must NOT carry filename
    expect(downloadedMeta.filename).toBeUndefined();
  });

  test("FileCreatedMetadataSchema rejects filenames longer than 255 chars", () => {
    // Mirrors the cap on `InlineUploadSchema.filename` and
    // `BatchCreateEntrySchema.filename` (api/files-schemas.ts). A
    // future emitter that bypassed the wire-schema cap would otherwise
    // inflate `audit_log.metadata` row size unboundedly.
    const tooLong = "x".repeat(256);
    const justRight = "x".repeat(255);
    const result = FileCreatedMetadataSchema.safeParse({
      file_id: "11111111-1111-1111-1111-111111111111",
      size_bytes_bucket: "<1KB",
      content_type: null,
      filename: tooLong,
    });
    expect(result.success).toBe(false);
    const ok = FileCreatedMetadataSchema.safeParse({
      file_id: "11111111-1111-1111-1111-111111111111",
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
    // Non-finite values (including Infinity) are clamped to "<1KB" per contract
    expect(bucketSize(Number.POSITIVE_INFINITY)).toBe("<1KB");
    expect(bucketSize(Number.NaN)).toBe("<1KB");
    expect(bucketSize(-1)).toBe("<1KB");
  });
});
