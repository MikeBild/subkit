import { describe, expect, test } from "bun:test";
import {
  IMPORT_MAX_BYTES,
  UPLOAD_CHUNK_MAX_BYTES,
  UPLOAD_CHUNKS_MAX,
  UPLOAD_REFUSALS,
} from "@shared/device/uploads.ts";
import {
  chunkVerdict,
  commitVerdict,
  sizeAllowed,
  type UploadFacts,
  uploadRefusalStatus,
} from "./upload.ts";

const NOW = 1_800_000_000_000;
const open: UploadFacts = { state: "open", size_bytes: 10, expires_at_ms: NOW + 1 };
const chunk = { n: 0, bytes: 4, received_bytes: 0, existing_bytes: null };
const commit = { size: 10, sha256: "a", chunks: [1, 0], actual_sha256: "a" };

describe("import size", () => {
  test("from zero up to 90 MiB", () => {
    expect(IMPORT_MAX_BYTES).toBe(94_371_840);
    expect(sizeAllowed(0)).toBe(true);
    expect(sizeAllowed(IMPORT_MAX_BYTES)).toBe(true);
    expect(sizeAllowed(IMPORT_MAX_BYTES + 1)).toBe(false);
    expect(sizeAllowed(-1)).toBe(false);
    expect(sizeAllowed(1.5)).toBe(false);
  });
});

describe("a chunk", () => {
  test("is taken while the upload is open and in time", () => {
    expect(chunkVerdict(open, chunk, NOW)).toBeNull();
  });

  test("a closed or expired upload takes nothing", () => {
    expect(chunkVerdict({ ...open, state: "committed" }, chunk, NOW)).toBe("upload_closed");
    expect(chunkVerdict(open, chunk, NOW + 1)).toBe("upload_expired");
  });

  test("its number stays in range", () => {
    expect(chunkVerdict(open, { ...chunk, n: -1 }, NOW)).toBe("chunk_out_of_range");
    expect(chunkVerdict(open, { ...chunk, n: 0.5 }, NOW)).toBe("chunk_out_of_range");
    expect(chunkVerdict(open, { ...chunk, n: UPLOAD_CHUNKS_MAX }, NOW)).toBe("chunk_out_of_range");
    expect(chunkVerdict(open, { ...chunk, n: UPLOAD_CHUNKS_MAX - 1 }, NOW)).toBeNull();
  });

  test("it is at most the chunk size", () => {
    const big = { ...open, size_bytes: IMPORT_MAX_BYTES };
    expect(chunkVerdict(big, { ...chunk, bytes: UPLOAD_CHUNK_MAX_BYTES }, NOW)).toBeNull();
    expect(chunkVerdict(big, { ...chunk, bytes: UPLOAD_CHUNK_MAX_BYTES + 1 }, NOW)).toBe(
      "chunk_too_large",
    );
  });

  test("a repeated chunk of the same length is fine; a different one conflicts", () => {
    expect(chunkVerdict(open, { ...chunk, received_bytes: 10, existing_bytes: 4 }, NOW)).toBeNull();
    expect(chunkVerdict(open, { ...chunk, existing_bytes: 3 }, NOW)).toBe("chunk_conflict");
  });

  test("chunks never add up to more than the opened size", () => {
    expect(chunkVerdict(open, { ...chunk, received_bytes: 6 }, NOW)).toBeNull();
    expect(chunkVerdict(open, { ...chunk, received_bytes: 7 }, NOW)).toBe("size_mismatch");
  });
});

describe("commit", () => {
  test("a complete upload with the right hash is stored", () => {
    expect(commitVerdict(open, commit, NOW)).toBeNull();
    expect(
      commitVerdict({ ...open, size_bytes: 0 }, { ...commit, size: 0, chunks: [] }, NOW),
    ).toBeNull();
  });

  test("a closed or expired upload is not stored", () => {
    expect(commitVerdict({ ...open, state: "aborted" }, commit, NOW)).toBe("upload_closed");
    expect(commitVerdict(open, commit, NOW + 1)).toBe("upload_expired");
  });

  test("the size must match the opened size", () => {
    expect(commitVerdict(open, { ...commit, size: 9 }, NOW)).toBe("size_mismatch");
  });

  test("chunks must run from 0 without gaps", () => {
    expect(commitVerdict(open, { ...commit, chunks: [0, 2] }, NOW)).toBe("chunks_missing");
    expect(commitVerdict(open, { ...commit, chunks: [1] }, NOW)).toBe("chunks_missing");
  });

  test("a different hash is rejected", () => {
    expect(commitVerdict(open, { ...commit, actual_sha256: "b" }, NOW)).toBe("hash_mismatch");
  });
});

describe("refusal status", () => {
  test("every refusal has its HTTP status", () => {
    expect(
      Object.fromEntries(UPLOAD_REFUSALS.map((code) => [code, uploadRefusalStatus(code)])),
    ).toEqual({
      command_not_found: 404,
      not_an_import: 409,
      command_not_running: 409,
      upload_not_found: 404,
      too_large: 413,
      quota_exhausted: 413,
      upload_closed: 409,
      upload_expired: 410,
      chunk_out_of_range: 422,
      chunk_too_large: 413,
      chunk_conflict: 409,
      size_mismatch: 422,
      chunks_missing: 422,
      hash_mismatch: 422,
    });
  });
});
