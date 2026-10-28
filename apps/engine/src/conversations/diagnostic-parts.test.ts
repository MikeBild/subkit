import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  DIAGNOSTIC_COLLECTION_BYTES,
  DIAGNOSTIC_PART_BYTES,
  diagnosticParts,
} from "./diagnostic-parts.ts";

const file = "fid_00000000-0000-4000-8000-000000000001";

test("describes exact contiguous chunks without returning source data", () => {
  const bytes = new Uint8Array(DIAGNOSTIC_PART_BYTES + 7).fill(42);
  const parts = diagnosticParts("logs", file, bytes);
  expect(parts).toHaveLength(2);
  expect(parts.map((part) => part.index)).toEqual([0, 1]);
  expect(parts.map((part) => part.bytes)).toEqual([DIAGNOSTIC_PART_BYTES, 7]);
  expect(parts[1]?.data).toEqual({
    $file: file,
    $range: { start: DIAGNOSTIC_PART_BYTES, length: 7 },
  });
  expect(parts[1]?.sha256).toBe(
    createHash("sha256").update(bytes.subarray(DIAGNOSTIC_PART_BYTES)).digest("hex"),
  );
  expect(parts.reduce((sum, part) => sum + part.bytes, 0)).toBe(bytes.byteLength);
});

test("rejects invalid artifacts, file references and empty data", () => {
  expect(() => diagnosticParts("../logs", file, new Uint8Array(1))).toThrow();
  expect(() => diagnosticParts("logs", "another-file", new Uint8Array(1))).toThrow();
  expect(() => diagnosticParts("logs", file, new Uint8Array(0))).toThrow();
});

test("accepts a 10 MB case and rejects anything larger", () => {
  expect(DIAGNOSTIC_COLLECTION_BYTES).toBe(10_000_000);
  const parts = diagnosticParts("logs", file, new Uint8Array(DIAGNOSTIC_COLLECTION_BYTES));
  expect(parts).toHaveLength(Math.ceil(DIAGNOSTIC_COLLECTION_BYTES / DIAGNOSTIC_PART_BYTES));
  expect(() =>
    diagnosticParts("logs", file, new Uint8Array(DIAGNOSTIC_COLLECTION_BYTES + 1)),
  ).toThrow();
});
