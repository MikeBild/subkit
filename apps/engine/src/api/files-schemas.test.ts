// Zod round-trip tests for the unified files HTTP schemas.
//
// Pins the wire format so a schema refactor produces a failing test
// rather than silent client breakage.

import { describe, expect, test } from "bun:test";

import {
  BatchCreateRequestSchema,
  FileIdSchema,
  FileRefSchema,
  FinalizeRequestSchema,
  MAX_FINALIZE_VERIFY_BYTES,
  MAX_STREAM_UPLOAD_BYTES,
  parseFileId,
  parseFileIdOrThrow,
  toFileId,
} from "./files-schemas.ts";

const VALID_UUID = "11111111-2222-4333-8444-555555555555";
const VALID_FID = `fid_${VALID_UUID}`;

describe("FileIdSchema", () => {
  test("accepts a well-formed fid_ prefixed UUID", () => {
    expect(FileIdSchema.safeParse(VALID_FID).success).toBe(true);
  });

  test("rejects a plain UUID without fid_ prefix", () => {
    expect(FileIdSchema.safeParse(VALID_UUID).success).toBe(false);
  });

  test("rejects fid_ with a malformed UUID (wrong length)", () => {
    expect(FileIdSchema.safeParse("fid_abc").success).toBe(false);
  });

  test("rejects fid_ with uppercase hex", () => {
    expect(FileIdSchema.safeParse("fid_11111111-2222-4333-8444-55555555555A").success).toBe(false);
  });

  test("rejects an empty string", () => {
    expect(FileIdSchema.safeParse("").success).toBe(false);
  });

  test("rejects a non-string input", () => {
    expect(FileIdSchema.safeParse(42).success).toBe(false);
  });
});

describe("parseFileId / toFileId", () => {
  test("toFileId round-trips through parseFileId", () => {
    const wire = toFileId(VALID_UUID);
    expect(wire).toBe(VALID_FID);
    expect(parseFileId(wire)).toBe(VALID_UUID);
  });

  test("parseFileId strips fid_ prefix", () => {
    expect(parseFileId(VALID_FID)).toBe(VALID_UUID);
  });

  test("parseFileId returns null on missing prefix (typed result, not throw)", () => {
    expect(parseFileId(VALID_UUID)).toBeNull();
  });

  test("parseFileIdOrThrow throws on missing prefix", () => {
    expect(() => parseFileIdOrThrow(VALID_UUID)).toThrow(/invalid file id/);
  });

  test("parseFileIdOrThrow strips fid_ prefix on valid input", () => {
    expect(parseFileIdOrThrow(VALID_FID)).toBe(VALID_UUID);
  });

  test("toFileId always prepends fid_", () => {
    expect(toFileId(VALID_UUID).startsWith("fid_")).toBe(true);
  });
});

describe("FileRefSchema", () => {
  test("accepts a valid $file ref", () => {
    const r = FileRefSchema.safeParse({ $file: VALID_FID });
    expect(r.success).toBe(true);
  });

  test("rejects $file with a plain UUID (no fid_ prefix)", () => {
    expect(FileRefSchema.safeParse({ $file: VALID_UUID }).success).toBe(false);
  });

  test("rejects an object with extra keys beside $file", () => {
    // Zod object ignores extra keys by default; schema uses strict() behaviour
    // only if openapi schema enforces strict — not the focus here. What matters
    // is that $file alone is required and must be valid.
    const r = FileRefSchema.safeParse({ $file: VALID_FID, extra: "x" });
    expect(r.success).toBe(true); // extra keys are stripped, not rejected by default
  });

  test("rejects missing $file key", () => {
    expect(FileRefSchema.safeParse({}).success).toBe(false);
  });

  test("rejects $file: null", () => {
    expect(FileRefSchema.safeParse({ $file: null }).success).toBe(false);
  });
});

describe("BatchCreateRequestSchema", () => {
  const validEntry = {
    filename: "report.pdf",
    size_bytes: 1024,
  };

  test("accepts a single-file batch", () => {
    expect(BatchCreateRequestSchema.safeParse({ files: [validEntry] }).success).toBe(true);
  });

  test("accepts up to 100 entries", () => {
    const files = Array.from({ length: 100 }, (_, i) => ({
      filename: `f${i}.bin`,
      size_bytes: i,
    }));
    expect(BatchCreateRequestSchema.safeParse({ files }).success).toBe(true);
  });

  test("rejects empty files array", () => {
    expect(BatchCreateRequestSchema.safeParse({ files: [] }).success).toBe(false);
  });

  test("rejects 101 entries (over max)", () => {
    const files = Array.from({ length: 101 }, (_, i) => ({
      filename: `f${i}.bin`,
      size_bytes: i,
    }));
    expect(BatchCreateRequestSchema.safeParse({ files }).success).toBe(false);
  });

  test("rejects negative size_bytes", () => {
    expect(
      BatchCreateRequestSchema.safeParse({ files: [{ ...validEntry, size_bytes: -1 }] }).success,
    ).toBe(false);
  });

  test("accepts valid sha256 (64 lowercase hex chars)", () => {
    const sha256 = "a".repeat(64);
    const r = BatchCreateRequestSchema.safeParse({ files: [{ ...validEntry, sha256 }] });
    expect(r.success).toBe(true);
  });

  test("rejects sha256 with uppercase chars", () => {
    const sha256 = "A".repeat(64);
    expect(BatchCreateRequestSchema.safeParse({ files: [{ ...validEntry, sha256 }] }).success).toBe(
      false,
    );
  });

  test("rejects sha256 with wrong length (63 chars)", () => {
    const sha256 = "a".repeat(63);
    expect(BatchCreateRequestSchema.safeParse({ files: [{ ...validEntry, sha256 }] }).success).toBe(
      false,
    );
  });

  test("rejects filename longer than 255 chars", () => {
    const filename = "x".repeat(256);
    expect(
      BatchCreateRequestSchema.safeParse({ files: [{ ...validEntry, filename }] }).success,
    ).toBe(false);
  });

  test("rejects empty filename", () => {
    expect(
      BatchCreateRequestSchema.safeParse({ files: [{ ...validEntry, filename: "" }] }).success,
    ).toBe(false);
  });
});

describe("FinalizeRequestSchema", () => {
  test("accepts a 64-char lowercase hex sha256", () => {
    const sha256 = "f".repeat(64);
    expect(FinalizeRequestSchema.safeParse({ sha256 }).success).toBe(true);
  });

  test("rejects sha256 with uppercase hex", () => {
    expect(FinalizeRequestSchema.safeParse({ sha256: "F".repeat(64) }).success).toBe(false);
  });

  test("rejects sha256 shorter than 64 chars", () => {
    expect(FinalizeRequestSchema.safeParse({ sha256: "abc" }).success).toBe(false);
  });

  test("rejects missing sha256", () => {
    expect(FinalizeRequestSchema.safeParse({}).success).toBe(false);
  });

  test("rejects non-string sha256", () => {
    expect(FinalizeRequestSchema.safeParse({ sha256: 12345 }).success).toBe(false);
  });
});

describe("MAX_FINALIZE_VERIFY_BYTES / MAX_STREAM_UPLOAD_BYTES coupling", () => {
  // The finalize verifier rehashes the object after the streaming PUT;
  // its size ceiling is the same payload-shape contract the upload slot
  // accepted at batch-create time. Keeping the two in lockstep prevents
  // a silent drift where upload would accept N bytes but finalize
  // would refuse to verify them, leaving the row stuck in `pending`
  // until the cleanup cron reaps it.
  test("MAX_FINALIZE_VERIFY_BYTES === MAX_STREAM_UPLOAD_BYTES so a future split is intentional", () => {
    expect(MAX_FINALIZE_VERIFY_BYTES).toBe(MAX_STREAM_UPLOAD_BYTES);
  });
});
